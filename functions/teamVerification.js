/**
 * Verificación de equipos (Competition Hub)
 * =========================================
 * Regla de negocio:
 *   - Para que un equipo esté "verificado" y pueda jugar torneos oficiales,
 *     TODOS los miembros del roster deben pagar 5 coins cada uno.
 *   - La verificación es válida por 3 partidas de torneo. Al consumir las 3,
 *     el equipo vuelve a "no verificado" y debe pagar de nuevo (todos otra vez).
 *
 * Todo el manejo de coins ocurre en el servidor (las reglas bloquean que el
 * cliente modifique su propio saldo de tokens).
 *
 * === Instalación (functions/index.js) ===
 *   const teamVerification = require('./teamVerification');
 *   exports.payTeamVerification = teamVerification.payTeamVerification;
 *   exports.consumeVerificationMatch = teamVerification.consumeVerificationMatch;
 *   exports.purchaseTeamBackground = teamVerification.purchaseTeamBackground;
 * Desplegar:
 *   firebase deploy --only functions:payTeamVerification
 *   firebase deploy --only functions:consumeVerificationMatch
 *   firebase deploy --only functions:purchaseTeamBackground
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const VERIFICATION_COST = 5;      // Coins que paga cada miembro.
const VERIFICATION_MATCHES = 3;   // Partidas de torneo que dura la verificación.

// Fondos premium comprables con coins (deben coincidir con el cliente).
// Rojo es el más caro, dorado en el medio, aurora el más económico.
const BACKGROUND_PRICES = { aurora: 15, gold: 30, red: 50 };

// ¿El equipo está inscrito en algún torneo activo (no finalizado/cancelado)?
async function isTeamEnrolledInTournament(db, teamId) {
  const snap = await db.ref('tournaments').limitToLast(60).once('value');
  if (!snap.exists()) return false;
  let enrolled = false;
  snap.forEach(function (ch) {
    const t = ch.val() || {};
    const reg = t.registeredTeams || {};
    if (!reg[teamId]) return;
    const st = (t.status || '').toString().toLowerCase();
    const finished = ['finalizado', 'finished', 'cancelado', 'cancelled', 'completed'].indexOf(st) !== -1;
    if (!finished) enrolled = true;
  });
  return enrolled;
}

/**
 * Un miembro paga su parte (5 coins) de la verificación del equipo.
 * Cuando TODOS los miembros del roster han pagado, el equipo queda verificado
 * por 3 partidas.
 */
exports.payTeamVerification = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const uid = context.auth.uid;
  const teamId = data && data.teamId;
  if (!teamId || typeof teamId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Falta el identificador del equipo.');
  }

  const db = admin.database();
  const teamSnap = await db.ref('teams/' + teamId).once('value');
  if (!teamSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Equipo no encontrado.');
  }
  const team = teamSnap.val() || {};
  const roster = team.roster || {};
  if (!roster[uid]) {
    throw new functions.https.HttpsError('permission-denied', 'No perteneces a este equipo.');
  }

  const verification = team.verification || {};

  // Ya verificado y con partidas disponibles: no hace falta pagar.
  if (verification.status === 'verified' && (verification.matchesRemaining || 0) > 0) {
    return { verified: true, alreadyVerified: true, matchesRemaining: verification.matchesRemaining };
  }

  const payments = verification.payments || {};
  const rosterUids = Object.keys(roster);

  // Este miembro ya pagó en el ciclo actual.
  if (payments[uid]) {
    const paid = rosterUids.filter(function (u) { return payments[u]; }).length;
    return { alreadyPaid: true, remainingMembers: Math.max(0, rosterUids.length - paid) };
  }

  // La verificación solo se puede pagar si el equipo está inscrito en un torneo.
  const enrolled = await isTeamEnrolledInTournament(db, teamId);
  if (!enrolled) {
    throw new functions.https.HttpsError('failed-precondition', 'Tu equipo debe estar inscrito en un torneo para verificarse.');
  }

  // Descuenta 5 coins de forma atómica.
  const userTokensRef = db.ref('users/' + uid + '/tokens');
  const txn = await userTokensRef.transaction(function (current) {
    if (current === null || typeof current === 'undefined') return current; // no aborta si no existe: se maneja abajo
    if (current < VERIFICATION_COST) return; // aborta (no commit): saldo insuficiente
    return current - VERIFICATION_COST;
  });

  if (!txn.committed || txn.snapshot.val() === null || typeof txn.snapshot.val() === 'undefined') {
    throw new functions.https.HttpsError('failed-precondition', 'No tienes suficientes coins (necesitas ' + VERIFICATION_COST + ').');
  }

  // Registra el pago de este miembro.
  await db.ref('teams/' + teamId + '/verification/payments/' + uid).set(true);

  // Re-lee para comprobar si ya pagaron todos.
  const freshSnap = await db.ref('teams/' + teamId).once('value');
  const fresh = freshSnap.val() || {};
  const freshRoster = fresh.roster || {};
  const freshPayments = (fresh.verification && fresh.verification.payments) || {};
  const freshUids = Object.keys(freshRoster);
  const allPaid = freshUids.length > 0 && freshUids.every(function (u) { return freshPayments[u]; });

  if (allPaid) {
    await db.ref('teams/' + teamId + '/verification').update({
      status: 'verified',
      matchesRemaining: VERIFICATION_MATCHES,
      verifiedAt: admin.database.ServerValue.TIMESTAMP,
      payments: null // se reinicia para el siguiente ciclo
    });
    return { verified: true, matchesRemaining: VERIFICATION_MATCHES };
  }

  const paidNow = freshUids.filter(function (u) { return freshPayments[u]; }).length;
  return { verified: false, remainingMembers: Math.max(0, freshUids.length - paidNow) };
});

