/**
 * Códigos de referido — registro server-side (SEC-008)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

function buildReferralCode(uid) {
  const clean = String(uid || '').replace(/^nx_/, '').slice(0, 8).toUpperCase();
  if (!clean) {
    throw new functions.https.HttpsError('invalid-argument', 'UID inválido para código de referido.');
  }
  return 'NEXUS-' + clean;
}

function isValidReferralCode(code) {
  return /^NEXUS-[A-Z0-9]{1,12}$/.test(String(code || '').trim().toUpperCase());
}

/** Crea o devuelve el código de referido del usuario autenticado (idempotente). */
exports.ensureUserReferralCode = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const provider = context.auth.token.firebase && context.auth.token.firebase.sign_in_provider;
  if (provider === 'anonymous') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Las cuentas anónimas no pueden registrar códigos de referido.'
    );
  }

  const userCodeRef = admin.database().ref('users/' + uid + '/referralCode');
  const existingSnap = await userCodeRef.once('value');
  const code = buildReferralCode(uid);

  if (existingSnap.exists()) {
    const stored = String(existingSnap.val() || '').trim().toUpperCase();
    if (isValidReferralCode(stored)) {
      const refSnap = await admin.database().ref('refCodes/' + stored).once('value');
      if (refSnap.val() === uid) {
        return { code: stored, created: false };
      }
      if (!refSnap.exists()) {
        await admin.database().ref('refCodes/' + stored).set(uid);
        return { code: stored, created: false, repaired: true };
      }
    }
  }

  const refCodeRef = admin.database().ref('refCodes/' + code);
  const tx = await refCodeRef.transaction((current) => {
    if (current === null || current === uid) return uid;
    return;
  });

  if (!tx.committed) {
    throw new functions.https.HttpsError(
      'already-exists',
      'Este código de referido ya está asignado a otra cuenta.'
    );
  }

  await userCodeRef.set(code);
  return { code, created: !existingSnap.exists() };
});
