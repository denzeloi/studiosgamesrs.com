/**
 * Privacidad Nexus — leaderboard y datos agregados (SEC-018)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

const STAFF_RANGOS = {
  commander: true,
  boss_of_the_state: true,
  divisional_commander: true
};

function normRango(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, '_');
}

function isStaff(rango) {
  return !!STAFF_RANGOS[normRango(rango)];
}

/** Ranking Nexus agregado (sin lectura masiva de nexus/users en cliente). */
exports.getNexusLeaderboard = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const limit = Math.min(50, Math.max(5, Math.floor(Number(data && data.limit) || 25)));
  const snap = await admin.database().ref('nexus/users').once('value');
  const list = [];

  snap.forEach(function (child) {
    const d = child.val();
    if (!d || !d.stats) return;
    list.push({
      uid: child.key,
      xp: Number(d.stats.xp) || 0,
      level: Number(d.stats.level) || 1,
      rankIndex: Number(d.stats.rank) || 0,
      name: (d.user && (d.user.displayName || d.user.username)) || 'Usuario',
      photoURL: d.user && d.user.photoURL ? String(d.user.photoURL) : null
    });
  });

  list.sort(function (a, b) { return b.xp - a.xp; });

  return {
    entries: list.slice(0, limit),
    totalPlayers: list.length,
    generatedAt: Date.now()
  };
});

/** XP Nexus de referidos del usuario autenticado (solo sus referidos). */
exports.getMyReferralsNexusXp = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const refsSnap = await admin.database().ref('users/' + uid + '/referrals').once('value');
  const refs = refsSnap.val() || {};
  const refUids = Object.keys(refs);

  if (!refUids.length) {
    return { xpByUid: {} };
  }

  const xpByUid = {};
  await Promise.all(refUids.map(async function (refUid) {
    const xpSnap = await admin.database().ref('nexus/users/' + refUid + '/stats/xp').once('value');
    xpByUid[refUid] = Number(xpSnap.val()) || 0;
  }));

  return { xpByUid };
});

/** Staff: lectura acotada de stats Nexus de un jugador (panel Commander). */
exports.getNexusUserStatsForStaff = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const actorUid = context.auth.uid;
  const rangoSnap = await admin.database().ref('users/' + actorUid + '/rango').once('value');
  if (!isStaff(rangoSnap.val())) {
    throw new functions.https.HttpsError('permission-denied', 'Solo Commanders pueden consultar stats Nexus de otros.');
  }

  const targetUid = String((data && data.targetUid) || '').trim();
  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID destino requerido.');
  }

  const snap = await admin.database().ref('nexus/users/' + targetUid + '/stats').once('value');
  if (!snap.exists()) {
    return { targetUid, stats: null };
  }

  const stats = snap.val() || {};
  return {
    targetUid,
    stats: {
      xp: Number(stats.xp) || 0,
      level: Number(stats.level) || 1,
      rank: Number(stats.rank) || 0,
      streak: Number(stats.streak) || 0,
      totalQuestsCompleted: Number(stats.totalQuestsCompleted) || 0,
      verifiedReferrals: Number(stats.verifiedReferrals) || 0
    }
  };
});