/**
 * Consume una partida de torneo de la verificación del equipo. Cuando llega a 0,
 * el equipo vuelve a "no verificado". Solo un Commander puede registrarla
 * (flujo oficial de torneos), para evitar abusos.
 *
 * Llamar desde el flujo de resultados de torneo con { teamId }.
 */
exports.consumeVerificationMatch = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const uid = context.auth.uid;
  const db = admin.database();

  const rankSnap = await db.ref('users/' + uid + '/rango').once('value');
  const rank = (rankSnap.val() || '').toString().toLowerCase();
  if (rank !== 'commander') {
    throw new functions.https.HttpsError('permission-denied', 'Solo un Commander puede registrar partidas de torneo.');
  }

  const teamId = data && data.teamId;
  if (!teamId || typeof teamId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Falta el identificador del equipo.');
  }

  const vRef = db.ref('teams/' + teamId + '/verification');
  const res = await vRef.transaction(function (v) {
    if (!v || v.status !== 'verified') return v;
    var rem = (v.matchesRemaining || 0) - 1;
    if (rem <= 0) {
      v.status = 'unverified';
      v.matchesRemaining = 0;
      v.payments = null;
    } else {
      v.matchesRemaining = rem;
    }
    return v;
  });

  const v = (res.snapshot && res.snapshot.val()) || {};
  return { status: v.status || 'unverified', matchesRemaining: v.matchesRemaining || 0 };
});

/**
 * Compra un fondo premium para el equipo con coins. Solo el capitán puede comprarlo.
 * Descuenta el precio de forma atómica y marca el fondo como "poseído".
 * Llamar con { teamId, backgroundId }.
 */
exports.purchaseTeamBackground = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const uid = context.auth.uid;
  const teamId = data && data.teamId;
  const backgroundId = data && data.backgroundId;
  if (!teamId || typeof teamId !== 'string' || !backgroundId || typeof backgroundId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Datos incompletos.');
  }

  const price = BACKGROUND_PRICES[backgroundId];
  if (!price) {
    throw new functions.https.HttpsError('invalid-argument', 'Ese fondo no está disponible para comprar.');
  }

  const db = admin.database();
  const teamSnap = await db.ref('teams/' + teamId).once('value');
  if (!teamSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Equipo no encontrado.');
  }
  const team = teamSnap.val() || {};

  // Solo el capitán gestiona la apariencia del equipo.
  if (team.captain !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Solo el capitán puede comprar fondos para el equipo.');
  }

  // Si ya lo posee, no se cobra de nuevo.
  if (team.appearance && team.appearance.ownedBackgrounds && team.appearance.ownedBackgrounds[backgroundId]) {
    return { success: true, alreadyOwned: true, backgroundId: backgroundId };
  }

  // Descuenta el precio de forma atómica.
  const userTokensRef = db.ref('users/' + uid + '/tokens');
  const txn = await userTokensRef.transaction(function (current) {
    if (current === null || typeof current === 'undefined') return current;
    if (current < price) return; // aborta: saldo insuficiente
    return current - price;
  });

  if (!txn.committed || txn.snapshot.val() === null || typeof txn.snapshot.val() === 'undefined') {
    throw new functions.https.HttpsError('failed-precondition', 'No tienes suficientes coins (necesitas ' + price + ').');
  }

  await db.ref('teams/' + teamId + '/appearance/ownedBackgrounds/' + backgroundId).set(true);
  return { success: true, backgroundId: backgroundId, price: price };
});
