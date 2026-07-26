/**
 * Token ledger — append-only server-side (SEC-007)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

const STAFF_RANGOS = {
  commander: true,
  boss_of_the_state: true,
  divisional_commander: true
};

const ALLOWED_LEDGER_TYPES = {
  boss_credit: true,
  boss_debit: true,
  commander_credit: true,
  commander_debit: true,
  premium_grant: true,
  mission_reward: true,
  mission_refund: true,
  team_verification: true,
  team_background: true,
  signup_bonus: true,
  forge_reward: true,
  system_adjustment: true
};

function normRango(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, '_');
}

function isStaff(rango) {
  return !!STAFF_RANGOS[normRango(rango)];
}

function sanitizeEntry(data, actorUid, actorNick) {
  const type = String(data && data.type || '').trim().slice(0, 40);
  if (!ALLOWED_LEDGER_TYPES[type]) {
    throw new functions.https.HttpsError('invalid-argument', 'Tipo de movimiento no permitido.');
  }

  const entry = {
    type,
    amount: data.amount != null ? Number(data.amount) : null,
    balanceBefore: data.balanceBefore != null ? Number(data.balanceBefore) : null,
    balanceAfter: data.balanceAfter != null ? Number(data.balanceAfter) : null,
    reason: String(data.reason || '').trim().slice(0, 500),
    source: String(data.source || 'commander_panel').trim().slice(0, 40),
    rewardType: data.rewardType ? String(data.rewardType).slice(0, 40) : null,
    rewardValue: data.rewardValue != null ? String(data.rewardValue).slice(0, 120) : null,
    missionId: data.missionId ? String(data.missionId).slice(0, 64) : null,
    byUid: actorUid || 'system',
    byNick: String(actorNick || actorUid || 'system').slice(0, 80),
    at: admin.database.ServerValue.TIMESTAMP
  };

  if (entry.amount != null && entry.balanceBefore != null && entry.balanceAfter != null) {
    const expected = entry.balanceBefore + entry.amount;
    if (Math.abs(expected - entry.balanceAfter) > 0.0001) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'El ledger no cuadra: balanceBefore + amount debe ser balanceAfter.'
      );
    }
  }

  return entry;
}

/** Admin SDK: append ledger (Cloud Functions internas). */
async function appendTokenLedgerEntryAdmin(targetUid, data) {
  const uid = String(targetUid || '').trim();
  if (!uid) return null;

  const entry = {
    type: String(data.type || 'system_adjustment').slice(0, 40),
    amount: data.amount != null ? Number(data.amount) : null,
    balanceBefore: data.balanceBefore != null ? Number(data.balanceBefore) : null,
    balanceAfter: data.balanceAfter != null ? Number(data.balanceAfter) : null,
    reason: String(data.reason || '').slice(0, 500),
    source: String(data.source || 'cloud_function').slice(0, 40),
    rewardType: data.rewardType ? String(data.rewardType).slice(0, 40) : null,
    rewardValue: data.rewardValue != null ? String(data.rewardValue).slice(0, 120) : null,
    missionId: data.missionId ? String(data.missionId).slice(0, 64) : null,
    byUid: data.byUid ? String(data.byUid).slice(0, 64) : 'system',
    byNick: data.byNick ? String(data.byNick).slice(0, 80) : 'Sistema',
    at: admin.database.ServerValue.TIMESTAMP
  };

  const ref = await admin.database().ref('users/' + uid + '/tokenLedger').push(entry);
  return ref.key;
}

/** Commander/Boss: append-only al historial de tokens de un usuario. */
exports.appendTokenLedgerEntry = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const actorUid = context.auth.uid;
  const rangoSnap = await admin.database().ref('users/' + actorUid + '/rango').once('value');
  if (!isStaff(normRango(rangoSnap.val()))) {
    throw new functions.https.HttpsError('permission-denied', 'Solo Commanders pueden escribir en tokenLedger.');
  }

  const targetUid = String(data && data.targetUid || '').trim();
  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID destino requerido.');
  }

  const actorNick = data && data.byNick
    ? String(data.byNick)
    : ((await admin.database().ref('users/' + actorUid + '/nick').once('value')).val() || 'Commander');

  const entry = sanitizeEntry(data, actorUid, actorNick);
  const ref = await admin.database().ref('users/' + targetUid + '/tokenLedger').push(entry);
  return { ledgerId: ref.key };
});

exports.appendTokenLedgerEntryAdmin = appendTokenLedgerEntryAdmin;
