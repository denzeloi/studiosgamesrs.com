'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const provider = require('./lib/provider');
const rcon = require('./lib/rcon');
const { tcpProbe, probePortOpen, probeGamePortOpen, udpGameProbe, udpProbeEnabled } = require('./lib/net-probe');
const rtdb = require('./lib/firebase-rtdb');
const bracket = require('./lib/bracket');
const webhook = require('./lib/webhook');
const matchzy = require('./lib/matchzy');
const concurrency = require('./lib/concurrency');
const lifecycle = require('./lib/lifecycle');
const verification = require('./lib/verification');
const secrets = require('./lib/secrets');

if (!admin.apps.length) {
  admin.initializeApp();
}

const COMMANDER_RANKS = new Set(['commander', 'boss_of_the_state', 'divisional_commander']);
const CS2_GAME_PORT = 27015;

/**
 * Observed provisioning windows: Vultr needs 20-40 min to restore a snapshot disk
 * and CS2 then takes 5-10 min to come up, while a from-scratch install runs 30-45 min.
 *
 * The grace window has to outlast that. It used to be 4 min for snapshots, so a
 * server was declared online by age while it was still restoring — and because
 * 'online' is not a reconciled status, the scheduled pass then stopped watching it
 * and the readiness flags froze on that false answer for good.
 */
const BOOT_GRACE_SNAPSHOT_MS = 45 * 60 * 1000;
const BOOT_GRACE_FULL_MS = 50 * 60 * 1000;
const BOOT_TIMEOUT_SNAPSHOT_MS = 60 * 60 * 1000;
const BOOT_TIMEOUT_FULL_MS = 70 * 60 * 1000;

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
  // Carries the machine-readable part of the failure, so the panel can offer the right
  // next step instead of matching on the message text.
  const details = err instanceof HttpsError && err.details ? err.details : null;
  const statusMap = {
    unauthenticated: 401,
    'permission-denied': 403,
    'invalid-argument': 400,
    'failed-precondition': 400,
    'not-found': 404,
  };
  if (!res.headersSent) {
    res.status(statusMap[code] || 400).json({ ok: false, error: message, code, details });
  }
}

/**
 * ¿Sigue siendo nuestra esta provisión?
 *
 * Antes se comparaba con tournaments/{id}/activeServerId, que es un puntero
 * único: levantar la segunda máquina lo sobrescribía y la primera se quedaba sin
 * vigilancia a mitad del arranque, colgada hasta que la repescara la tarea de
 * reconciliación. La vigilancia va atada al registro de la máquina, que es de
 * ella sola: mientras exista y siga siendo de este torneo, se sigue mirando.
 */
async function isProvisionActive(serverId, tournamentId) {
  const gs = await rtdb.getGameServer(String(serverId));
  if (!gs) return false;
  if (tournamentId && gs.tournamentId && String(gs.tournamentId) !== String(tournamentId)) {
    return false;
  }
  return true;
}

function snapshotBootGraceMs(gs) {
  const snapshotMode = (gs && gs.provisionMode === 'snapshot') || provider.usesSnapshot();
  return snapshotMode ? BOOT_GRACE_SNAPSHOT_MS : BOOT_GRACE_FULL_MS;
}

function serverAgeMs(gs) {
  return Date.now() - Number((gs && gs.createdAt) || 0);
}

function isBootGraceEligible(gs) {
  if (!gs || !gs.ip) return false;
  return serverAgeMs(gs) >= snapshotBootGraceMs(gs);
}

/**
 * The UDP game-port check is advisory: it cannot run from Cloud Run without Direct VPC egress,
 * so a null result means "not verifiable from the backend", never "the server is down".
 * Writing null to RTDB removes the key, and an absent key reads back as unknown on the client.
 */
