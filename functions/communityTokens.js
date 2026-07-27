/**
 * Tokens de Community — crédito server-side (SEC-016)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const tokenLedger = require('./tokenLedger');

const FORGE_UPLOAD_TOKEN_REWARD = 2;
const MAX_FORGE_AGE_MS = 20 * 60 * 1000;

async function creditUserTokens(uid, amount, meta) {
  const tokensRef = admin.database().ref('users/' + uid + '/tokens');
  const result = await tokensRef.transaction((cur) => (Number(cur) || 0) + amount);
  if (!result.committed) {
    throw new functions.https.HttpsError('aborted', 'No se pudo acreditar tokens.');
  }
  const after = Number(result.snapshot.val()) || 0;
  const before = after - amount;
  await tokenLedger.appendTokenLedgerEntryAdmin(uid, {
    type: 'forge_reward',
    amount,
    balanceBefore: before,
    balanceAfter: after,
    reason: String(meta.reason || 'Recompensa Community Forge').slice(0, 500),
    source: 'community_forge',
    rewardType: meta.rewardType || 'forge_upload',
    rewardValue: meta.rewardValue ? String(meta.rewardValue).slice(0, 120) : null,
    byUid: 'system',
    byNick: 'Community Forge'
  });
  return { granted: amount, balanceAfter: after };
}

/** Recompensa de tokens por publicación en La Forja (una vez por imagen/clip). */
exports.awardCommunityForgeUploadTokens = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const imageId = String((data && data.imageId) || '').trim();
  if (!imageId) {
    throw new functions.https.HttpsError('invalid-argument', 'Falta imageId.');
  }

  const imageRef = admin.database().ref('communityImages/' + imageId);
  const imageSnap = await imageRef.once('value');
  if (!imageSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Publicación no encontrada.');
  }

  const image = imageSnap.val() || {};
  if (image.userId !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Solo el autor puede reclamar esta recompensa.');
  }

  const ts = Number(image.timestamp) || 0;
  if (!ts || (Date.now() - ts) > MAX_FORGE_AGE_MS) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'La ventana para reclamar tokens de esta publicación expiró.'
    );
  }

  const hasMedia = !!(String(image.imageURL || '').trim() || String(image.videoURL || '').trim());
  if (!hasMedia) {
    throw new functions.https.HttpsError('failed-precondition', 'La publicación no tiene contenido válido.');
  }

  const rewardRef = imageRef.child('tokenRewardGranted');
  const rewardTx = await rewardRef.transaction((current) => {
    if (current === true) return;
    return true;
  });

  if (!rewardTx.committed || rewardTx.snapshot.val() !== true) {
    throw new functions.https.HttpsError('already-exists', 'Los tokens de esta publicación ya fueron otorgados.');
  }

  try {
    const credit = await creditUserTokens(uid, FORGE_UPLOAD_TOKEN_REWARD, {
      reason: 'Forja: ' + String(image.title || imageId).slice(0, 120),
      rewardType: 'forge_upload',
      rewardValue: imageId
    });
    return {
      imageId,
      granted: credit.granted,
      balanceAfter: credit.balanceAfter
    };
  } catch (err) {
    await rewardRef.remove().catch(function () {});
    throw err;
  }
});
