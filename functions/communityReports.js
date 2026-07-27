/**
 * Reportes de jugadores — Community (SEC-020)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { warnMissingAppCheck } = require('./appCheckGuard');

const REPORT_COOLDOWN_MS = 60 * 1000;
const MAX_REASON_LEN = 500;
const MAX_NICK_LEN = 80;

function clipStr(v, max) {
  return String(v || '').trim().slice(0, max);
}

/** Envía reporte a moderación y actualiza lastReport (solo server). */
exports.submitCommunityReport = functions.https.onCall(async (data, context) => {
  warnMissingAppCheck(context, 'submitCommunityReport');
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const reporterId = context.auth.uid;
  const reportedUserId = clipStr(data && data.reportedUserId, 128);
  const reportedUserNick = clipStr(data && data.reportedUserNick, MAX_NICK_LEN);
  const reason = clipStr(data && data.reason, MAX_REASON_LEN);

  if (!reportedUserId || !reportedUserNick) {
    throw new functions.https.HttpsError('invalid-argument', 'Selecciona un jugador válido.');
  }
  if (!reason) {
    throw new functions.https.HttpsError('invalid-argument', 'Escribe el motivo del reporte.');
  }
  if (reportedUserId === reporterId) {
    throw new functions.https.HttpsError('invalid-argument', 'No puedes reportarte a ti mismo.');
  }

  const reportedSnap = await admin.database().ref('users/' + reportedUserId).once('value');
  if (!reportedSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Jugador reportado no encontrado.');
  }

  const cooldownRef = admin.database().ref('users/' + reporterId + '/lastCommunityReportAt');
  const cooldownSnap = await cooldownRef.once('value');
  const lastAt = Number(cooldownSnap.val()) || 0;
  const now = Date.now();
  if (lastAt && now - lastAt < REPORT_COOLDOWN_MS) {
    throw new functions.https.HttpsError('resource-exhausted', 'Espera un momento antes de enviar otro reporte.');
  }

  const reporterSnap = await admin.database().ref('users/' + reporterId + '/nick').once('value');
  const reporterNick = clipStr(reporterSnap.val() || context.auth.token.name || 'Usuario', MAX_NICK_LEN);

  const reportRef = admin.database().ref('communityReports').push();
  const reportId = reportRef.key;
  const timestamp = now;

  await reportRef.set({
    reporterId,
    reporterNick,
    reportedUserId,
    reportedUserNick,
    reason,
    timestamp,
    readByCommanders: []
  });

  await admin.database().ref('commanderNotifications/lastReport').set({
    reportId,
    reporterNick,
    reportedUserNick,
    timestamp
  });

  await cooldownRef.set(timestamp);

  return { reportId, timestamp };
});