function udpFlag(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/**
 * Store what the server reported about its own branding. Until now the only way to know
 * whether the Studiosgamesrs name reached the game chat was to join a match and read it,
 * so a provisioning step that silently dropped the config looked identical to one that
 * worked. This leaves the answer in gameServers/{id}/branding.
 */
function brandingRecord(report) {
  const record = {
    ok: !!(report && report.ok),
    checkedAt: Date.now(),
  };
  if (report && report.error) record.error = String(report.error).slice(0, 200);
  if (report && report.values) record.values = report.values;
  return record;
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

  if (gameUdpOk === false && (rconOk || portOpen)) {
    gameUdpOk = await probeGamePortOpen(ip, port, 3);
  }

  const canLaunch = rconOk || portOpen;
  return {
    canLaunch,
    rconOk,
    portOpen,
    gameUdpOk: udpFlag(gameUdpOk),
    bootGrace,
    markedReady,
    pingError: ping.error || null,
    playerConnectOk: udpFlag(gameUdpOk),
  };
}

async function pollRconUntilReady(serverId, tournamentId, ip, matchId) {
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
        // Brand the server the moment it answers, not only when a match is launched:
        // players connect to the warmup lobby first and MatchZy talks to them there.
        const branding = await rcon.brandServer(ip, CS2_GAME_PORT, password);
        // Mismo motivo que la marca: el puente tiene que saber a qué cruce
        // pertenece ya, o la sala no verá a nadie hasta que se lance la partida.
        const context = await rcon.setMatchContext(
          ip, CS2_GAME_PORT, password, tournamentId, matchId
        );
        await rtdb.writeGameServer(String(serverId), {
          status: 'online',
          rconReady: true,
          portReady: true,
          gameUdpOk: udpFlag(gameUdpOk),
          readyReason: 'rcon',
          readyVerified: true,
          branding: brandingRecord(branding),
          bridgeContext: context && context.ok === true,
          bridgeContextAt: Date.now(),
        });
        return;
      }

      if (snapshot && consecutivePortOpen >= 12) {
        if (!(await isProvisionActive(serverId, tournamentId))) return;
        await rtdb.writeGameServer(String(serverId), {
          status: 'online',
          rconReady: false,
          portReady: true,
          gameUdpOk: udpFlag(gameUdpOk),
          readyReason: 'port',
          readyVerified: true,
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
    // El cruce siempre se entera; los punteros de nivel torneo solo si no hay
    // otra máquina jugando, que si no la segunda provisión le roba la IP.
    await rtdb.writeTournamentLiveMatch(tournamentId, matchId, {
      serverId: String(serverId),
      serverIp: ip,
      serverPort: CS2_GAME_PORT,
    });
    if (concurrency.canClaimPrimary(await rtdb.getTournament(tournamentId), serverId)) {
      await rtdb.writeTournament(tournamentId, {
        activeServerId: String(serverId),
        serverIp: ip,
        serverPort: CS2_GAME_PORT,
      });
    }

    // Do not await — polling can take 5–9 min and causes 504 Gateway Timeout on provision.
    pollRconUntilReady(serverId, tournamentId, ip, matchId).catch(function (err) {
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
    const bootGraceMs = snapshotMode ? BOOT_GRACE_SNAPSHOT_MS : BOOT_GRACE_FULL_MS;

    if (!gs.ip) {
      return {
        ok: true,
        serverId: String(serverId),
        status: gs.status || 'provisioning',
        rconOk: false,
        portReady: false,
        readyVerified: false,
        provisionMode: snapshotMode ? 'snapshot' : 'full',
        bootGraceMs,
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
        readyVerified: gs.readyVerified === true,
        readyReason: gs.readyReason || null,
        provisionMode: snapshotMode ? 'snapshot' : 'full',
        bootGraceMs,
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

    // RCON or an open TCP 27015 is the source of truth for "the server is up".
    // The UDP result is attached as advisory data and never downgrades the status.
    async function markOnline(rconReady, reason) {
      status = 'online';
      await rtdb.writeGameServer(String(serverId), {
        status,
        rconReady: !!rconReady,
        portReady: true,
        gameUdpOk: udpFlag(gameUdpOk),
        readyReason: reason || null,
        // 'boot_grace' means nothing answered and we stopped waiting, so the panel
        // must not present it as a confirmed, connectable server.
        readyVerified: reason === 'rcon' || reason === 'port',
      });
      // Los jugadores no leen gameServers: si el puerto de juego quedó cerrado,
      // el aviso solo les llega por el cruce.
      if (udpFlag(gameUdpOk) !== null && gs.tournamentId && gs.matchId) {
        await rtdb.writeTournamentLiveMatch(gs.tournamentId, gs.matchId, {
          gameUdpOk: udpFlag(gameUdpOk),
        });
      }
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
      const timeoutMs = snapshotMode ? BOOT_TIMEOUT_SNAPSHOT_MS : BOOT_TIMEOUT_FULL_MS;
      if (ageMs > timeoutMs && status !== 'online') {
        status = 'rcon_timeout';
        await rtdb.writeGameServer(String(serverId), { status: 'rcon_timeout' });
      }
    }

    const isReady = status === 'online' || status === 'udp_blocked';
    const stillInstalling = ageMs < bootGraceMs && !ping.ok && !portOpen;
    let connectHint = null;
    if (gameUdpOk === false && !stillInstalling) {
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
      readyVerified: ping.ok || portOpen,
      provisionMode: snapshotMode ? 'snapshot' : 'full',
      bootGraceMs,
      gameUdpOk: udpFlag(gameUdpOk),
      udpVerifiable: udpProbeEnabled(),
      playerConnectOk: udpFlag(gameUdpOk),
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

// Statuses that still need to converge to a final answer. Legacy records may sit on
// 'udp_blocked', which no longer exists as an outcome but must still be healed.
const RECONCILE_STATUSES = new Set(['provisioning', 'booting', 'rcon_timeout', 'udp_blocked']);
const RECONCILE_MAX_AGE_MS = 120 * 60 * 1000;
const RECONCILE_MAX_SERVERS = 6;

/**
 * A server marked online by age alone has never actually answered anything, so it has
 * not converged yet and must stay in the pass. Otherwise it leaves the reconciled set
 * the moment it is guessed to be up and its readiness flags freeze on that guess —
 * which is what happens to every record written before readyVerified existed.
 */
function needsReconcile(gs) {
  const status = String(gs.status || '');
  if (RECONCILE_STATUSES.has(status)) return true;
  if (status !== 'online') return false;
  if (gs.readyVerified === true || gs.rconReady === true) return false;
  return true;
}

async function reconcileServer(serverId, gs) {
  let ip = String(gs.ip || '').trim();

  // provisionServerCore can be killed before the IP reaches RTDB; recover it from the provider.
  if (!ip) {
    const server = await provider.getServer(serverId, gs.provider);
    ip = String((server && server.public_net && server.public_net.ipv4 && server.public_net.ipv4.ip) || '').trim();
    if (!ip) return { serverId: String(serverId), status: gs.status || 'provisioning', note: 'no_ip_yet' };
    await rtdb.writeGameServer(String(serverId), {
      status: 'booting',
      ip,
      port: CS2_GAME_PORT,
      error: null,
    });
    if (gs.tournamentId) {
      await rtdb.writeTournament(gs.tournamentId, { serverIp: ip, serverPort: CS2_GAME_PORT });
    }
  }

  const result = await checkServerCore({ serverId: String(serverId) });
  return {
    serverId: String(serverId),
    status: result.status,
    rconOk: result.rconOk,
    portReady: result.portReady,
  };
}

/**
 * pollRconUntilReady is fired without await so provision can answer before the 504 window,
 * but Cloud Run freezes CPU as soon as the response is sent, so that loop rarely survives the
 * 5-9 minutes it needs. This scheduled pass owns the readiness flags instead: it runs with a
 * full CPU allocation and keeps probing until every server reaches a final status.
 */
async function reconcileServersCore() {
  const snap = await admin.database().ref('gameServers').once('value');
  const all = snap.val() || {};

  const pending = Object.keys(all)
    .map((id) => ({ id, gs: all[id] || {} }))
    .filter(({ gs }) => needsReconcile(gs))
    .filter(({ gs }) => serverAgeMs(gs) < RECONCILE_MAX_AGE_MS)
    .sort((a, b) => serverAgeMs(b.gs) - serverAgeMs(a.gs))
    .slice(0, RECONCILE_MAX_SERVERS);

  const results = [];
  for (let i = 0; i < pending.length; i += 1) {
    const { id, gs } = pending[i];
    try {
      results.push(await reconcileServer(id, gs));
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error('[reconcileServers]', id, message);
      results.push({ serverId: String(id), error: message });
    }
  }

  return { checked: results.length, results };
}

/**
 * Decirle a cada máquina encendida a qué cruce pertenece.
 *
 * El puente descarta todo lo que pasa dentro mientras no tenga torneo y cruce,
 * así que sin esto no hay sala, ni tabla, ni feed: el servidor está lleno de
 * gente y partida_en_vivo sigue en null. Se hacía al provisionar, dentro de la
 * misma tarea suelta que ya no sobrevive al corte de CPU de Cloud Run — por eso
 * ninguna máquina llegó nunca a recibirlo.
 *
 * Va en la pasada programada por la misma razón que las banderas de arranque:
 * es el único sitio con CPU garantizada. Se reintenta cada minuto hasta que el
 * plugin conteste, y se repite de vez en cuando porque el contexto vive en la
 * memoria del plugin y un reinicio de CS2 lo borra.
 */
const BRIDGE_CONTEXT_REFRESH_MS = 15 * 60 * 1000;

function needsBridgeContext(gs) {
  if (!gs || !gs.ip || !gs.tournamentId || !gs.matchId) return false;
  const status = String(gs.status || '');
  if (status !== 'online' && status !== 'udp_blocked') return false;
  if (gs.bridgeContext !== true) return true;
  return Date.now() - Number(gs.bridgeContextAt || 0) > BRIDGE_CONTEXT_REFRESH_MS;
}

async function ensureBridgeContextCore() {
  const snap = await admin.database().ref('gameServers').once('value');
  const all = snap.val() || {};

  const pending = Object.keys(all)
    .map((id) => ({ id, gs: all[id] || {} }))
    .filter(({ gs }) => needsBridgeContext(gs))
    .filter(({ gs }) => serverAgeMs(gs) < RECONCILE_MAX_AGE_MS)
    .slice(0, RECONCILE_MAX_SERVERS);

  const results = [];
  for (let i = 0; i < pending.length; i += 1) {
    const { id, gs } = pending[i];
    const result = await rcon.setMatchContext(
      String(gs.ip).trim(),
      CS2_GAME_PORT,
      process.env.RCON_PASSWORD,
      gs.tournamentId,
      gs.matchId
    );
    // Si el puente no contesta, se pregunta qué capas cargó la máquina: sin eso
    // el parte dice "no responde" y no hay forma de saber si falta Metamod, el
    // marco de plugins o solo el puente.
    const probe = result.ok
      ? null
      : await rcon.probeBridge(String(gs.ip).trim(), CS2_GAME_PORT, process.env.RCON_PASSWORD);

    await rtdb.writeGameServer(String(id), {
      bridgeContext: result.ok === true,
      bridgeContextAt: Date.now(),
      bridgeContextError: result.ok ? null : String(result.error || 'unknown').slice(0, 200),
      bridgePluginVersion: result.pluginVersion || null,
      bridgeProbe: probe,
    });
    results.push({
      serverId: String(id),
      ok: result.ok === true,
      pluginVersion: result.pluginVersion || null,
      error: result.ok ? null : result.error,
      probe: probe,
    });
  }

  return { attempted: results.length, results };
}

/**
 * Máquinas con partida en pie ahora mismo, para no apagar por debajo a alguien
 * que está jugando. Se mira el cruce y no el estado del servidor porque el
 * estado se queda viejo en cuanto algo falla a medias.
 */
async function busyServersByTournament(tournamentIds) {
  const busy = {};
  const unreadable = new Set();

  for (const tournamentId of tournamentIds) {
    if (!tournamentId) continue;
    let tournament = null;
    try {
      tournament = await rtdb.getTournament(tournamentId);
    } catch (err) {
      // Torneo ilegible: no se apaga nada suyo hasta poder comprobarlo.
      console.warn('[sweepServers] no se pudo leer el torneo', tournamentId, err.message);
      unreadable.add(String(tournamentId));
      continue;
    }
    const live = (tournament && tournament.liveMatches) || {};
    concurrency.busyMatchIds(tournament, null).forEach((mid) => {
      const serverId = (live[mid] || {}).serverId;
      if (serverId) busy[String(serverId)] = true;
    });
  }

  return { busy, unreadable };
}

/**
 * Apaga lo que ya no juega. Es la mitad cara de la reconciliación: la otra
 * vigila arranques, esta vigila la factura.
 */
async function sweepFinishedServersCore() {
  if (!lifecycle.autoShutdownEnabled(process.env)) return { swept: 0, results: [] };

  const snap = await admin.database().ref('gameServers').once('value');
  const all = snap.val() || {};
  const ids = Object.keys(all);
  if (!ids.length) return { swept: 0, results: [] };

  const tournamentIds = Array.from(
    new Set(ids.map((id) => (all[id] || {}).tournamentId).filter(Boolean))
  );
  const { busy, unreadable } = await busyServersByTournament(tournamentIds);

  const plan = lifecycle
    .planAutoShutdown(all, Date.now(), process.env, busy)
    .filter((item) => !unreadable.has(String(item.tournamentId || '')));
  const results = [];

  for (const item of plan) {
    try {
      await shutdownServerCore({ serverId: item.serverId, tournamentId: item.tournamentId });
      results.push({ serverId: item.serverId, reason: item.reason, deleted: true });
      console.log('[sweepServers] apagado', item.serverId, item.reason);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error('[sweepServers]', item.serverId, message);
      results.push({ serverId: item.serverId, reason: item.reason, error: message });
    }
  }

  return { swept: results.length, results };
}

/**
 * Máquinas nuestras que existen en el proveedor y no en la base: se crearon y
 * el registro nunca llegó a escribirse. Nadie las mira y facturan igual.
 */
async function sweepOrphanServersCore() {
  let instances = [];
  try {
    instances = await provider.listProjectServers();
  } catch (err) {
    console.warn('[sweepOrphans] no se pudo listar el proveedor:', err.message);
    return { orphans: 0, results: [] };
  }
  if (!instances.length) return { orphans: 0, results: [] };

  const snap = await admin.database().ref('gameServers').once('value');
  const known = snap.val() || {};
  const plan = lifecycle.planOrphanCleanup(instances, known, Date.now(), process.env);
  const results = [];

  for (const item of plan) {
    try {
      await provider.deleteServer(item.serverId);
      results.push({ serverId: item.serverId, deleted: true, ageMs: item.ageMs });
      console.log('[sweepOrphans] borrada máquina huérfana', item.serverId, item.name);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (/not found|404/i.test(message)) {
        results.push({ serverId: item.serverId, deleted: true, alreadyGone: true });
      } else {
        console.error('[sweepOrphans]', item.serverId, message);
        results.push({ serverId: item.serverId, error: message });
      }
    }
  }

  return { orphans: results.length, results };
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
  // Retomar un arranque a medias no puede quitarle el puntero a la partida que
  // esté jugándose en la otra máquina.
  if (concurrency.canClaimPrimary(await rtdb.getTournament(tournamentId), serverId)) {
    await rtdb.writeTournament(tournamentId, { activeServerId: String(serverId) });
  }
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

/**
 * Slot GSLT libre para este cruce, o error si el torneo ya va al máximo.
 * El reparto vive en lib/concurrency.js; aquí solo se lee el torneo y se
 * traduce el "no cabe" al error que ve el panel.
 */
async function resolveSlot(tournamentId, matchId, requested, action) {
  const tournament = await rtdb.getTournament(tournamentId);
  const result = concurrency.plan(tournament, matchId, requested);
  if (!result.allowed) {
    throw new HttpsError('failed-precondition', concurrency.blockedMessage(result, action));
  }
  return result.slot;
}

async function provisionServerCore({ tournamentId, matchId, gsltIndex = 0, location }) {
  if (!tournamentId || !matchId) {
    throw new HttpsError('invalid-argument', 'tournamentId and matchId required');
  }

  const slot = await resolveSlot(tournamentId, matchId, gsltIndex, 'levantar otro servidor');
  const gsltKey = slot === 1 ? 'GSLT_SERVER_2' : 'GSLT_SERVER_1';
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
    labels: { tournamentId, matchId, gslt: String(slot) },
    location: location || undefined,
    // Sin esto las dos máquinas arrancaban con GSLT_SERVER_1 y Steam echaba a una.
    gsltSlot: slot,
    // El puente necesita saber a qué cruce pertenece desde el primer arranque:
    // hasta ahora solo se enteraba al lanzar la partida y descartaba todo lo
    // que pasara antes, incluida la gente entrando a calentar.
    tournamentId,
    matchId,
  });

  await rtdb.writeGameServer(String(server.id), {
    status: 'provisioning',
    tournamentId,
    matchId,
    gsltIndex: slot,
    provider: cloudProvider,
    region: server.region || location || null,
    cloudServerId: server.id,
    hetznerId: server.id, // legacy RTDB field name
    provisionMode: server.provisionMode || (provider.usesSnapshot() ? 'snapshot' : 'full'),
    createdAt: Date.now(),
  });
  // Primary pointer for older clients; per-match slot lives under liveMatches.
  if (concurrency.canClaimPrimary(await rtdb.getTournament(tournamentId), server.id)) {
    await rtdb.writeTournament(tournamentId, {
      activeServerId: String(server.id),
    });
  }
  await rtdb.writeTournamentLiveMatch(tournamentId, matchId, {
    status: 'provisioning',
    serverId: String(server.id),
    gsltIndex: slot,
  });

  await finishProvision(server.id, tournamentId, matchId);

  const gsSnap = await admin.database().ref(`gameServers/${server.id}`).once('value');
  const gs = gsSnap.val() || {};

  return {
    ok: true,
    serverId: server.id,
    name: server.name,
    gsltIndex: slot,
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

/**
 * Levantar de un solo golpe las dos semifinales de un cuadro de cuatro.
 *
 * En modo dos servidores el reparto de ranuras GSLT lo decide el backend leyendo
 * el torneo, así que las dos provisiones tienen que ir en fila: pedidas a la vez
 * las dos leerían el mismo estado, las dos verían libre la ranura 0 y las dos
 * máquinas arrancarían con el mismo token de Steam, que es justo lo que echa a
 * una de las dos. Ir en fila cuesta poco porque provisionServerCore solo espera
 * a que el proveedor asigne IP; el arranque de CS2 lo vigila el pase programado.
 *
 * Que una falle no puede dejar a la otra sin servidor: el error se guarda en su
 * entrada y se sigue. Solo se propaga si no se levantó ninguna, para que el
 * panel tenga algo que decir.
 */
async function provisionDualSemisCore({ tournamentId, location }) {
  if (!tournamentId) {
    throw new HttpsError('invalid-argument', 'tournamentId required');
  }

  const tournament = await rtdb.getTournament(tournamentId);
  if (!tournament) {
    throw new HttpsError('not-found', 'Tournament not found');
  }

  const plan = concurrency.planDualSemis(tournament);
  if (!plan.ok) {
    throw new HttpsError('failed-precondition', concurrency.dualSemisBlockedMessage(plan));
  }

  const results = [];
  for (const entry of plan.entries) {
    if (entry.skipped) {
      results.push({
        matchId: entry.matchId,
        serverId: entry.serverId,
        gsltIndex: entry.gsltIndex,
        skipped: entry.skipped,
      });
      continue;
    }
    if (entry.blocked) {
      results.push({
        matchId: entry.matchId,
        serverId: null,
        gsltIndex: null,
        skipped: 'no_slot',
      });
      continue;
    }

    try {
      const res = await provisionServerCore({
        tournamentId,
        matchId: entry.matchId,
        gsltIndex: entry.gsltIndex,
        location,
      });
      results.push({
        matchId: entry.matchId,
        serverId: String(res.serverId),
        gsltIndex: res.gsltIndex,
        status: res.status,
        ip: res.ip || null,
      });
    } catch (err) {
      const message = err && err.message ? String(err.message) : 'Provision failed';
      console.error('[provisionDualSemis]', entry.matchId, message);
      results.push({
        matchId: entry.matchId,
        serverId: null,
        gsltIndex: entry.gsltIndex,
        error: message,
      });
    }
  }

  const created = results.filter((r) => r.serverId && !r.skipped).length;
  if (!created) {
    const firstError = results.find((r) => r.error);
    if (firstError) throw new HttpsError('failed-precondition', firstError.error);
  }

  return { ok: true, mode: plan.mode, created, results };
}

async function launchMatchCore({
  tournamentId,
  matchId,
  map = 'de_mirage',
  serverId,
  teamIds,
  startingSide,
  allowUnlockedRosters,
  allowUnverifiedTeams,
  skipBracketRebuild,
}) {
  if (!tournamentId || !matchId) {
    throw new HttpsError('invalid-argument', 'tournamentId and matchId required');
  }

  const tournament = await rtdb.getTournament(tournamentId);

  // Mismo tope que al levantar servidor: en modo servidor único no se arranca
  // un segundo cruce aunque alguien tenga una VM suelta a mano.
  const room = concurrency.plan(tournament, matchId, 0);
  if (!room.allowed) {
    throw new HttpsError('failed-precondition', concurrency.blockedMessage(room, 'lanzar este cruce'));
  }

  let ip = tournament?.serverIp;
  const cloudServerId = serverId || tournament?.activeServerId;

  if (!cloudServerId || !(await rtdb.gameServerExists(String(cloudServerId)))) {
    // Limpiar el torneo entero solo si no queda otra partida en pie: en modo
    // dos servidores el otro cruce sigue en vivo y se quedaría sin IP.
    if (tournamentId && !room.busy.length) {
      await rtdb.clearTournamentServerFields(tournamentId);
    }
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

  let roster = Array.isArray(teamIds) ? teamIds.filter(Boolean) : [];
  if (bracket.shouldSeedBracket(tournament, roster, skipBracketRebuild)) {
    const bracketData = bracket.buildSingleElimBracket(roster);
    await rtdb.writeTournament(tournamentId, {
      bracket: bracketData,
      currentMatchId: bracketData.currentMatchId,
    });
  } else if (roster.length < 2) {
    // Quien lanza no tiene por qué saberse la plantilla del cruce: si no la
    // manda, se lee del cuadro, que es la fuente buena.
    roster = bracket.teamIdsForMatch(tournament, matchId);
  }

  const matchBuild = await matchzy.buildMatchConfig({
    tournamentId,
    matchId,
    map,
    teamIds: roster,
    startingSide,
  });

  // A roster that cannot be locked is what produced the wedged launch: MatchZy does not
  // know where the unlinked players belong, so they end up choosing a side by hand.
  // Refused by default and reported by name, but the Commander can still override.
  if (matchBuild.ok && !matchBuild.rostersLocked && allowUnlockedRosters !== true) {
    const missing = []
      .concat(matchBuild.missingSteam.team1 || [])
      .concat(matchBuild.missingSteam.team2 || []);
    const who = missing.length ? missing.join(', ') : 'ningun jugador tiene Steam vinculado';
    throw new HttpsError(
      'failed-precondition',
      'No puedo asignar los equipos: falta vincular Steam a ' + who + '. '
      + 'Sin eso el servidor no sabe a que equipo pertenecen y pueden acabar en el bando contrario.',
      {
        reason: 'rosters_unlocked',
        missing,
        team1: matchBuild.team1Name || null,
        team2: matchBuild.team2Name || null,
      }
    );
  }

  // La verificación no se puede exigir al inscribirse (se paga estando ya dentro
  // del torneo), así que la puerta está aquí: al lanzar, los dos equipos tienen
  // que estar verificados y con partidas por gastar.
  if (matchBuild.ok && allowUnverifiedTeams !== true) {
    const gate = await verification.checkTeams([matchBuild.team1Id, matchBuild.team2Id]);
    if (gate.blocked.length) {
      throw new HttpsError('failed-precondition', verification.blockedMessage(gate.blocked), {
        reason: 'teams_unverified',
        teams: gate.blocked,
      });
    }
  }

  if (matchBuild.ok && matchBuild.config) {
    await matchzy.storeMatchConfig(tournamentId, matchId, matchBuild.config, matchBuild.steamMap);
  }
  const chosenSide = matchBuild.startingSide || matchzy.resolveSide(startingSide);

  // Sin secreto el servidor no puede descargar la plantilla ni devolver el
  // resultado, así que la partida nacería muerta. Mejor decirlo antes de
  // arrancarla que descubrirlo con los diez jugadores ya dentro.
  const matchToken = secrets.matchConfigSecret(process.env);
  if (!matchToken) {
    throw new HttpsError(
      'failed-precondition',
      'Falta configurar WEBHOOK_SECRET en las funciones. Sin él el servidor no puede '
      + 'descargar la plantilla del cruce ni reportar el resultado.'
    );
  }
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

  const launchedAt = Date.now();

  // Esta máquina vuelve a jugar: si venía de otra partida tenía el apagado
  // programado, y encadenar cruces en el mismo servidor no puede acabar con la
  // máquina borrada a mitad del siguiente.
  if (cloudServerId) {
    await rtdb.writeGameServer(String(cloudServerId), Object.assign(
      { status: 'online', matchId, tournamentId },
      lifecycle.cancelShutdownPatch()
    ));
  }

  // active* stays the "primary" slot for older clients; liveMatches lets two
  // cruces run on two servers without overwriting each other.
  await rtdb.writeTournament(tournamentId, {
    status: rconOk ? 'en_vivo' : 'pendiente',
    activeMatchId: rconOk ? matchId : null,
    activeServerId: cloudServerId || null,
    activeMap: rconOk ? map : null,
    serverIp: ip,
    serverPort: port,
  });

  await rtdb.writeTournamentLiveMatch(tournamentId, matchId, {
    status: rconOk ? 'live' : 'starting',
    serverId: cloudServerId || null,
    serverIp: ip,
    serverPort: port,
    map,
    startingSide: chosenSide,
    startedAt: launchedAt,
    rconOk,
    // Los jugadores no pueden leer gameServers, así que el aviso de puerto de
    // juego bloqueado viaja por el cruce o no les llega nunca.
    gameUdpOk: readiness.gameUdpOk === false ? false : true,
  });

  // El jugador que no tiene la sala abierta no se entera de nada: este es el
  // único aviso que le llega de que ya hay servidor al que conectarse.
  if (rconOk && matchBuild.ok) {
    try {
      const tournament = await rtdb.getTournament(tournamentId);
      const tournamentName = (tournament && tournament.name) || 'tu torneo';
      await rtdb.notifyTeamRosters(
        [matchBuild.team1Id, matchBuild.team2Id],
        `tourlive_${tournamentId}_${matchId}`,
        {
          text: `Tu partida de ${tournamentName} está en vivo en ${map}. Entra a la sala y copia el connect.`,
          icon: 'fa-satellite-dish',
          link: `/tournament-details?id=${tournamentId}`,
          type: 'tournament_live',
        }
      );
    } catch (err) {
      // Un fallo avisando no puede tumbar un lanzamiento que ya salió bien.
      console.warn('[launch] no se pudo avisar al roster:', err.message);
    }
  }

  await rtdb.writeMatchLive(tournamentId, matchId, {
    status: rconOk ? 'live' : 'starting',
    tournamentId,
    map,
    startingSide: chosenSide,
    serverIp: ip,
    serverPort: port,
    serverId: cloudServerId || null,
    startedAt: launchedAt,
    durationSeconds: 0,
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
    startingSide: chosenSide,
    sideWasDrawn: matchBuild.sideRequest === 'random',
    rostersLocked: matchBuild.rostersLocked === true,
    gameUdpOk: readiness.gameUdpOk,
    playerConnectOk: readiness.playerConnectOk,
    manualConnect: !rconOk,
    bootGrace: readiness.bootGrace && !readiness.portOpen && !readiness.rconOk,
    connectWarning: readiness.playerConnectOk
      ? null
      : 'Players cannot connect yet — UDP 27015 is blocked or CS2 is not responding. Try Check Readiness, or shutdown and reprovision the server.',
  };
}

/**
 * Apagar un servidor libera su cruce, pero no el torneo entero: en modo dos
 * servidores la otra partida sigue en vivo y los espectadores siguen mirando.
 * Sin esto, el cruce apagado quedaría marcado como vivo para siempre y en modo
 * servidor único ya no se podría lanzar el siguiente.
 */
async function releaseServerMatches(tournamentId, serverId) {
  const tournament = await rtdb.getTournament(tournamentId);
  const live = (tournament && tournament.liveMatches) || {};
  const mine = Object.keys(live).filter(
    (mid) => String((live[mid] || {}).serverId || '') === String(serverId)
  );

  for (const mid of mine) {
    const current = live[mid] || {};
    await rtdb.writeTournamentLiveMatch(tournamentId, mid, {
      status: current.status === 'finished' ? 'finished' : 'stopped',
      stoppedAt: Date.now(),
    });
  }

  const survivors = concurrency
    .busyMatchIds(tournament, null)
    .filter((mid) => mine.indexOf(mid) === -1);

  if (!survivors.length) {
    await rtdb.clearTournamentServerFields(tournamentId);
    return { released: mine, survivors: [] };
  }

  // Queda partida en pie: los punteros de nivel torneo apuntan a la que sigue viva.
  const next = live[survivors[0]] || {};
  await rtdb.writeTournament(tournamentId, {
    activeServerId: next.serverId || null,
    serverIp: next.serverIp || null,
    serverPort: next.serverPort || null,
    activeMap: next.map || null,
    activeMatchId: survivors[0],
  });
  return { released: mine, survivors };
}

async function shutdownServerCore({ serverId, tournamentId }) {
  if (!serverId) throw new HttpsError('invalid-argument', 'serverId required');

  const gsSnap = await admin.database().ref(`gameServers/${serverId}`).once('value');
  const gs = gsSnap.val() || {};
  const providerHint = gs.provider || provider.activeProviderName();

  if (tournamentId) {
    await releaseServerMatches(tournamentId, serverId);
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

// 540s y no 300: provisionDual encadena dos esperas de IP y con el tope viejo
// la segunda podía quedarse cortada a mitad, con la máquina ya creada y
// facturando pero sin registro terminado.
exports.cs2NexusApi = onRequest(
  { timeoutSeconds: 540, memory: '512MiB', invoker: 'public' },
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
        case 'provisiondual':
          result = await provisionDualSemisCore(req.body || {});
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
          throw new HttpsError('invalid-argument', 'Unknown op. Use provision, provisionDual, launch, shutdown, resume, or check.');
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

exports.cs2ProvisionDualSemis = onCall(
  { timeoutSeconds: 540, memory: '512MiB', invoker: 'public', cors: true },
  async (request) => {
    try {
      await assertCommander(request);
      return await provisionDualSemisCore(request.data || {});
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
    // Sin secreto configurado no se atiende a nadie: antes, con la variable
    // vacía, una cabecera vacía coincidía y cualquiera podía inventar el
    // resultado de una partida, avanzar el cuadro y repartir premios.
    const expected = secrets.webhookSecret(process.env);
    if (!expected) {
      console.error('[cs2MatchWebhook] WEBHOOK_SECRET sin configurar (o de menos de '
        + secrets.MIN_LENGTH + ' caracteres): no acepto resultados de partida.');
      res.status(503).json({ error: 'Webhook secret not configured' });
      return;
    }
    if (!secrets.matches(req.headers['x-webhook-secret'], expected)) {
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
 * El token (cabecera X-Match-Token o ?token=) es obligatorio: la configuración
 * del cruce lleva los SteamID de las dos plantillas y no puede quedar al aire.
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

    const expected = secrets.matchConfigSecret(process.env);
    if (!expected) {
      console.error('[cs2MatchConfig] WEBHOOK_SECRET sin configurar: no sirvo plantillas.');
      res.status(503).json({ error: 'Match config token not configured' });
      return;
    }
    const headerToken = req.get('X-Match-Token') || req.get('x-match-token') || '';
    const queryToken = req.query.token || '';
    if (!secrets.matches(headerToken, expected) && !secrets.matches(queryToken, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
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
          startingSide: req.query.side,
        });
        if (!built.ok || !built.config) {
          res.status(404).json({ error: built.reason || 'Match config not found' });
          return;
        }
        config = built.config;
        // Persist it so match_end can still map SteamIDs back to Nexus accounts
        // when MatchZy pulled the config through this fallback path.
        await matchzy.storeMatchConfig(tournamentId, matchId, config, built.steamMap);
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

exports.cs2ReconcileServers = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 540, memory: '512MiB', retryCount: 0 },
  async () => {
    const summary = await reconcileServersCore();
    if (summary.checked > 0) {
      console.log('[cs2ReconcileServers]', JSON.stringify(summary));
    }

    try {
      const bridged = await ensureBridgeContextCore();
      if (bridged.attempted > 0) {
        console.log('[cs2BridgeContext]', JSON.stringify(bridged));
      }
    } catch (err) {
      console.error('[cs2BridgeContext]', err && err.message ? err.message : err);
    }

    // El apagado va en la misma pasada que la reconciliación: son las dos caras
    // del mismo problema, y una máquina que nadie apaga cuesta dinero por hora.
    try {
      const sweep = await sweepFinishedServersCore();
      if (sweep.swept > 0) console.log('[cs2SweepServers]', JSON.stringify(sweep));
    } catch (err) {
      console.error('[cs2SweepServers]', err && err.message ? err.message : err);
    }
  }
);

/**
 * El repaso contra el proveedor es caro y lento comparado con leer la base, así
 * que va aparte y cada cuarto de hora: busca máquinas nuestras que existen en
 * Vultr y no en el registro.
 */
exports.cs2SweepOrphanServers = onSchedule(
  { schedule: 'every 15 minutes', timeoutSeconds: 300, memory: '256MiB', retryCount: 0 },
  async () => {
    const summary = await sweepOrphanServersCore();
    if (summary.orphans > 0) {
      console.log('[cs2SweepOrphanServers]', JSON.stringify(summary));
    }
  }
);
