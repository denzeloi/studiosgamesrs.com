'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const hetzner = require('./lib/hetzner');
const rcon = require('./lib/rcon');
const { tcpProbe, probePortOpen } = require('./lib/net-probe');
const rtdb = require('./lib/firebase-rtdb');
const bracket = require('./lib/bracket');
const webhook = require('./lib/webhook');

if (!admin.apps.length) {
  admin.initializeApp();
}

const COMMANDER_RANKS = new Set(['commander', 'boss_of_the_state', 'divisional_commander']);

function toHttpsError(err, fallbackCode) {
  if (err instanceof HttpsError) throw err;
  const message = err && err.message ? String(err.message) : 'Unexpected server error';
  console.error('[cs2]', message, err && err.stack ? err.stack : '');
  throw new HttpsError(fallbackCode || 'failed-precondition', message);
}

async function assertCommanderUid(uid) {
  const snap = await admin.database().ref(`users/${uid}/rango`).once('value');
  const rango = String(snap.val() || '').toLowerCase();
  if (!COMMANDER_RANKS.has(rango)) {
    throw new HttpsError('permission-denied', 'Commander rank required');
  }
  return uid;
}

async function assertCommander(context) {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'Login required');
  }
  return assertCommanderUid(context.auth.uid);
}

async function verifyBearerToken(req) {
  const header = req.get('authorization') || req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new HttpsError('unauthenticated', 'Missing login token. Please refresh the page and sign in again.');
  }
  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch (err) {
    throw new HttpsError('unauthenticated', 'Invalid or expired login token. Please sign in again.');
  }
}

function applyCors(req, res) {
  const origin = req.get('Origin') || req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

function sendApiError(res, err) {
  const code = err instanceof HttpsError ? err.code : 'failed-precondition';
  const message = err && err.message ? String(err.message) : 'Request failed';
  const statusMap = {
    unauthenticated: 401,
    'permission-denied': 403,
    'invalid-argument': 400,
    'failed-precondition': 400,
    'not-found': 404,
  };
  if (!res.headersSent) {
    res.status(statusMap[code] || 400).json({ ok: false, error: message, code });
  }
}

async function isProvisionActive(serverId, tournamentId) {
  if (!(await rtdb.gameServerExists(String(serverId)))) return false;
  const snap = await admin.database().ref(`tournaments/${tournamentId}/activeServerId`).once('value');
  const val = snap.val();
  if (val == null || val === '') return false;
  return String(val) === String(serverId);
}

function snapshotBootGraceMs(gs) {
  const snapshotMode = (gs && gs.provisionMode === 'snapshot') || hetzner.usesSnapshot();
  return snapshotMode ? 4 * 60 * 1000 : 25 * 60 * 1000;
}

function serverAgeMs(gs) {
  return Date.now() - Number((gs && gs.createdAt) || 0);
}

function isBootGraceEligible(gs) {
  if (!gs || !gs.ip) return false;
  return serverAgeMs(gs) >= snapshotBootGraceMs(gs);
}

async function assessLaunchReadiness(ip, port, gs) {
  const ping = await rcon.ping(ip, port, process.env.RCON_PASSWORD, 5000);
  let rconOk = ping.ok;
  let portOpen = ping.ok || await probePortOpen(ip, port, 3);
  const bootGrace = isBootGraceEligible(gs);
  const markedReady = gs.status === 'online' || gs.portReady === true;

  if (!rconOk && portOpen) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((r) => setTimeout(r, 8000));
      const retry = await rcon.ping(ip, port, process.env.RCON_PASSWORD, 6000);
      if (retry.ok) {
        rconOk = true;
        break;
      }
    }
  }

  const canLaunch = rconOk || portOpen || bootGrace || markedReady;
  return { canLaunch, rconOk, portOpen, bootGrace, markedReady, pingError: ping.error || null };
}

async function pollRconUntilReady(serverId, tournamentId, ip) {
  const password = process.env.RCON_PASSWORD;
  const snapshot = hetzner.usesSnapshot();
  const maxAttempts = snapshot ? 54 : 90;
  let consecutivePortOpen = 0;
  let metamodGraceDone = false;

  for (let i = 0; i < maxAttempts; i += 1) {
    if (!(await isProvisionActive(serverId, tournamentId))) return;

    const portOpen = await tcpProbe(ip, 27015, 3000);
    if (portOpen) {
      consecutivePortOpen += 1;

      if (consecutivePortOpen >= 2 && !metamodGraceDone) {
        await new Promise((r) => setTimeout(r, 90000));
        metamodGraceDone = true;
      }

      const ping = await rcon.ping(ip, 27015, password, snapshot ? 4000 : 5000);
      if (ping.ok) {
        if (!(await isProvisionActive(serverId, tournamentId))) return;
        await rtdb.writeGameServer(String(serverId), {
          status: 'online',
          rconReady: true,
          portReady: true,
        });
        return;
      }

      if (snapshot && consecutivePortOpen >= 12) {
        if (!(await isProvisionActive(serverId, tournamentId))) return;
        await rtdb.writeGameServer(String(serverId), {
          status: 'online',
          rconReady: false,
          portReady: true,
        });
        return;
      }
    } else {
      consecutivePortOpen = 0;
    }

    await new Promise((r) => setTimeout(r, 10000));
  }

  if (await isProvisionActive(serverId, tournamentId)) {
    await rtdb.writeGameServer(String(serverId), { status: 'rcon_timeout' });
  }
}

