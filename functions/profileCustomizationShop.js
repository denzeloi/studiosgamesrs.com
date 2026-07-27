/**
 * Compra y equipado de marcos/fondos de perfil (tokens atómicos).
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

exports.purchaseProfileCustomizationItem = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const type = data && data.type;
  const itemId = data && data.itemId;
  const equipAfter = data && data.equipAfter !== false;

  if (!itemId || typeof itemId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Falta itemId.');
  }
  if (type !== 'background' && type !== 'frame') {
    throw new functions.https.HttpsError('invalid-argument', 'Tipo inválido.');
  }

  const db = admin.database();
  const bucket = type === 'background' ? 'background' : 'frame';
  const assetSnap = await db.ref('profileCustomizationAssets/' + bucket + '/' + itemId).once('value');
  if (!assetSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Ítem no encontrado en el catálogo.');
  }

  const asset = assetSnap.val() || {};
  const cost = Math.max(0, Number(asset.tokenCost) || 0);
  const userRef = db.ref('users/' + uid);
  const userSnap = await userRef.once('value');
  if (!userSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Usuario no encontrado.');
  }

  const user = userSnap.val() || {};
  const cust = user.profileCustomization || {};
  const unlocked = cust.unlocked || {};
  if (unlocked[itemId]) {
    if (equipAfter) {
      const equipKey = type === 'background' ? 'equippedBackground' : 'equippedFrame';
      await userRef.child('profileCustomization/' + equipKey).set(itemId);
    }
    return { success: true, alreadyOwned: true, itemId: itemId, type: type };
  }

  const tokensRef = userRef.child('tokens');
  if (cost > 0) {
    const txn = await tokensRef.transaction(function (current) {
      if (current === null || typeof current === 'undefined') return current;
      if (Number(current) < cost) return;
      return Number(current) - cost;
    });
    if (!txn.committed || txn.snapshot.val() === null) {
      throw new functions.https.HttpsError('failed-precondition', 'No tienes suficientes tokens.');
    }
  }

  const updates = {};
  updates['users/' + uid + '/profileCustomization/unlocked/' + itemId] = true;
  if (equipAfter) {
    const equipKey = type === 'background' ? 'equippedBackground' : 'equippedFrame';
    updates['users/' + uid + '/profileCustomization/' + equipKey] = itemId;
  }
  await db.ref().update(updates);

  return {
    success: true,
    itemId: itemId,
    type: type,
    tokensSpent: cost,
    equipped: !!equipAfter
  };
});
