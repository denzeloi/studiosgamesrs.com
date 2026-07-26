/**
 * PlayZone — Misión "Jugar con amigos" (CS2)
 * ===========================================
 * Verifica que cada participante con Steam vinculado jugó al menos 1 partida nueva
 * desde que el líder inició la misión (total_matches_played sube).
 *
 * LIMITACIÓN: la Steam Web API NO expone lobby compartido ni Premier rating.
 * No puede probar al 100% que jugaron la MISMA partida juntos; valida que
 * todos completaron una partida en la ventana de tiempo de la misión.
 */

const functions = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: 'https://studiosgamesrs-default-rtdb.firebaseio.com' });
}

const STEAM_API_KEY = defineSecret('STEAM_API_KEY');
const CS2_APPID = 730;
const REWARD_PER_PLAYER = 5;
const MIN_ACTIVE_MINUTES = 20;

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

function isCs2FriendsMission(m) {
  return m && m.verificationMode === 'cs2_steam' && norm(m.game).includes('counter-strike');
}

function statsArrayToMap(statsArr) {
  const map = {};
  if (Array.isArray(statsArr)) {
    statsArr.forEach(function (s) {
      if (s && typeof s.name === 'string') map[s.name] = s.value;
    });
  }
  return map;
}

async function fetchMatchesPlayed(steamId) {
  const url = 'https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/'
    + '?appid=' + CS2_APPID
    + '&key=' + STEAM_API_KEY.value()
    + '&steamid=' + encodeURIComponent(steamId);
  const resp = await fetch(url);
  if (!resp.ok) return { ok: false, reason: 'steam_http_' + resp.status };
  const json = await resp.json();
  const stats = json && json.playerstats && json.playerstats.stats;
  if (!Array.isArray(stats) || stats.length === 0) return { ok: false, reason: 'no_stats' };
  const map = statsArrayToMap(stats);
  return {
    ok: true,
    matchesPlayed: Number(map.total_matches_played || 0),
    lastMatchKills: Number(map.last_match_kills || 0),
    lastMatchRounds: Number(map.last_match_rounds || 0)
  };
}

async function getSteamIdForUid(db, uid) {
  const snap = await db.ref('users/' + uid).once('value');
  const d = snap.val() || {};
  if (d.steamID) return String(d.steamID);
  if (d.steam && d.steam.steamid) return String(d.steam.steamid);
  return null;
}

async function captureBaselinesForMission(db, missionId, mission) {
  const participants = mission.participants || {};
  const uids = Object.keys(participants);
  const baselines = {};
  const errors = {};

  for (const uid of uids) {
    const steamId = await getSteamIdForUid(db, uid);
    if (!steamId) {
      errors[uid] = 'no_steam';
      continue;
    }
    const stats = await fetchMatchesPlayed(steamId);
    if (!stats.ok) {
      errors[uid] = stats.reason;
      continue;
    }
    baselines[uid] = {
      steamId: steamId,
      matchesPlayed: stats.matchesPlayed,
      capturedAt: admin.database.ServerValue.TIMESTAMP
    };
  }

  await db.ref('missions/' + missionId).update({
    cs2Baselines: baselines,
    cs2BaselinesCaptured: true,
    cs2BaselineErrors: Object.keys(errors).length ? errors : null
  });
  return { baselines, errors };
}

function allReady(mission) {
  const pIds = Object.keys(mission.participants || {});
  if (pIds.length < 2) return false;
  const ready = mission.cs2Ready || {};
  return pIds.every(function (id) { return ready[id] === true; });
}

function minTimeElapsed(mission) {
  const start = typeof mission.startedAt === 'number' ? mission.startedAt : null;
  if (!start) return false;
  return (Date.now() - start) >= MIN_ACTIVE_MINUTES * 60 * 1000;
}

/**
 * Al pasar a active, guarda partidas jugadas (baseline) de cada participante.
 */
exports.captureCs2Baselines = functions.runWith({ secrets: [STEAM_API_KEY] })
  .database
  .ref('/missions/{missionId}')
  .onUpdate(async (change, context) => {
    const before = change.before.val();
    const after = change.after.val();
    if (!isCs2FriendsMission(after)) return null;
    if (before && before.status === 'active') return null;
    if (after.status !== 'active') return null;
    if (after.cs2BaselinesCaptured) return null;

    const db = admin.database();
    await captureBaselinesForMission(db, context.params.missionId, after);
    return null;
  });

/**
 * Callable: verifica partida CS2 del equipo y marca misión completada si todos pasan.
 */
exports.verifyCs2FriendsMission = functions.runWith({ secrets: [STEAM_API_KEY] }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const missionId = data && data.missionId ? String(data.missionId) : '';
  if (!missionId) {
    throw new functions.https.HttpsError('invalid-argument', 'missionId requerido.');
  }

  const db = admin.database();
  const missionSnap = await db.ref('missions/' + missionId).once('value');
  const mission = missionSnap.val();
  if (!mission || !isCs2FriendsMission(mission)) {
    throw new functions.https.HttpsError('failed-precondition', 'No es una misión CS2 con amigos.');
  }
  if (!mission.participants || !mission.participants[context.auth.uid]) {
    throw new functions.https.HttpsError('permission-denied', 'No eres participante de esta misión.');
  }
  if (mission.status !== 'active') {
    throw new functions.https.HttpsError('failed-precondition', 'La misión debe estar activa.');
  }
  if (!minTimeElapsed(mission)) {
    throw new functions.https.HttpsError('failed-precondition', 'Aún no pasó el tiempo mínimo de partida (~' + MIN_ACTIVE_MINUTES + ' min).');
  }
  if (mission.nexusVerifiedComplete || mission.cs2Verification) {
    return { success: true, alreadyVerified: true };
  }

  const baselines = mission.cs2Baselines || {};
  const pIds = Object.keys(mission.participants || {});
  if (pIds.length < 2) {
    throw new functions.https.HttpsError('failed-precondition', 'Se necesitan al menos 2 jugadores.');
  }

  const results = {};
  let allPassed = true;

  for (const uid of pIds) {
    const base = baselines[uid];
    if (!base || typeof base.matchesPlayed !== 'number') {
      results[uid] = { passed: false, reason: 'no_baseline' };
      allPassed = false;
      continue;
    }
    const steamId = base.steamId || await getSteamIdForUid(db, uid);
    if (!steamId) {
      results[uid] = { passed: false, reason: 'no_steam' };
      allPassed = false;
      continue;
    }
    const stats = await fetchMatchesPlayed(steamId);
    if (!stats.ok) {
      results[uid] = { passed: false, reason: stats.reason };
      allPassed = false;
      continue;
    }
    const delta = stats.matchesPlayed - base.matchesPlayed;
    const passed = delta >= 1;
    results[uid] = {
      passed: passed,
      before: base.matchesPlayed,
      after: stats.matchesPlayed,
      delta: delta,
      lastMatchRounds: stats.lastMatchRounds
    };
    if (!passed) allPassed = false;
  }

  if (!allPassed) {
    return { success: false, allPassed: false, results: results };
  }

  const confirmations = {};
  pIds.forEach(function (uid) { confirmations[uid] = true; });

  await db.ref('missions/' + missionId).update({
    completionConfirmations: confirmations,
    nexusVerifiedComplete: admin.database.ServerValue.TIMESTAMP,
    cs2Verification: {
      status: 'passed',
      verifiedAt: admin.database.ServerValue.TIMESTAMP,
      verifiedBy: context.auth.uid,
      results: results
    }
  });

  return { success: true, allPassed: true, results: results };
});

exports.REWARD_PER_PLAYER = REWARD_PER_PLAYER;