async function finishProvision(serverId, tournamentId, matchId) {
  try {
    if (!(await isProvisionActive(serverId, tournamentId))) return;

    const { ip } = await hetzner.waitForServerIp(serverId);
    if (!(await isProvisionActive(serverId, tournamentId))) return;

    await rtdb.writeGameServer(String(serverId), {
      status: 'booting',
      ip,
      port: 27015,
      tournamentId,
      matchId,
      hetznerId: serverId,
      provisionMode: hetzner.usesSnapshot() ? 'snapshot' : 'full',
    });
    await rtdb.writeTournament(tournamentId, {
      activeServerId: String(serverId),
      serverIp: ip,
      serverPort: port,
    });

    // Do not await — polling can take 5–9 min and causes 504 Gateway Timeout on provision.
    pollRconUntilReady(serverId, tournamentId, ip).catch(function (err) {
      console.error('[pollRconUntilReady]', err);
    });
  } catch (err) {
    console.error('[finishProvision]', err);
    if (await isProvisionActive(serverId, tournamentId)) {
      await rtdb.writeGameServer(String(serverId), { status: 'error', error: err.message });
    }
  }
}

async function checkServerCore({ serverId, tournamentId }) {
  if (!serverId) throw new HttpsError('invalid-argument', 'serverId required');

  try {
    const gsSnap = await admin.database().ref(`gameServers/${serverId}`).once('value');
    if (!gsSnap.exists()) {
      throw new HttpsError('not-found', 'Server not found. It may have been shut down.');
    }

    const gs = gsSnap.val() || {};
    if (tournamentId && gs.tournamentId && gs.tournamentId !== tournamentId) {
      throw new HttpsError('permission-denied', 'Server belongs to another tournament.');
    }

    if (!gs.ip) {
      return {
        ok: true,
        serverId: String(serverId),
        status: gs.status || 'provisioning',
        rconOk: false,
      };
    }

    const ip = String(gs.ip || '').trim();
    const port = gs.port || 27015;
    const ping = await rcon.ping(ip, port, process.env.RCON_PASSWORD, 5000);
    const portOpen = ping.ok ? true : await probePortOpen(ip, port, 3);
    let status = gs.status || 'booting';
    const snapshotMode = gs.provisionMode === 'snapshot' || hetzner.usesSnapshot();
    const ageMs = Date.now() - Number(gs.createdAt || 0);
    const bootGraceMs = snapshotMode ? 4 * 60 * 1000 : 25 * 60 * 1000;

    async function markOnline(rconReady, reason) {
      status = 'online';
      await rtdb.writeGameServer(String(serverId), {
        status: 'online',
        rconReady: !!rconReady,
        portReady: true,
        readyReason: reason || null,
      });
    }

    if (ping.ok) {
      await markOnline(true, 'rcon');
    } else if (portOpen) {
      await markOnline(false, 'port');
      console.log('[checkServer]', serverId, ip, 'port open');
    } else if (ageMs >= bootGraceMs) {
      await markOnline(false, 'boot_grace');
      console.log('[checkServer]', serverId, ip, 'boot grace elapsed', ageMs, 'ms');
    } else {
      const timeoutMs = snapshotMode ? 12 * 60 * 1000 : 45 * 60 * 1000;
      if (ageMs > timeoutMs && status !== 'online') {
        status = 'rcon_timeout';
        await rtdb.writeGameServer(String(serverId), { status: 'rcon_timeout' });
      }
    }

    const isReady = status === 'online';
    return {
      ok: true,
      serverId: String(serverId),
      ip,
      port,
      status,
      rconOk: ping.ok,
      portReady: isReady || portOpen || ping.ok,
      readyByAge: isReady && !ping.ok && !portOpen,
      bootAgeMs: ageMs,
      rconError: ping.ok ? null : ping.error,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('[checkServerCore]', err);
    throw new HttpsError('failed-precondition', err.message || 'Server check failed');
  }
}

async function resumeProvisionCore({ serverId, tournamentId }) {
  if (!serverId || !tournamentId) {
    throw new HttpsError('invalid-argument', 'serverId and tournamentId required');
  }
  if (!(await rtdb.gameServerExists(String(serverId)))) {
    throw new HttpsError('not-found', 'Game server record not found. Provision a new server.');
  }
  const gsSnap = await admin.database().ref(`gameServers/${serverId}`).once('value');
  const gs = gsSnap.val() || {};
  if (gs.ip) {
    return { ok: true, serverId, ip: gs.ip, status: gs.status || 'booting', resumed: false };
  }
  await rtdb.writeTournament(tournamentId, { activeServerId: String(serverId) });
  await finishProvision(serverId, tournamentId, gs.matchId || 'r1_m1');
  const updated = (await admin.database().ref(`gameServers/${serverId}`).once('value')).val();
  if (updated && updated.error) {
    throw new HttpsError('failed-precondition', updated.error);
  }
  return {
    ok: true,
    serverId,
    ip: updated && updated.ip,
    status: (updated && updated.status) || 'provisioning',
    resumed: true,
  };
}

async function provisionServerCore({ tournamentId, matchId, gsltIndex = 0 }) {
  if (!tournamentId || !matchId) {
    throw new HttpsError('invalid-argument', 'tournamentId and matchId required');
  }

  const name = hetzner.sanitizeServerName(
    `cs2-${String(tournamentId).slice(0, 8)}-${matchId}`
  );
  const server = await hetzner.createServer({
    name,
    labels: { tournamentId, matchId, gslt: String(gsltIndex) },
  });

  await rtdb.writeGameServer(String(server.id), {
    status: 'provisioning',
    tournamentId,
    matchId,
    provider: 'hetzner',
    hetznerId: server.id,
    provisionMode: server.provisionMode || (hetzner.usesSnapshot() ? 'snapshot' : 'full'),
    createdAt: Date.now(),
  });
  await rtdb.writeTournament(tournamentId, {
    activeServerId: String(server.id),
  });

  await finishProvision(server.id, tournamentId, matchId);

  const gsSnap = await admin.database().ref(`gameServers/${server.id}`).once('value');
  const gs = gsSnap.val() || {};

  return {
    ok: true,
    serverId: server.id,
    name: server.name,
    status: gs.status || 'provisioning',
    ip: gs.ip || null,
    error: gs.error || null,
    rconReady: gs.rconReady === true,
    portReady: gs.portReady === true,
    provisionMode: server.provisionMode || (hetzner.usesSnapshot() ? 'snapshot' : 'full'),
  };
}

async function launchMatchCore({ tournamentId, matchId, map = 'de_mirage', serverId, teamIds }) {
  if (!tournamentId || !matchId) {
    throw new HttpsError('invalid-argument', 'tournamentId and matchId required');
  }

  const tournament = await rtdb.getTournament(tournamentId);
  let ip = tournament?.serverIp;
  const hetznerId = serverId || tournament?.activeServerId;

  if (!hetznerId || !(await rtdb.gameServerExists(String(hetznerId)))) {
    if (tournamentId) await rtdb.clearTournamentServerFields(tournamentId);
    throw new HttpsError(
      'failed-precondition',
      'No active game server. The server was shut down — click Provision Server to create a new one.'
    );
  }

  if (hetznerId && !ip) {
    try {
      const server = await hetzner.getServer(hetznerId);
      ip = server.public_net?.ipv4?.ip;
    } catch (err) {
      throw new HttpsError('failed-precondition', 'Could not reach Hetzner server. It may have been deleted.');
    }
  }

  if (!ip) {
    throw new HttpsError('failed-precondition', 'No server IP. Provision a server first.');
  }

  const gsSnap = await admin.database().ref(`gameServers/${hetznerId}`).once('value');
  const gs = gsSnap.val() || {};
  const port = Number(gs.port) || 27015;
  if (!ip && gs.ip) ip = String(gs.ip).trim();

  const readiness = await assessLaunchReadiness(ip, port, gs);
  if (!readiness.canLaunch) {
    const snapshotMode = gs.provisionMode === 'snapshot' || hetzner.usesSnapshot();
    const waitHint = snapshotMode
      ? 'CS2 is still starting (usually 5–8 min with snapshot). Wait for status Online, then Launch.'
      : 'CS2 may still be installing (first boot usually 15–45 min). Use Check Readiness, then try Launch again.';
    throw new HttpsError(
      'failed-precondition',
      'Game server is not reachable yet. ' + waitHint
    );
  }

  if (teamIds && teamIds.length >= 2) {
    const bracketData = bracket.buildSingleElimBracket(teamIds);
    await rtdb.writeTournament(tournamentId, {
      bracket: bracketData,
      currentMatchId: bracketData.currentMatchId,
      status: 'en_vivo',
    });
  }

  let rconOk = readiness.rconOk;
  let rconError = readiness.pingError;
  try {
    await rcon.withTimeout(
      rcon.startMatch(ip, port, process.env.RCON_PASSWORD, { map, tournamentId, matchId }),
      25000,
      'RCON commands timed out. Match data was saved — connect manually and changelevel.'
    );
    rconOk = true;
    rconError = null;
  } catch (err) {
    rconOk = false;
    rconError = err.message;
  }

  await rtdb.writeTournament(tournamentId, {
    status: 'en_vivo',
    activeMatchId: matchId,
    activeMap: map,
  });

  await rtdb.writeMatchLive(matchId, {
    status: rconOk ? 'live' : 'starting',
    tournamentId,
    map,
    serverIp: ip,
    serverPort: port,
    startedAt: Date.now(),
    rconOk,
    rconError,
  });

  return {
    ok: true,
    serverIp: ip,
    port,
    matchId,
    map,
    rconOk,
    rconError,
    manualConnect: !rconOk,
    bootGrace: readiness.bootGrace && !readiness.portOpen && !readiness.rconOk,
  };
}

async function shutdownServerCore({ serverId, tournamentId }) {
  if (!serverId) throw new HttpsError('invalid-argument', 'serverId required');

  if (tournamentId) {
    await rtdb.clearTournamentServerFields(tournamentId);
  }
  await rtdb.removeGameServer(String(serverId));

  try {
    await hetzner.deleteServer(serverId);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (!/not found|404/i.test(msg)) {
      throw new HttpsError('failed-precondition', 'Could not delete Hetzner server: ' + msg);
    }
  }

  return { ok: true, deleted: serverId, cleared: !!tournamentId };
}

exports.cs2NexusApi = onRequest(
  { timeoutSeconds: 300, memory: '512MiB', invoker: 'public' },
  async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const op = String(req.query.op || req.body?.op || '').toLowerCase();

    try {
      const decoded = await verifyBearerToken(req);
      await assertCommanderUid(decoded.uid);

      let result;
      switch (op) {
        case 'provision':
          result = await provisionServerCore(req.body || {});
          break;
        case 'launch':
          result = await launchMatchCore(req.body || {});
          break;
        case 'shutdown':
          result = await shutdownServerCore(req.body || {});
          break;
        case 'resume':
          result = await resumeProvisionCore(req.body || {});
          break;
        case 'check':
          result = await checkServerCore(req.body || {});
          break;
        default:
          throw new HttpsError('invalid-argument', 'Unknown op. Use provision, launch, shutdown, resume, or check.');
      }

      res.status(200).json({ ok: true, result });
    } catch (err) {
      console.error('[cs2NexusApi]', op, err && err.message ? err.message : err);
      sendApiError(res, err);
    }
  }
);

