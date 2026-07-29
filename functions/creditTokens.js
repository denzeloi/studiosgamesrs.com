/**
 * Acreditación de tokens — única puerta de escritura del saldo
 * =============================================================
 * Vivía dentro de awardMissionTokens.js, pero las recompensas de nivel del
 * Nexus también tienen que pagar tokens y duplicar la transacción + el asiento
 * en el ledger era pedir que las dos copias se separaran con el tiempo.
 *
 * Se mantiene aparte de nexusXp.js y de awardMissionTokens.js a propósito: los
 * dos la usan y si viviera en cualquiera de ellos habría un require circular.
 */
'use strict';

const admin = require('firebase-admin');

/**
 * Suma tokens al saldo del jugador y deja el asiento correspondiente en su
 * historial. No valida cupos ni bolsas: quien llama ya decidió cuánto paga.
 */
async function creditTokens(uid, amount, meta) {
  if (!uid || amount <= 0) return;
  const tokensRef = admin.database().ref(`users/${uid}/tokens`);
  const result = await tokensRef.transaction((cur) => (cur || 0) + amount);
  if (!result.committed) return;

  const after = Number(result.snapshot.val()) || 0;
  const before = after - amount;

  try {
    const tokenLedger = require('./tokenLedger');
    await tokenLedger.appendTokenLedgerEntryAdmin(uid, {
      type: (meta && meta.type) || 'mission_reward',
      amount,
      balanceBefore: before,
      balanceAfter: after,
      reason: (meta && meta.reason) || 'Premio misión PlayZone',
      source: (meta && meta.source) || 'awardMissionTokens',
      missionId: meta && meta.missionId ? meta.missionId : null,
      byUid: 'system',
      byNick: (meta && meta.byNick) || 'PlayZone'
    });
  } catch (e) {
    console.error('[creditTokens] ledger', uid, e);
  }
}

exports.creditTokens = creditTokens;
