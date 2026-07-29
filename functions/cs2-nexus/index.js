'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const provider = require('./lib/provider');
const rcon = require('./lib/rcon');
const { tcpProbe, probePortOpen, probeGamePortOpen, udpGameProbe } = require('./lib/net-probe');
const rtdb = require('./lib/firebase-rtdb');
const bracket = require('./lib/bracket');
const webhook = require('./lib/webhook');
const matchzy = require('./lib/matchzy');

if (!admin.apps.length) {
  admin.initializeApp();
}

const COMMANDER_RANKS = new Set(['commander', 'boss_of_the_state', 'divisional_commander']);
const CS2_GAME_PORT = 27015;

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
  const snapshotMode = (gs && gs.provisionMode === 'snapshot') || provider.usesSnapshot();
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
  let gameUdpOk = await probeGamePortOpen(ip, port, 2);
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

  if (!gameUdpOk && (rconOk || portOpen)) {
    gameUdpOk = await probeGamePortOpen(ip, port, 3);
  }

  const canLaunch = rconOk || portOpen;
  return {
    canLaunch,
    rconOk,
    portOpen,
    gameUdpOk,
    bootGrace,
    markedReady,
    pingError: ping.error || null,
    playerConnectOk: gameUdpOk,
  };
}

async function pollRconUntilReady(serverId, tournamentId, ip) {
  const password = process.env.RCON_PASSWORD;
  const snapshot = provider.usesSnapshot();
  const maxAttempts = snapshot ? 54 : 90;
  let consecutivePortOpen = 0;
  let metamodGraceDone = false;

  for (let i = 0; i < maxAttempts; i += 1) {
    if (!(await isProvisionActive(serverId, tournamentId))) return;

    const portOpen = await tcpProbe(ip, CS2_GAME_PORT, 3000);
    if (portOpen) {
      consecutivePortOpen += 1;

      if (consecutivePortOpen >= 2 && !metamodGraceDone) {
        await new Promise((r) => setTimeout(r, 90000));
        metamodGraceDone = true;
      }

      const ping = await rcon.ping(ip, CS2_GAME_PORT, password, snapshot ? 4000 : 5000);
      const gameUdpOk = await udpGameProbe(ip, CS2_GAME_PORT, 4000);
      if (ping.ok) {
        if (!(await isProvisionActive(serverId, tournamentId))) return;
        await rtdb.writeGameServer(String(serverId), {
          status: 'online',
          rconReady: true,
          portReady: true,
          gameUdpOk: !!gameUdpOk,
        });
        return;
      }

      if (snapshot && consecutivePortOpen >= 12) {
        if (!(await isProvisionActive(serverId, tournamentId))) return;
        await rtdb.writeGameServer(String(serverId), {
          status: gameUdpOk ? 'online' : 'udp_blocked',
          rconReady: false,
          portReady: true,
          gameUdpOk: !!gameUdpOk,
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

    const { ip } = await provider.waitForServerIp(serverId);
    if (!(await isProvisionActive(serverId, tournamentId))) return;

    await rtdb.writeGameServer(String(serverId), {
      status: 'booting',
      ip,
      port: CS2_GAME_PORT,
      error: null,
      tournamentId,
      matchId,
      cloudServerId: serverId,
      hetznerId: serverId, // legacy RTDB field name
      provisionMode: provider.usesSnapshot() ? 'snapshot' : 'full',
    });
    await rtdb.writeTournament(tournamentId, {
      activeServerId: String(serverId),
      serverIp: ip,
      serverPort: CS2_GAME_PORT,
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

async function checkServerCore({ serverId, tournamentId, quick }) {
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

    const ageMs = Date.now() - Number(gs.createdAt || 0);
    const snapshotMode = gs.provisionMode === 'snapshot' || provider.usesSnapshot();
    const bootGraceMs = snapshotMode ? 4 * 60 * 1000 : 25 * 60 * 1000;

    if (!gs.ip) {
      return {
        ok: true,
        serverId: String(serverId),
        status: gs.status || 'provisioning',
        rconOk: false,
        portReady: false,
        bootAgeMs: ageMs,
      };
    }

    const ip = String(gs.ip || '').trim();
    const port = gs.port || 27015;

    // UI polling while CS2 installs — return RTDB state only (must finish in <12s).
    if (quick) {
      return {
        ok: true,
        serverId: String(serverId),
        ip,
        port,
        status: gs.status || 'booting',
        rconOk: gs.rconReady === true,
        portReady: gs.portReady === true || gs.status === 'online' || gs.status === 'udp_blocked',
        gameUdpOk: gs.gameUdpOk,
        playerConnectOk: gs.gameUdpOk,
        bootAgeMs: ageMs,
      };
    }

    const pwd = process.env.RCON_PASSWORD;
    const [ping, portOpen, gameUdpOk] = await Promise.all([
      rcon.ping(ip, port, pwd, 4000),
      tcpProbe(ip, port, 3000),
      udpGameProbe(ip, port, 3500),
    ]);
    let status = gs.status || 'booting';

    async function markOnline(rconReady, reason) {
      status = gameUdpOk ? 'online' : 'udp_blocked';
      await rtdb.writeGameServer(String(serverId), {
        status,
        rconReady: !!rconReady,
        portReady: true,
        gameUdpOk: !!gameUdpOk,
        readyReason: reason || null,
      });
    }

    if (ping.ok) {
      await markOnline(true, 'rcon');
    } else if (portOpen) {
      await markOnline(false, 'port');
      console.log('[checkServer]', serverId, ip, 'port open udp=', gameUdpOk);
    } else if (ageMs >= bootGraceMs) {
      await markOnline(false, 'boot_grace');
      console.log('[checkServer]', serverId, ip, 'boot grace elapsed', ageMs, 'ms udp=', gameUdpOk);
    } else {
      const timeoutMs = snapshotMode ? 12 * 60 * 1000 : 45 * 60 * 1000;
      if (ageMs > timeoutMs && status !== 'online') {
        status = 'rcon_timeout';
        await rtdb.writeGameServer(String(serverId), { status: 'rcon_timeout' });
      }
    }

    const isReady = status === 'online' || status === 'udp_blocked';
    const stillInstalling = ageMs < bootGraceMs && !ping.ok && !portOpen;
    let connectHint = null;
    if (!gameUdpOk && !stillInstalling) {
      connectHint =
        'CS2 game port (UDP 27015) is not reachable from the internet. ' +
        'If CS2 is running on the server, run: bash /usr/local/bin/open-cs2-ports.sh as root, ' +
        'or Shutdown → Provision again (firewall opens automatically on new servers).';
    }

    return {
      ok: true,
      serverId: String(serverId),
      ip,
      port,
      status: stillInstalling ? (gs.status || 'booting') : status,
      rconOk: ping.ok,
      portReady: isReady || portOpen || ping.ok,
      gameUdpOk,
      playerConnectOk: gameUdpOk,
      readyByAge: isReady && !ping.ok && !portOpen,
      bootAgeMs: ageMs,
      stillInstalling,
      rconError: ping.ok ? null : ping.error,
      connectHint,
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

async function provisionServerCore({ tournamentId, matchId, gsltIndex = 0, location }) {
  if (!tournamentId || !matchId) {
    throw new HttpsError('invalid-argument', 'tournamentId and matchId required');
  }

  const gsltKey = gsltIndex === 1 ? 'GSLT_SERVER_2' : 'GSLT_SERVER_1';
  const gslt = process.env[gsltKey] || process.env.GSLT_SERVER_1 || '';
  if (!String(gslt).trim()) {
    throw new HttpsError(
      'failed-precondition',
      gsltKey + ' is not set in functions/.env. Create a CS2 token at steamcommunity.com/dev/managegameservers (App ID 730), redeploy functions, then provision again.'
    );
  }

  try {
    provider.assertConfigured();
  } catch (err) {
    throw new HttpsError('failed-precondition', err.message);
  }

  const name = provider.sanitizeServerName(
    `cs2-${String(tournamentId).slice(0, 8)}-${matchId}`
  );
  const cloudProvider = provider.activeProviderName();
  const server = await provider.createServer({
    name,
    labels: { tournamentId, matchId, gslt: String(gsltIndex) },
    location: location || undefined,
  });

  await rtdb.writeGameServer(String(server.id), {
    status: 'provisioning',
    tournamentId,
    matchId,
    provider: cloudProvider,
    region: server.region || location || null,
    cloudServerId: server.id,
    hetznerId: server.id, // legacy RTDB field name
    provisionMode: server.provisionMode || (provider.usesSnapshot() ? 'snapshot' : 'full'),
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
    provider: cloudProvider,
    region: server.region || null,
    provisionMode: server.provisionMode || (provider.usesSnapshot() ? 'snapshot' : 'full'),
  };
}

async function launchMatchCore({ tournamentId, matchId, map = 'de_mirage', serverId, teamIds }) {
  if (!tournamentId || !matchId) {
    throw new HttpsError('invalid-argument', 'tournamentId and matchId required');
  }

  const tournament = await rtdb.getTournament(tournamentId);
  let ip = tournament?.serverIp;
  const cloudServerId = serverId || tournament?.activeServerId;

  if (!cloudServerId || !(await rtdb.gameServerExists(String(cloudServerId)))) {
    if (tournamentId) await rtdb.clearTournamentServerFields(tournamentId);
    throw new HttpsError(
      'failed-precondition',
      'No active game server. The server was shut down — click Provision Server to create a new one.'
    );
  }

  const gsSnapEarly = await admin.database().ref(`gameServers/${cloudServerId}`).once('value');
  const gsEarly = gsSnapEarly.val() || {};
  const gsProviderHint = gsEarly.provider || provider.activeProviderName();

  if (cloudServerId && !ip) {
    try {
      const server = await provider.getServer(cloudServerId, gsProviderHint);
      ip = server.public_net?.ipv4?.ip;
    } catch (err) {
      throw new HttpsError('failed-precondition', 'Could not reach cloud server. It may have been deleted.');
    }
  }

  try {
    const cloud = await provider.getServer(cloudServerId, gsProviderHint);
    const cloudStatus = String(cloud.status || '').toLowerCase();
    if (cloudStatus && cloudStatus !== 'running' && cloudStatus !== 'active') {
      throw new HttpsError(
        'failed-precondition',
        'Cloud server is not running (status: ' + cloudStatus + '). Wait for provision to finish or provision again.'
      );
    }
    if (cloud.public_net?.ipv4?.ip) {
      ip = cloud.public_net.ipv4.ip;
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('failed-precondition', 'Could not verify cloud server status.');
  }

  if (!ip) {
    throw new HttpsError('failed-precondition', 'No server IP. Provision a server first.');
  }

  const gsSnap = await admin.database().ref(`gameServers/${cloudServerId}`).once('value');
  const gs = gsSnap.val() || gsEarly;
  const port = Number(gs.port) || 27015;
  if (!ip && gs.ip) ip = String(gs.ip).trim();

  const readiness = await assessLaunchReadiness(ip, port, gs);
  if (!readiness.canLaunch) {
    const snapshotMode = gs.provisionMode === 'snapshot' || provider.usesSnapshot();
    const waitHint = snapshotMode
      ? 'Vultr may still be restoring the snapshot disk (often 20–40 min), then CS2 starts (~5–10 min). Wait for Check Readiness to pass.'
      : 'CS2 may still be installing (first boot usually 30–45 min). Use Check Readiness, then try Launch again.';
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
    });
  }

  const matchBuild = await matchzy.buildMatchConfig({
    tournamentId,
    matchId,
    map,
    teamIds: teamIds || [],
  });
  if (matchBuild.ok && matchBuild.config) {
    await matchzy.storeMatchConfig(tournamentId, matchId, matchBuild.config);
  }

  const matchToken = process.env.WEBHOOK_SECRET || process.env.MATCH_CONFIG_TOKEN || '';
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'studiosgamesrs';
  const matchConfigUrl =
    'https://us-central1-' + projectId + '.cloudfunctions.net/cs2MatchConfig'
    + '?tournamentId=' + encodeURIComponent(tournamentId)
    + '&matchId=' + encodeURIComponent(matchId);

  let rconOk = readiness.rconOk;
  let rconError = readiness.pingError;
  let launchMode = null;
  try {
    const started = await rcon.withTimeout(
      rcon.startMatch(ip, port, process.env.RCON_PASSWORD, {
        map,
        tournamentId,
        matchId,
        matchConfigUrl: matchBuild.ok ? matchConfigUrl : null,
        matchToken,
        hasSteamRosters: !!(matchBuild.ok && matchBuild.hasSteamRosters),
      }),
      25000,
      'RCON commands timed out. Match data was saved — connect manually.'
    );
    rconOk = true;
    rconError = null;
    launchMode = started && started.mode;
  } catch (err) {
    rconOk = false;
    rconError = err.message;
  }

  await rtdb.writeTournament(tournamentId, {
    status: rconOk ? 'en_vivo' : 'pendiente',
    activeMatchId: rconOk ? matchId : null,
    activeMap: rconOk ? map : null,
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
    launchMode,
    matchzy: matchBuild.ok,
    matchzyHint: matchBuild.reason || null,
  });

  return {
    ok: true,
    serverIp: ip,
    port,
    matchId,
    map,
    rconOk,
    rconError,
    launchMode,
    matchzy: matchBuild.ok,
    matchzyHint: matchBuild.reason || null,
    gameUdpOk: readiness.gameUdpOk,
    playerConnectOk: readiness.playerConnectOk,
    manualConnect: !rconOk,
    bootGrace: readiness.bootGrace && !readiness.portOpen && !readiness.rconOk,
    connectWarning: readiness.playerConnectOk
      ? null
      : 'Players cannot connect yet — UDP 27015 is blocked or CS2 is not responding. Try Check Readiness, or shutdown and reprovision the server.',
  };
}

async function shutdownServerCore({ serverId, tournamentId }) {
  if (!serverId) throw new HttpsError('invalid-argument', 'serverId required');

  const gsSnap = await admin.database().ref(`gameServers/${serverId}`).once('value');
  const gs = gsSnap.val() || {};
  const providerHint = gs.provider || provider.activeProviderName();

  if (tournamentId) {
    await rtdb.clearTournamentServerFields(tournamentId);
  }
  await rtdb.removeGameServer(String(serverId));

  try {
    await provider.deleteServer(serverId, providerHint);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (!/not found|404/i.test(msg)) {
      throw new HttpsError('failed-precondition', 'Could not delete cloud server: ' + msg);
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

/**
 * Public GET for MatchZy matchzy_loadmatch_url.
 * Optional header X-Match-Token must match WEBHOOK_SECRET when that secret is set.
 */
exports.cs2MatchConfig = onRequest(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', cors: true },
  async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const expected = process.env.WEBHOOK_SECRET || process.env.MATCH_CONFIG_TOKEN || '';
    if (expected) {
      const headerToken = req.get('X-Match-Token') || req.get('x-match-token') || '';
      const queryToken = req.query.token || '';
      if (headerToken !== expected && queryToken !== expected) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    const tournamentId = String(req.query.tournamentId || '');
    const matchId = String(req.query.matchId || '');
    if (!tournamentId || !matchId) {
      res.status(400).json({ error: 'tournamentId and matchId required' });
      return;
    }

    try {
      let config = await matchzy.getStoredMatchConfig(tournamentId, matchId);
      if (!config) {
        const built = await matchzy.buildMatchConfig({
          tournamentId,
          matchId,
          map: req.query.map || 'de_mirage',
          teamIds: [],
        });
        if (!built.ok || !built.config) {
          res.status(404).json({ error: built.reason || 'Match config not found' });
          return;
        }
        config = built.config;
      }
      res.set('Cache-Control', 'no-store');
      res.status(200).json(config);
    } catch (err) {
      console.error('[cs2MatchConfig]', err);
      res.status(500).json({ error: err.message || 'Failed to load match config' });
    }
  }
);

exports.cs2ListServers = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', cors: true },
  async (request) => {
    try {
      await assertCommander(request);
      const servers = await provider.listProjectServers();
      return { servers };
    } catch (err) {
      toHttpsError(err);
    }
  }
);
