/**
 * Verificación App Check en Cloud Functions (SEC-022).
 */
const functions = require('firebase-functions');

function warnMissingAppCheck(context, label) {
  if (context.app) return;
  functions.logger.warn('[SEC-022] Callable sin token App Check', {
    label: label || 'unknown',
    uid: context.auth && context.auth.uid
  });
}

function requireAppCheck(context, featureName) {
  if (context.app) return;
  throw new functions.https.HttpsError(
    'failed-precondition',
    'App Check requerido' + (featureName ? ' (' + featureName + ')' : '') + '.'
  );
}

module.exports = { warnMissingAppCheck, requireAppCheck };
