/**
 * Recompensa de bienvenida — campaña "Lealtad" (tiempo limitado)
 * ==============================================================
 * Otorga UNA sola vez por cuenta: tokens + boost de XP de Nexus + la insignia
 * de Lealtad, que reconoce a quienes se registraron en los primeros tiempos
 * del sitio. Todo pasa por aquí porque tokens, xpBoost y badges son de
 * escritura exclusiva del Admin SDK; el cliente solo dispara el reclamo y
 * pinta el resultado en el overlay épico del dashboard.
 *
 * La campaña se enciende/apaga desde el Commander Panel (Boss of the State)
 * escribiendo en siteCampaigns/welcome; mientras esté abierta la reciben tanto
 * las cuentas nuevas como las que ya existían (en su próxima visita).
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const tokenLedger = require('./tokenLedger');
const { warnMissingAppCheck } = require('./appCheckGuard');

const CAMPAIGN_PATH = 'siteCampaigns/welcome';
const WELCOME_TOKENS = 30;
const WELCOME_BOOST_MULTIPLIER = 1.15;
const WELCOME_BOOST_DAYS = 30;
const WELCOME_BOOST_MS = WELCOME_BOOST_DAYS * 24 * 60 * 60 * 1000;
const WELCOME_BADGE_ID = 'loyalty_trial';

/**
 * Estado de la campaña. Por omisión se considera ABIERTA: así no hace falta
 * sembrar nada en la base para que arranque, y el interruptor del Commander
 * Panel solo tiene que escribir active=false para cerrarla.
 */
async function readCampaign() {
  const snap = await admin.database().ref(CAMPAIGN_PATH).once('value');
  const cfg = snap.val() || {};
  const active = cfg.active !== false;
  const endsAt = Number(cfg.endsAt) || 0;
  return {
    active,
    endsAt,
    open: active && (!endsAt || Date.now() < endsAt)
  };
}

/** Añade la insignia a un array de badges sin duplicar. */
function withBadge(current) {
  const list = Array.isArray(current)
    ? current.slice()
    : (current && typeof current === 'object' ? Object.keys(current).map((k) => current[k]) : []);
  const clean = list.filter((v) => typeof v === 'string' && v);
  if (clean.indexOf(WELCOME_BADGE_ID) !== -1) return clean;
  clean.push(WELCOME_BADGE_ID);
  return clean;
}

async function grantBadge(uid) {
  // Nexus es la fuente de verdad de las insignias; users/{uid}/badges es el
  // espejo que lee el perfil del dashboard (propio y de visitantes).
  await admin.database().ref('nexus/users/' + uid + '/badges').transaction(withBadge);
  await admin.database().ref('users/' + uid + '/badges').transaction(withBadge);
}

async function grantTokens(uid, amount) {
  const tokensRef = admin.database().ref('users/' + uid + '/tokens');
  const result = await tokensRef.transaction((cur) => (Number(cur) || 0) + amount);
  if (!result.committed) {
    throw new functions.https.HttpsError('aborted', 'No se pudo acreditar los tokens de bienvenida.');
  }
  const balanceAfter = Number(result.snapshot.val()) || 0;
  await tokenLedger.appendTokenLedgerEntryAdmin(uid, {
    type: 'signup_bonus',
    amount,
    balanceBefore: balanceAfter - amount,
    balanceAfter,
    reason: 'Recompensa de bienvenida (campaña Lealtad)',
    source: 'welcome_reward',
    rewardType: 'welcome_tokens',
    byUid: 'system',
    byNick: 'StudiosGamesRS'
  });
  return balanceAfter;
}

/**
 * Boost del 15% durante 30 días. Si un Commander ya dio un boost mejor y
 * todavía corre, se respeta: la bienvenida nunca debe empeorar lo que el
 * usuario ya tenía.
 */
async function grantBoost(uid) {
  const boostRef = admin.database().ref('nexus/users/' + uid + '/xpBoost');
  const snap = await boostRef.once('value');
  const current = snap.val() || {};
  const now = Date.now();
  const currentActive = Number(current.expiresAt) > now;
  const currentMult = Number(current.multiplier) || 0;
  if (currentActive && currentMult >= WELCOME_BOOST_MULTIPLIER) {
    return { multiplier: currentMult, expiresAt: Number(current.expiresAt), kept: true };
  }
  const expiresAt = now + WELCOME_BOOST_MS;
  await boostRef.set({
    multiplier: WELCOME_BOOST_MULTIPLIER,
    expiresAt,
    grantedAt: now,
    durationMs: WELCOME_BOOST_MS,
    reason: 'Recompensa de bienvenida',
    byUid: 'system',
    byNick: 'StudiosGamesRS'
  });
  return { multiplier: WELCOME_BOOST_MULTIPLIER, expiresAt, kept: false };
}