exports.cs2ProvisionServer = onCall(
  { timeoutSeconds: 300, memory: '512MiB', invoker: 'public', cors: true },
  async (request) => {
    try {
      await assertCommander(request);
      return await provisionServerCore(request.data || {});
    } catch (err) {
      toHttpsError(err);
    }
  }
);

exports.cs2LaunchMatch = onCall(
  { timeoutSeconds: 120, memory: '512MiB', invoker: 'public', cors: true },
  async (request) => {
    try {
      await assertCommander(request);
      return await launchMatchCore(request.data || {});
    } catch (err) {
      toHttpsError(err);
    }
  }
);

exports.cs2ShutdownServer = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public', cors: true },
  async (request) => {
    try {
      await assertCommander(request);
      return await shutdownServerCore(request.data || {});
    } catch (err) {
      toHttpsError(err);
    }
  }
);

exports.cs2BuildBracket = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', cors: true },
  async (request) => {
    try {
      await assertCommander(request);
      const { tournamentId, teamIds } = request.data || {};
      if (!tournamentId || !Array.isArray(teamIds) || teamIds.length < 2) {
        throw new HttpsError('invalid-argument', 'tournamentId and teamIds (2+) required');
      }
      const bracketData = bracket.buildSingleElimBracket(teamIds);
      await rtdb.writeTournament(tournamentId, {
        bracket: bracketData,
        currentMatchId: bracketData.currentMatchId,
      });
      return { ok: true, bracket: bracketData };
    } catch (err) {
      toHttpsError(err);
    }
  }
);

exports.cs2MatchWebhook = onRequest(
  { timeoutSeconds: 30, memory: '256MiB', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const result = await webhook.processMatchEvent(req.body);
      res.json(result);
    } catch (err) {
      console.error('[cs2MatchWebhook]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

exports.cs2ListServers = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', cors: true },
  async (request) => {
    try {
      await assertCommander(request);
      const servers = await hetzner.listProjectServers();
      return { servers };
    } catch (err) {
      toHttpsError(err);
    }
  }
);
