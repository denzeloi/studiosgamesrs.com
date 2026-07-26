/**
 * Boss of the State — reclamo one-time server-side (SEC-009)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

function normalizeRango(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

/** Primer Commander reclama Boss of the State (atómico, una sola vez). */
exports.claimBossOfTheState = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const db = admin.database();
  const userSnap = await db.ref('users/' + uid).once('value');
  if (!userSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Usuario no encontrado.');
  }

  const user = userSnap.val() || {};
  const rango = normalizeRango(user.rango);
  if (rango === 'boss_of_the_state') {
    return { success: true, alreadyBoss: true, uid };
  }
  if (rango !== 'commander') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un Commander puede reclamar Boss of the State.'
    );
  }

  const nick = String((data && data.nick) || user.nick || context.auth.token.name || uid).trim().slice(0, 64);
  const bossRef = db.ref('security/bossOfTheState');
  const tx = await bossRef.transaction((current) => {
    if (current !== null) return;
    return {
      uid,
      nick,
      rango: 'boss_of_the_state',
      claimedAt: admin.database.ServerValue.TIMESTAMP
    };
  });

  if (!tx.committed || !tx.snapshot.exists()) {
    throw new functions.https.HttpsError(
      'already-exists',
      'Ya existe un Boss of the State. Solo hay uno.'
    );
  }

  const stored = tx.snapshot.val() || {};
  if (stored.uid !== uid) {
    throw new functions.https.HttpsError(
      'already-exists',
      'Ya existe un Boss of the State. Solo hay uno.'
    );
  }

  await db.ref('users/' + uid + '/rango').set('boss_of_the_state');
  return { success: true, uid, nick };
});