/**
 * Reclama la recompensa de bienvenida. Idempotente: el marcador claimedAt se
 * fija con una transacción antes de mover nada, y se revierte si algo falla,
 * de forma que ni se puede reclamar dos veces ni se queda a medias.
 */
exports.claimWelcomeReward = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  warnMissingAppCheck(context, 'claimWelcomeReward');

  const uid = context.auth.uid;
  const db = admin.database();

  const campaign = await readCampaign();
  if (!campaign.open) {
    throw new functions.https.HttpsError('failed-precondition', 'La campaña de bienvenida está cerrada.');
  }

  const userSnap = await db.ref('users/' + uid).once('value');
  if (!userSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Tu perfil todavía no está creado.');
  }
  const user = userSnap.val() || {};
  if (user.blocked === true) {
    throw new functions.https.HttpsError('permission-denied', 'Cuenta bloqueada.');
  }

  const claimRef = db.ref('users/' + uid + '/welcomeReward/claimedAt');
  const claimTx = await claimRef.transaction((cur) => {
    if (cur) return; // ya reclamado: aborta sin escribir
    return Date.now();
  });
  if (!claimTx.committed || !claimTx.snapshot.val()) {
    throw new functions.https.HttpsError('already-exists', 'Ya recibiste la recompensa de bienvenida.');
  }

  try {
    const balanceAfter = await grantTokens(uid, WELCOME_TOKENS);
    const boost = await grantBoost(uid);
    await grantBadge(uid);

    await db.ref('users/' + uid + '/welcomeReward').update({
      tokens: WELCOME_TOKENS,
      boostMultiplier: boost.multiplier,
      boostExpiresAt: boost.expiresAt,
      badgeId: WELCOME_BADGE_ID,
      campaign: 'loyalty_first_wave'
    });

    functions.logger.info('[welcome] recompensa otorgada', { uid, tokens: WELCOME_TOKENS, badge: WELCOME_BADGE_ID });

    return {
      granted: true,
      nick: user.nick || null,
      tokens: WELCOME_TOKENS,
      balanceAfter,
      boostPercent: Math.round((boost.multiplier - 1) * 100),
      boostMultiplier: boost.multiplier,
      boostExpiresAt: boost.expiresAt,
      badgeId: WELCOME_BADGE_ID
    };
  } catch (err) {
    await claimRef.remove().catch(() => {});
    functions.logger.error('[welcome] fallo al otorgar; reclamo revertido', { uid, error: err && err.message });
    throw err;
  }
});

/**
 * Otorga la insignia (sin tokens ni boost) a todas las cuentas que ya existen,
 * para no depender de que cada usuario vuelva a entrar. Solo Boss of the
 * State, invocable desde el Commander Panel.
 */
exports.backfillWelcomeBadge = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const actorUid = context.auth.uid;
  const rangoSnap = await admin.database().ref('users/' + actorUid + '/rango').once('value');
  const rango = String(rangoSnap.val() || '').toLowerCase().replace(/\s+/g, '_');
  if (rango !== 'boss_of_the_state') {
    throw new functions.https.HttpsError('permission-denied', 'Solo Boss of the State puede repartir la insignia.');
  }

  const usersSnap = await admin.database().ref('users').once('value');
  const uids = [];
  usersSnap.forEach((child) => {
    const v = child.val() || {};
    if (v.blocked === true) return;
    const badges = Array.isArray(v.badges) ? v.badges : [];
    if (badges.indexOf(WELCOME_BADGE_ID) === -1) uids.push(child.key);
  });

  let granted = 0;
  for (let i = 0; i < uids.length; i += 1) {
    try {
      await grantBadge(uids[i]);
      granted += 1;
    } catch (err) {
      functions.logger.warn('[welcome] no se pudo dar la insignia', { uid: uids[i], error: err && err.message });
    }
  }

  functions.logger.info('[welcome] backfill de insignia', { actorUid, granted, scanned: uids.length });
  return { granted, scanned: uids.length };
});
