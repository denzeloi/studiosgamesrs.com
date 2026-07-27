/**
 * Economía de usuario — inventory/prestige server-side (SEC-017)
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

async function assertStaff(uid) {
  const snap = await admin.database().ref('users/' + uid + '/rango').once('value');
  if (!isStaff(snap.val())) {
    throw new functions.https.HttpsError('permission-denied', 'Solo Commanders pueden hacer esta acción.');
  }
}

/** Commander/Boss: añade ítem al inventario de un usuario. */
exports.grantUserInventoryItem = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const actorUid = context.auth.uid;
  await assertStaff(actorUid);

  const targetUid = String((data && data.targetUid) || '').trim();
  const name = String((data && data.name) || 'Premio StudiosGamesRS').trim().slice(0, 120);
  const description = String((data && data.description) || '').trim().slice(0, 500);

  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID destino requerido.');
  }
  if (!description) {
    throw new functions.https.HttpsError('invalid-argument', 'Descripción/motivo obligatorio.');
  }

  const actorNickSnap = await admin.database().ref('users/' + actorUid + '/nick').once('value');
  const actorNick = actorNickSnap.val() || 'Commander';

  const itemRef = await admin.database().ref('users/' + targetUid + '/inventory').push({
    name,
    description,
    grantedBy: String(actorNick).slice(0, 80),
    grantedByUid: actorUid,
    grantedAt: admin.database.ServerValue.TIMESTAMP,
    type: 'premium_grant'
  });

  return { targetUid, itemId: itemRef.key, name };
});

/** Commander/Boss: actualiza prestigio (solo staff). */
exports.setUserPrestige = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const actorUid = context.auth.uid;
  await assertStaff(actorUid);

  const targetUid = String((data && data.targetUid) || '').trim();
  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID destino requerido.');
  }

  const payload = data && data.prestige;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new functions.https.HttpsError('invalid-argument', 'Objeto prestige inválido.');
  }

  const safe = {};
  if (payload.level != null) safe.level = Math.max(0, Math.min(999, Math.floor(Number(payload.level) || 0)));
  if (payload.title != null) safe.title = String(payload.title).trim().slice(0, 80);
  if (payload.points != null) safe.points = Math.max(0, Math.min(999999, Math.floor(Number(payload.points) || 0)));
  safe.updatedAt = admin.database.ServerValue.TIMESTAMP;
  safe.updatedByUid = actorUid;

  await admin.database().ref('users/' + targetUid + '/prestige').update(safe);
  return { targetUid, prestige: safe };
});
