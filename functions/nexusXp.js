/**
 * Nexus XP — escritura server-side (SEC-001)
 * Solo Admin SDK puede incrementar xp/level/rank.
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { warnMissingAppCheck } = require('./appCheckGuard');
const { creditTokens } = require('./creditTokens');
const SGLevels = require('./sg-levels.js');

const MAX_COMMANDER_GRANT = 5000;
const DAILY_BOSS_NEXUS_XP_CAP = 15000;

/**
 * El Boss se asigna la XP que quiera: SEC-023 pedía "solo Boss, auditoría
 * obligatoria y tope diario", y eso es lo que siguen cumpliendo las entregas a
 * terceros. Este número no es una política, es el límite aritmético para que
 * RTDB no guarde un XP que rompa el cálculo de niveles (el nivel 100 son
 * 254 500 XP, así que ningún uso real se acerca).
 */
const MAX_SELF_GRANT_XP = 1e12;

const STAFF_RANGOS = {
  commander: true,
  boss_of_the_state: true,
  divisional_commander: true
};

/** Límites por acción: max XP base (antes de multiplicador) y cooldown ms. */
const XP_ACTIONS = {
  'quest:daily_login': { max: 100, cooldownMs: 86400000 },
  'quest:join_discord': { max: 400, cooldownMs: 0, once: true },
  'quest:invite_friend': { max: 500, cooldownMs: 0, once: true },
  'quest:create_overlay': { max: 350, cooldownMs: 0, once: true },
  'quest:complete_profile': { max: 250, cooldownMs: 0, once: true },
  'quest:share_facebook': { max: 500, cooldownMs: 86400000 },
  'quest:share_twitter': { max: 500, cooldownMs: 86400000 },
  'quest:share_whatsapp': { max: 500, cooldownMs: 86400000 },
  download_overlay: { max: 100, cooldownMs: 3600000 },
  share_overlay: { max: 10, cooldownMs: 300000 },
  generate_ai: { max: 50, cooldownMs: 600000 },
  use_ai: { max: 25, cooldownMs: 300000 },
  analyze_design: { max: 25, cooldownMs: 300000 },
  streak_bonus: { max: 500, cooldownMs: 86400000 },
  reward_claim: { max: 2500, cooldownMs: 0 },
  achievement: { max: 2000, cooldownMs: 0, once: true },
  referral_bonus: { max: 500, cooldownMs: 0 },
  // Play Zone y torneos: sin cooldown porque la idempotencia la pone el evento
  // que las dispara (tokensAwarded de la misión, resultId de la partida), no el
  // reloj. Un cooldown aquí solo serviría para tragarse la EXP de dos misiones
  // seguidas legítimas.
  mission_complete: { max: 250, cooldownMs: 0 },
  tournament_win: { max: 300, cooldownMs: 0 },
  tournament_loss: { max: 100, cooldownMs: 0 },
  general: { max: 120, cooldownMs: 45000 }
};

/** Acciones que solo pueden ejecutarse vía Cloud Functions dedicadas. */
const BLOCKED_PLAYER_ACTIONS = {
  'quest:daily_login': true,
  'quest:create_overlay': true,
  download_overlay: true,
  share_overlay: true,
  generate_ai: true,
  use_ai: true,
  analyze_design: true,
  streak_bonus: true,
  mission_complete: true,
  tournament_win: true,
  tournament_loss: true
};

const OVERLAY_UPLOAD_COOLDOWN_MS = 1800000;
const BRANDING_SESSION_MS = 2 * 60 * 60 * 1000;
const BRANDING_SESSION_REG_COOLDOWN_MS = 45000;
const BRANDING_HOURLY_XP_CAP = 10;
const BRANDING_XP_ACTIONS = {
  download_overlay: true,
  share_overlay: true,
  generate_ai: true,
  use_ai: true,
  analyze_design: true
};
const XP_BOOST_MULTIPLIER = 2;
const XP_BOOST_DEFAULT_MS = 3600000;
const XP_BOOST_MIN_MS = 600000;
const XP_BOOST_MAX_MS = 7200000;

/**
 * Catálogo de recompensas por nivel (SEC-011) — debe coincidir con
 * CONFIG.rewards en nexus-logic.js.
 *
 * Los dos marcos reclamables apuntan a marcos que YA existen en el catálogo de
 * personalización (dragon-guard y golden-nexus, de 25 y 50 tokens): antes eran
 * comingSoon y fallaban a propósito porque no había ningún marco que entregar.
 * Los marcos de tramo (nexus-tier-*) no se reclaman aquí, se entregan solos al
 * cruzar el nivel; estos dos siguen siendo el premio de los niveles 4 y 5, que
 * quedan muy por debajo del primer tramo con cosmético propio (el 10).
 */
const NEXUS_REWARDS = {
  welcome_badge: { level: 1, type: 'badge', xpBonus: 100 },
  theme_dashboard: { level: 2, type: 'theme' },
  profile_frame: { level: 3, type: 'badge' },
  beta_access: { level: 4 },
  priority_support: { level: 4 },
  profile_frame_nexus: { level: 4, type: 'frame', frameId: 'dragon-guard' },
  badge_elite: { level: 5, type: 'badge', xpBonus: 2500 },
  exclusive_content: { level: 5 },
  event_early: { level: 5, type: 'badge' },
  custom_overlay: { level: 5 },
  creator_tools: { level: 5, type: 'badge' },
  frame_ambassador: { level: 5, type: 'frame', frameId: 'golden-nexus' },
  vip_lounge: { level: 5, type: 'badge', xpBonus: 1000 }
};

/** Logros Nexus (SEC-012) — debe coincidir con CONFIG.achievements en nexus-logic.js */
const NEXUS_ACHIEVEMENTS = {
  first_steps: { name: 'Primeros Pasos', xp: 100, requirement: 1, type: 'quests', icon: 'fa-shoe-prints' },
  social_butterfly: { name: 'Mariposa Social', xp: 300, requirement: 5, type: 'social_quests', icon: 'fa-share-alt' },
  referral_master: { name: 'Maestro de Referidos', xp: 1000, requirement: 10, type: 'referrals', icon: 'fa-users' },
  streak_keeper: { name: 'Mantenedor de Racha', xp: 500, requirement: 7, type: 'streak', icon: 'fa-fire' },
  xp_collector: { name: 'Coleccionista', xp: 500, requirement: 5000, type: 'xp', icon: 'fa-coins' },
  legendary: { name: 'Leyenda Viviente', xp: 2000, requirement: 5, type: 'rank', icon: 'fa-crown' },
  designer_pro: { name: 'Diseñador Pro', xp: 800, requirement: 10, type: 'overlays', icon: 'fa-paint-brush' },
  community_builder: { name: 'Constructor', xp: 1500, requirement: 25, type: 'referrals', icon: 'fa-hands-helping' },
  daily_warrior: { name: 'Guerrero Diario', xp: 2000, requirement: 30, type: 'daily_streak', icon: 'fa-calendar-alt' }
};

const SOCIAL_QUEST_IDS = ['share_facebook', 'share_twitter', 'share_whatsapp'];

/** Misiones Nexus (SEC-013) — cooldown/once validados en servidor */
const NEXUS_QUESTS = {
  join_discord: { title: 'Unirse a Discord', xp: 400 },
  invite_friend: { title: 'Invitar un Amigo', xp: 500 },
  complete_profile: { title: 'Completar Perfil', xp: 250 },
  share_facebook: { title: 'Compartir en Facebook', xp: 500 },
  share_twitter: { title: 'Compartir en Twitter/X', xp: 500 },
  share_whatsapp: { title: 'Compartir en WhatsApp', xp: 500 }
};

/** Bonos XP por racha (índice = días de racha) — igual que CONFIG.xp.streakBonus */
const STREAK_BONUS = [0, 50, 100, 150, 200, 300, 500];

function utcDayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function utcHourKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return utcDayKey(ts) + 'T' + String(d.getUTCHours()).padStart(2, '0');
}

async function assertActiveBrandingSession(uid) {
  const snap = await admin.database().ref('nexus/users/' + uid + '/overlayActivity/activeSession').once('value');
  const session = snap.val() || {};
  const expiresAt = Number(session.expiresAt) || 0;
  if (expiresAt <= Date.now()) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Sube una imagen al Branding Studio para activar las acciones de XP.'
    );
  }
}

async function consumeBrandingHourlySlot(uid) {
  const hourKey = utcHourKey(Date.now());
  const ref = admin.database().ref('nexus/users/' + uid + '/overlayActivity/hourlyXp/' + hourKey);
  const tx = await ref.transaction((current) => {
    const count = Number(current) || 0;
    if (count >= BRANDING_HOURLY_XP_CAP) return;
    return count + 1;
  });
  if (!tx.committed) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Límite horario de XP en Branding Studio alcanzado.'
    );
  }
  const newCount = Number(tx.snapshot.val()) || 0;
  if (newCount > BRANDING_HOURLY_XP_CAP) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Límite horario de XP en Branding Studio alcanzado.'
    );
  }
}

async function applyBrandingXpGrant(uid, actionKey, meta) {
  if (!BRANDING_XP_ACTIONS[actionKey]) {
    throw new functions.https.HttpsError('invalid-argument', 'Acción de branding inválida.');
  }
  const cfg = XP_ACTIONS[actionKey];
  if (!cfg) {
    throw new functions.https.HttpsError('invalid-argument', 'Acción de XP no configurada.');
  }
  await assertActiveBrandingSession(uid);
  await consumeBrandingHourlySlot(uid);
  return applyXpGrant(uid, cfg.max, actionKey, meta);
}

function requireDashboardUser(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const provider = context.auth.token.firebase && context.auth.token.firebase.sign_in_provider;
  if (provider === 'anonymous') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Inicia sesión con tu cuenta StudiosGamesRS.'
    );
  }
  return context.auth.uid;
}

function requireOverlayCanvas(data) {
  if (!data || !data.hasCanvas) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Debes tener un overlay en el canvas.'
    );
  }
}

function normRango(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, '_');
}

function isStaff(rango) {
  return !!STAFF_RANGOS[normRango(rango)];
}

function isBossOfTheState(rango) {
  return normRango(rango) === 'boss_of_the_state';
}

function utcDateKey(d) {
  const dt = d || new Date();
  return dt.toISOString().slice(0, 10);
}

async function consumeBossDailyNexusXpBudget(actorUid, amount) {
  const dateKey = utcDateKey();
  const ref = admin.database().ref('security/nexusXpGrantDaily/' + actorUid + '/' + dateKey);
  const result = await ref.transaction(function (cur) {
    const prev = Number(cur) || 0;
    const next = prev + amount;
    if (next > DAILY_BOSS_NEXUS_XP_CAP) {
      return;
    }
    return next;
  });
  if (!result.committed) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Tope diario de XP Nexus alcanzado (' + DAILY_BOSS_NEXUS_XP_CAP.toLocaleString('en-US') + ' XP/día).'
    );
  }
  return { dateKey, totalAfter: Number(result.snapshot.val()) || 0 };
}

async function appendNexusXpGrantAudit(actorUid, actorNick, targetUid, amount, reason, selfGrant) {
  const entry = {
    action: 'nexus_xp_grant',
    targetUid,
    amount,
    reason: String(reason || '').slice(0, 200),
    byUid: actorUid,
    byNick: actorNick,
    at: admin.database.ServerValue.TIMESTAMP
  };
  if (selfGrant) entry.self = true;
  await admin.database().ref('security/tokenAuditLog').push(entry);
}

/**
 * Único traductor de XP a nivel en todo el servidor. Cualquier sitio que
 * escriba stats debe pasar por aquí: cuando había dos cálculos distintos
 * (applyXpGrant y grantNexusXpCommander) ya se habían separado una vez.
 *
 * `rank` deja de ser el escalón viejo 0–4 y pasa a ser el índice de tramo 0–9.
 * Se mantiene el nombre del campo porque hay lecturas repartidas por el sitio
 * (leaderboard, panel de staff) que lo esperan; `tier` es el mismo número con
 * el nombre correcto y `tierName` evita que el cliente tenga que resolverlo.
 */
function levelFieldsFromXp(xp) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  const level = SGLevels.levelFromXp(total);
  const tier = SGLevels.tierForLevel(level);
  return { level, rank: tier.index, tier: tier.index, tierName: tier.name };
}

/**
 * Añade una insignia sin duplicar, en el mismo formato de array de strings que
 * usa welcomeReward.js. Nexus es la fuente de verdad y users/{uid}/badges el
 * espejo que lee el perfil.
 */
function badgeAppender(badgeId) {
  return function (current) {
    const list = Array.isArray(current)
      ? current.slice()
      : (current && typeof current === 'object' ? Object.keys(current).map((k) => current[k]) : []);
    const clean = list.filter((v) => typeof v === 'string' && v);
    if (clean.indexOf(badgeId) !== -1) return clean;
    clean.push(badgeId);
    return clean;
  };
}

async function grantNexusBadge(uid, badgeId) {
  await admin.database().ref('nexus/users/' + uid + '/badges').transaction(badgeAppender(badgeId));
  await admin.database().ref('users/' + uid + '/badges').transaction(badgeAppender(badgeId));
}

/** RTDB rechaza undefined: las recompensas se copian campo a campo. */
function serializeReward(reward) {
  const out = {
    type: String(reward.type || ''),
    id: String(reward.id || ''),
    name: String(reward.name || ''),
    description: String(reward.description || '')
  };
  if (reward.amount != null) out.amount = Math.floor(Number(reward.amount) || 0);
  return out;
}

async function deliverReward(uid, level, reward) {
  if (reward.type === 'frame' || reward.type === 'background') {
    await admin.database()
      .ref('users/' + uid + '/profileCustomization/unlocked/' + reward.id)
      .set(true);
    return;
  }
  if (reward.type === 'badge') {
    await grantNexusBadge(uid, reward.id);
    return;
  }
  if (reward.type === 'tokens' && reward.amount > 0) {
    await creditTokens(uid, reward.amount, {
      type: 'level_reward',
      reason: 'Recompensa del nivel ' + level,
      source: 'nexusLevelUp',
      byNick: 'Nexus'
    });
  }
  // 'perk' no se escribe: perksForLevel(level) lo deriva del nivel actual.
}

/**
 * Entrega las recompensas de UN nivel y deja el evento de celebración.
 *
 * Forma del nodo nexus/users/{uid}/levelUps/{level} — es contrato con el
 * cliente, que escucha aquí para lanzar la animación de subida:
 *
 *   {
 *     level:     12,                 // número de nivel alcanzado
 *     tierIndex: 1,                  // 0–9
 *     tierName:  'CREADOR',
 *     rewards:   [ { type, id, name, description, amount? }, ... ],
 *     at:        1730000000000,      // ms; hora del servidor
 *     failed:    ['id', ...]         // opcional, solo si algo no se pudo dar
 *   }
 *
 * `at` se escribe primero con Date.now() dentro de la transacción (los
 * ServerValue no se resuelven de forma fiable ahí dentro) y se reemplaza por
 * el timestamp real del servidor en cuanto termina la entrega.
 */
async function deliverLevelRewards(uid, level) {
  const tier = SGLevels.tierForLevel(level);
  const rewards = SGLevels.rewardsForLevel(level).map(serializeReward);
  const eventRef = admin.database().ref('nexus/users/' + uid + '/levelUps/' + level);

  // Cerrojo: crear el nodo del nivel ES la reserva. Si dos grants cruzan el
  // mismo umbral a la vez, solo uno gana la transacción y paga.
  const claim = await eventRef.transaction((cur) => {
    if (cur !== null) return;
    return {
      level,
      tierIndex: tier.index,
      tierName: tier.name,
      rewards,
      at: Date.now()
    };
  });
  if (!claim.committed || !claim.snapshot.exists()) return null;

  const failed = [];
  for (const reward of rewards) {
    try {
      await deliverReward(uid, level, reward);
    } catch (err) {
      failed.push(reward.id);
      console.error('[nexus] recompensa ' + reward.id + ' del nivel ' + level + ' no entregada a ' + uid, err);
    }
  }

  const patch = { at: admin.database.ServerValue.TIMESTAMP };
  if (failed.length) patch.failed = failed;
  await eventRef.update(patch);

  return { level, tierIndex: tier.index, tierName: tier.name, rewards, failed };
}

/**
 * Entrega TODOS los niveles cruzados. Un grant grande del Boss puede saltar
 * varios de golpe y ninguno debe quedarse sin sus recompensas.
 */
async function applyLevelUpRewards(uid, levelBefore, levelAfter) {
  const from = Math.max(1, Math.floor(Number(levelBefore) || 1));
  const to = Math.min(SGLevels.MAX_LEVEL, Math.floor(Number(levelAfter) || 1));
  if (!uid || to <= from) return [];

  const events = [];
  for (let level = from + 1; level <= to; level++) {
    try {
      const event = await deliverLevelRewards(uid, level);
      if (event) events.push(event);
    } catch (err) {
      console.error('[nexus] fallo al procesar la subida al nivel ' + level + ' de ' + uid, err);
    }
  }
  return events;
}

function sanitizeActionKey(raw) {
  const key = String(raw || 'general').trim().slice(0, 80);
  if (XP_ACTIONS[key]) return key;
  if (/^achievement:[a-z0-9_]+$/.test(key)) return key;
  if (/^reward:[a-z0-9_]+$/.test(key)) return key;
  if (/^quest:[a-z0-9_]+$/.test(key) && XP_ACTIONS[key]) return key;
  return 'general';
}

async function readStaffRango(uid) {
  const snap = await admin.database().ref('users/' + uid + '/rango').once('value');
  return normRango(snap.val());
}

async function ensureStatsNode(uid) {
  const ref = admin.database().ref('nexus/users/' + uid + '/stats');
  const snap = await ref.once('value');
  if (snap.exists()) {
    const stats = snap.val() || {};
    // Cuentas de la época de 5 niveles: se recolocan en la curva nueva la
    // primera vez que se las toca, sin esperar a que ganen XP.
    const fields = levelFieldsFromXp(stats.xp);
    if (stats.level !== fields.level || stats.rank !== fields.rank ||
        stats.tier !== fields.tier || stats.tierName !== fields.tierName) {
      await ref.update(fields);
      return { ...stats, ...fields };
    }
    return stats;
  }
  const init = {
    xp: 0,
    level: 1,
    rank: 0,
    tier: 0,
    tierName: SGLevels.TIERS[0].name,
    streak: 0,
    maxStreak: 0,
    lastLogin: null,
    totalQuestsCompleted: 0,
    totalReferrals: 0,
    verifiedReferrals: 0,
    overlaysCreated: 0,
    achievementsUnlocked: 0
  };
  await ref.set(init);
  return init;
}

async function checkAwardAllowed(uid, actionKey, cfg) {
  const awardsRef = admin.database().ref('nexus/users/' + uid + '/xpAwards/' + actionKey.replace(/[.#$/[\]]/g, '_'));
  const snap = await awardsRef.once('value');
  const prev = snap.val();
  const now = Date.now();

  if (cfg.once && prev && prev.count > 0) {
    throw new functions.https.HttpsError('already-exists', 'Esta acción ya otorgó XP.');
  }
  if (cfg.cooldownMs > 0 && prev && prev.lastAt && (now - prev.lastAt) < cfg.cooldownMs) {
    throw new functions.https.HttpsError('resource-exhausted', 'Cooldown activo para esta acción.');
  }
  return awardsRef;
}

function actionConfig(actionKey) {
  if (XP_ACTIONS[actionKey]) return XP_ACTIONS[actionKey];
  if (/^achievement:[a-z0-9_]+$/.test(actionKey)) return XP_ACTIONS.achievement;
  if (/^reward:[a-z0-9_]+$/.test(actionKey)) return XP_ACTIONS.reward_claim;
  return XP_ACTIONS.general;
}

async function getActiveXpBoostMultiplier(uid) {
  const snap = await admin.database().ref('nexus/users/' + uid + '/xpBoost').once('value');
  const boost = snap.val();
  if (!boost || !boost.expiresAt) return 1;
  const now = Date.now();
  const expiresAt = Number(boost.expiresAt) || 0;
  if (expiresAt <= now) return 1;
  const mult = Number(boost.multiplier) || XP_BOOST_MULTIPLIER;
  return Math.min(Math.max(mult, 1), XP_BOOST_MULTIPLIER);
}

async function applyXpGrant(uid, baseAmount, actionKey, meta) {
  const cfg = actionConfig(actionKey);
  const amount = Math.floor(Number(baseAmount) || 0);
  if (amount < 1) {
    throw new functions.https.HttpsError('invalid-argument', 'Cantidad de XP inválida.');
  }
  if (amount > cfg.max) {
    throw new functions.https.HttpsError('invalid-argument', 'XP excede el máximo permitido para esta acción.');
  }

  const awardsRef = await checkAwardAllowed(uid, actionKey, cfg);
  const statsRef = admin.database().ref('nexus/users/' + uid + '/stats');
  const beforeSnap = await statsRef.once('value');
  const beforeStats = beforeSnap.val() || {};
  // El multiplicador sale del estado ANTERIOR al grant, como siempre: si se
  // calculara después, la acción que hace subir de nivel se cobraría ya con el
  // bono nuevo y la economía daría un salto de golpe.
  const beforeXp = Number(beforeStats.xp) || 0;
  const rankMultiplier = SGLevels.xpMultiplier(SGLevels.levelFromXp(beforeXp), beforeXp);
  const boostMultiplier = await getActiveXpBoostMultiplier(uid);
  const granted = Math.floor(amount * rankMultiplier * boostMultiplier);

  const result = await statsRef.transaction((cur) => {
    const stats = cur || {
      xp: 0, level: 1, rank: 0, tier: 0, tierName: SGLevels.TIERS[0].name,
      streak: 0, maxStreak: 0,
      totalQuestsCompleted: 0, totalReferrals: 0, verifiedReferrals: 0,
      overlaysCreated: 0, achievementsUnlocked: 0, lastLogin: null
    };
    const afterXp = (Number(stats.xp) || 0) + granted;
    return {
      ...stats,
      xp: afterXp,
      ...levelFieldsFromXp(afterXp)
    };
  });

  if (!result.committed) {
    throw new functions.https.HttpsError('aborted', 'No se pudo aplicar XP.');
  }

  const newStats = result.snapshot.val() || {};
  // El nivel de partida se deduce del XP que realmente quedó tras la
  // transacción, no del que se leyó antes: si otro grant entró en medio, el
  // tramo cruzado sigue siendo el correcto y nadie se queda sin recompensa.
  const levelBefore = SGLevels.levelFromXp(Math.max(0, (Number(newStats.xp) || 0) - granted));

  await awardsRef.update({
    lastAt: admin.database.ServerValue.TIMESTAMP,
    count: admin.database.ServerValue.increment(1),
    lastAmount: granted,
    lastSource: meta && meta.source ? String(meta.source).slice(0, 120) : actionKey
  });

  await admin.database().ref('nexus/users/' + uid + '/xpLedger').push({
    actionKey,
    baseAmount: amount,
    granted,
    rankMultiplier,
    boostMultiplier: boostMultiplier > 1 ? boostMultiplier : null,
    xpAfter: Number(newStats.xp) || 0,
    levelAfter: Number(newStats.level) || 1,
    source: meta && meta.source ? String(meta.source).slice(0, 120) : '',
    at: admin.database.ServerValue.TIMESTAMP
  });

  await mirrorUserStatsFromNexus(uid, newStats);

  const levelUps = await applyLevelUpRewards(uid, levelBefore, Number(newStats.level) || 1);

  return {
    granted,
    stats: newStats,
    levelUps
  };
}

/**
 * Puerta de entrada para los triggers RTDB (misiones de Play Zone, partidas de
 * torneo), que no tienen context de llamada. Igual que applyXpGrant, lanza
 * HttpsError cuando hay tope o cooldown: quien la use dentro de un trigger
 * tiene que envolverla en try/catch para no tumbar el resto del proceso.
 */
async function grantXpInternal(uid, amount, actionKey, meta) {
  const targetUid = String(uid || '').trim();
  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID destino requerido.');
  }
  await ensureStatsNode(targetUid);
  return applyXpGrant(targetUid, amount, actionKey, meta);
}

/** Reclama recompensa de nivel Nexus con validación server-side (SEC-011). */
exports.claimNexusReward = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  const rewardId = String((data && data.rewardId) || '').trim();
  const reward = NEXUS_REWARDS[rewardId];

  if (!reward) {
    throw new functions.https.HttpsError('invalid-argument', 'Recompensa no válida.');
  }

  await ensureStatsNode(uid);
  const statsSnap = await admin.database().ref('nexus/users/' + uid + '/stats').once('value');
  const stats = statsSnap.val() || {};
  const level = Number(stats.level) || 1;

  if (level < reward.level) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Nivel insuficiente para reclamar esta recompensa.'
    );
  }

  const claimedRef = admin.database().ref('nexus/users/' + uid + '/claimedRewards/' + rewardId);
  const claimTx = await claimedRef.transaction((current) => {
    if (current !== null) return;
    return { at: admin.database.ServerValue.TIMESTAMP };
  });

  if (!claimTx.committed || !claimTx.snapshot.exists()) {
    throw new functions.https.HttpsError('already-exists', 'Esta recompensa ya fue reclamada.');
  }

  let badges = null;
  if (reward.type === 'badge') {
    const badgesRef = admin.database().ref('nexus/users/' + uid + '/badges');
    const badgesSnap = await badgesRef.once('value');
    const current = Array.isArray(badgesSnap.val()) ? badgesSnap.val() : [];
    if (!current.includes(rewardId)) {
      badges = current.concat([rewardId]);
      await badgesRef.set(badges);
    } else {
      badges = current;
    }
  }

  if (reward.type === 'theme') {
    await admin.database().ref('nexus/users/' + uid + '/settings/profileCustomizationUnlocked').set(true);
  }

  let frameUnlocked = null;
  if (reward.type === 'frame' && reward.frameId) {
    await admin.database()
      .ref('users/' + uid + '/profileCustomization/unlocked/' + reward.frameId)
      .set(true);
    frameUnlocked = reward.frameId;
  }

  let xpGranted = 0;
  let finalStats = stats;
  const xpBonus = Math.floor(Number(reward.xpBonus) || 0);
  if (xpBonus > 0) {
    const bonus = await applyXpGrant(
      uid,
      xpBonus,
      'reward:' + rewardId,
      { source: 'Recompensa: ' + rewardId }
    );
    xpGranted = bonus.granted;
    finalStats = bonus.stats || finalStats;
  }

  return {
    rewardId,
    claimedAt: Date.now(),
    xpGranted,
    stats: finalStats,
    badges,
    frameUnlocked,
    profileCustomizationUnlocked: reward.type === 'theme' ? true : undefined
  };
});

function achievementRequirementMet(type, requirement, stats, quests) {
  const req = Math.floor(Number(requirement) || 0);
  switch (type) {
    case 'quests':
      return (Number(stats.totalQuestsCompleted) || 0) >= req;
    case 'social_quests': {
      let count = 0;
      SOCIAL_QUEST_IDS.forEach(function (questId) {
        const q = quests[questId];
        if (q && q.completed) count++;
      });
      return count >= req;
    }
    case 'referrals':
      return (Number(stats.verifiedReferrals) || 0) >= req;
    case 'streak':
      return (Number(stats.streak) || 0) >= req;
    case 'daily_streak':
      return (Number(stats.maxStreak) || 0) >= req;
    case 'xp':
      return (Number(stats.xp) || 0) >= req;
    case 'rank':
      return (Number(stats.level) || 0) >= req;
    case 'overlays':
      return (Number(stats.overlaysCreated) || 0) >= req;
    default:
      return false;
  }
}

/** Evalúa y desbloquea logros Nexus con validación server-side (SEC-012). */
exports.checkNexusAchievements = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  await ensureStatsNode(uid);

  const db = admin.database();
  const baseRef = 'nexus/users/' + uid + '/';
  const statsSnap = await db.ref(baseRef + 'stats').once('value');
  const achievementsSnap = await db.ref(baseRef + 'achievements').once('value');
  const questsSnap = await db.ref(baseRef + 'quests').once('value');

  let stats = statsSnap.val() || {};
  const existing = achievementsSnap.val() || {};
  const quests = questsSnap.val() || {};
  const unlocked = [];
  const mergedAchievements = { ...existing };

  for (const achievementId of Object.keys(NEXUS_ACHIEVEMENTS)) {
    if (mergedAchievements[achievementId]) continue;

    const achievement = NEXUS_ACHIEVEMENTS[achievementId];
    if (!achievementRequirementMet(achievement.type, achievement.requirement, stats, quests)) {
      continue;
    }

    const achRef = db.ref(baseRef + 'achievements/' + achievementId);
    const achTx = await achRef.transaction((current) => {
      if (current !== null) return;
      return { unlockedAt: admin.database.ServerValue.TIMESTAMP };
    });

    if (!achTx.committed || !achTx.snapshot.exists()) continue;

    mergedAchievements[achievementId] = achTx.snapshot.val();

    const statsRef = db.ref(baseRef + 'stats');
    await statsRef.transaction((cur) => ({
      ...(cur || {}),
      achievementsUnlocked: (Number(cur && cur.achievementsUnlocked) || 0) + 1
    }));

    const statsAfterCountSnap = await statsRef.once('value');
    stats = statsAfterCountSnap.val() || stats;

    let xpGranted = 0;
    const xpAmount = Math.floor(Number(achievement.xp) || 0);
    if (xpAmount > 0) {
      const bonus = await applyXpGrant(
        uid,
        xpAmount,
        'achievement:' + achievementId,
        { source: 'Logro: ' + achievement.name }
      );
      xpGranted = bonus.granted;
      stats = bonus.stats || stats;
    }

    unlocked.push({
      id: achievementId,
      name: achievement.name,
      icon: achievement.icon,
      xp: xpAmount,
      xpGranted,
      unlockedAt: Date.now()
    });
  }

  return {
    unlocked,
    achievements: mergedAchievements,
    stats
  };
});

/** Jugador: otorga XP validado (no puede escribir stats directamente). */
exports.awardNexusXp = functions.https.onCall(async (data, context) => {
  warnMissingAppCheck(context, 'awardNexusXp');
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const uid = context.auth.uid;
  const actionKey = sanitizeActionKey(data && data.actionKey);
  const source = data && data.source ? String(data.source) : actionKey;

  if (BLOCKED_PLAYER_ACTIONS[actionKey]) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Esta acción solo puede completarse con la Cloud Function dedicada.'
    );
  }
  if (/^reward:[a-z0-9_]+$/.test(actionKey)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Las recompensas de nivel solo pueden reclamarse con claimNexusReward.'
    );
  }
  if (/^achievement:[a-z0-9_]+$/.test(actionKey)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Los logros solo pueden desbloquearse con checkNexusAchievements.'
    );
  }
  if (/^quest:[a-z0-9_]+$/.test(actionKey)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Las misiones solo pueden completarse con completeNexusQuest o su Cloud Function dedicada.'
    );
  }

  await ensureStatsNode(uid);
  return applyXpGrant(uid, data && data.amount, actionKey, { source });
});

/** Misión login diario: validación server-side + cooldown atómico (SEC-003). */
exports.completeNexusDailyLogin = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const uid = context.auth.uid;
  const provider = context.auth.token.firebase && context.auth.token.firebase.sign_in_provider;
  if (provider === 'anonymous') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Inicia sesión con tu cuenta StudiosGamesRS para reclamar el login diario.'
    );
  }

  await ensureStatsNode(uid);

  const questId = 'daily_login';
  const actionKey = 'quest:daily_login';
  const cfg = XP_ACTIONS[actionKey];
  const questRef = admin.database().ref('nexus/users/' + uid + '/quests/' + questId);
  const questSnap = await questRef.once('value');
  const questData = questSnap.val() || {};
  const now = Date.now();

  if (questData.lastCompleted && (now - Number(questData.lastCompleted)) < cfg.cooldownMs) {
    throw new functions.https.HttpsError('resource-exhausted', 'Ya reclamaste el login diario hoy.');
  }

  const bonus = await applyXpGrant(uid, cfg.max, actionKey, { source: 'Inicio Diario' });

  const newQuest = {
    completed: true,
    lastCompleted: now,
    count: (Number(questData.count) || 0) + 1
  };
  await questRef.set(newQuest);

  const statsRef = admin.database().ref('nexus/users/' + uid + '/stats');
  let finalStats = bonus.stats || {};
  await statsRef.transaction((cur) => {
    const stats = cur || {};
    finalStats = {
      ...stats,
      totalQuestsCompleted: (Number(stats.totalQuestsCompleted) || 0) + 1
    };
    return finalStats;
  });
  await mirrorUserStatsFromNexus(uid, finalStats);

  return {
    granted: bonus.granted,
    stats: finalStats,
    quest: newQuest
  };
});

/** Completa misión Nexus con cooldown/once validados server-side (SEC-013). */
exports.completeNexusQuest = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  const questId = String((data && data.questId) || '').trim();

  if (questId === 'daily_login') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Usa completeNexusDailyLogin para el login diario.'
    );
  }
  if (questId === 'create_overlay') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Usa completeNexusOverlayUpload para crear overlay.'
    );
  }

  const questMeta = NEXUS_QUESTS[questId];
  const actionKey = 'quest:' + questId;
  const cfg = XP_ACTIONS[actionKey];
  if (!questMeta || !cfg) {
    throw new functions.https.HttpsError('invalid-argument', 'Misión no válida.');
  }

  await ensureStatsNode(uid);

  const questRef = admin.database().ref('nexus/users/' + uid + '/quests/' + questId);
  const questSnap = await questRef.once('value');
  const questData = questSnap.val() || {};
  const now = Date.now();

  if (cfg.once && (questData.completed || (Number(questData.count) || 0) > 0)) {
    throw new functions.https.HttpsError('already-exists', 'Esta misión ya fue completada.');
  }
  if (questData.lastCompleted && cfg.cooldownMs > 0) {
    const elapsed = now - Number(questData.lastCompleted);
    if (elapsed < cfg.cooldownMs) {
      throw new functions.https.HttpsError('resource-exhausted', 'La misión aún está en cooldown.');
    }
  }

  const bonus = await applyXpGrant(uid, cfg.max, actionKey, { source: questMeta.title });
  const newQuest = {
    completed: true,
    lastCompleted: now,
    count: (Number(questData.count) || 0) + 1
  };
  await questRef.set(newQuest);

  const statsRef = admin.database().ref('nexus/users/' + uid + '/stats');
  let finalStats = bonus.stats || {};
  await statsRef.transaction((cur) => {
    const stats = cur || {};
    finalStats = {
      ...stats,
      totalQuestsCompleted: (Number(stats.totalQuestsCompleted) || 0) + 1
    };
    return finalStats;
  });
  await mirrorUserStatsFromNexus(uid, finalStats);

  return {
    granted: bonus.granted,
    stats: finalStats,
    quest: newQuest
  };
});

/** Subida de overlay en Branding Studio: contador + misión create_overlay (SEC-004/013). */
exports.completeNexusOverlayUpload = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  requireOverlayCanvas(data);
  await ensureStatsNode(uid);

  const now = Date.now();
  const activityRef = admin.database().ref('nexus/users/' + uid + '/overlayActivity');
  const statsRef = admin.database().ref('nexus/users/' + uid + '/stats');
  const lastSnap = await activityRef.child('lastUploadAt').once('value');
  const lastUpload = Number(lastSnap.val()) || 0;
  const canCountUpload = !lastUpload || (now - lastUpload) >= OVERLAY_UPLOAD_COOLDOWN_MS;

  let finalStats = (await statsRef.once('value')).val() || {};

  if (canCountUpload) {
    await statsRef.transaction((cur) => {
      const stats = cur || {};
      finalStats = {
        ...stats,
        overlaysCreated: (Number(stats.overlaysCreated) || 0) + 1
      };
      return finalStats;
    });
    await activityRef.update({ lastUploadAt: now });
  }

  await activityRef.child('uploads').push({ at: now, counted: canCountUpload });

  const questId = 'create_overlay';
  const questRef = admin.database().ref('nexus/users/' + uid + '/quests/' + questId);
  const questData = (await questRef.once('value')).val() || {};
  let questResult = null;
  let questXpGranted = 0;

  if (!questData.completed && !questData.lastCompleted) {
    const cfg = XP_ACTIONS['quest:create_overlay'];
    const bonus = await applyXpGrant(uid, cfg.max, 'quest:create_overlay', { source: 'Crear Overlay' });
    questXpGranted = bonus.granted;

    questResult = { completed: true, lastCompleted: now, count: 1 };
    await questRef.set(questResult);

    await statsRef.transaction((cur) => {
      const stats = cur || {};
      finalStats = {
        ...stats,
        totalQuestsCompleted: (Number(stats.totalQuestsCompleted) || 0) + 1
      };
      return finalStats;
    });
  }

  await mirrorUserStatsFromNexus(uid, finalStats);

  return {
    stats: finalStats,
    quest: questResult,
    questXpGranted,
    overlaysIncremented: canCountUpload
  };
});

/** Activa sesión de Branding Studio tras subir imagen (SEC-015). */
exports.registerBrandingStudioSession = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  const now = Date.now();
  const activityRef = admin.database().ref('nexus/users/' + uid + '/overlayActivity');
  const lastRegSnap = await activityRef.child('lastSessionRegAt').once('value');
  const lastReg = Number(lastRegSnap.val()) || 0;

  if (lastReg && (now - lastReg) < BRANDING_SESSION_REG_COOLDOWN_MS) {
    const sessSnap = await activityRef.child('activeSession').once('value');
    const existing = sessSnap.val();
    if (existing && Number(existing.expiresAt) > now) {
      return { session: existing, extended: false };
    }
  }

  const session = {
    startedAt: now,
    expiresAt: now + BRANDING_SESSION_MS
  };
  await activityRef.update({
    activeSession: session,
    lastSessionRegAt: now
  });
  return { session, extended: true };
});

/** XP por exportar overlay — cooldown server-side (SEC-004/015). */
exports.claimOverlayDownloadXp = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  await ensureStatsNode(uid);

  const bonus = await applyBrandingXpGrant(uid, 'download_overlay', { source: 'Descargar overlay' });

  await admin.database().ref('nexus/users/' + uid + '/overlayActivity/downloads').push({
    at: admin.database.ServerValue.TIMESTAMP
  });

  return { granted: bonus.granted, stats: bonus.stats };
});

/** XP por compartir overlay — solo tras share/clipboard real (SEC-005/015). */
exports.claimOverlayShareXp = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  const method = String(data && data.shareMethod || '').trim();
  if (method !== 'web_share' && method !== 'clipboard') {
    throw new functions.https.HttpsError('invalid-argument', 'Método de compartir inválido.');
  }

  await ensureStatsNode(uid);
  const bonus = await applyBrandingXpGrant(uid, 'share_overlay', { source: 'Compartir overlay' });

  await admin.database().ref('nexus/users/' + uid + '/overlayActivity/shares').push({
    at: admin.database.ServerValue.TIMESTAMP,
    method
  });

  return { granted: bonus.granted, stats: bonus.stats };
});

/** XP por generar overlay con IA — rate limit server-side (SEC-015). */
exports.claimOverlayGenerateAiXp = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  await ensureStatsNode(uid);

  const bonus = await applyBrandingXpGrant(uid, 'generate_ai', { source: 'Generar con IA' });

  return { granted: bonus.granted, stats: bonus.stats };
});

/** XP por aplicar sugerencia IA en el canvas (SEC-015). */
exports.claimOverlayUseAiXp = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  await ensureStatsNode(uid);

  const bonus = await applyBrandingXpGrant(uid, 'use_ai', { source: 'Usar IA' });

  return { granted: bonus.granted, stats: bonus.stats };
});

/** XP por análisis de diseño con IA — rate limit server-side (SEC-015). */
exports.claimOverlayAnalyzeDesignXp = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  await ensureStatsNode(uid);

  const bonus = await applyBrandingXpGrant(uid, 'analyze_design', { source: 'Análisis de diseño' });

  await admin.database().ref('nexus/users/' + uid + '/overlayActivity/analyses').push({
    at: admin.database.ServerValue.TIMESTAMP
  });

  return { granted: bonus.granted, stats: bonus.stats };
});

/** Commander/Boss: otorga boost x2 temporal de XP Nexus (SEC-006). */
exports.grantNexusXpBoostCommander = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const actorUid = context.auth.uid;
  const rango = await readStaffRango(actorUid);
  if (!isStaff(rango)) {
    throw new functions.https.HttpsError('permission-denied', 'Solo Commanders pueden otorgar boost Nexus.');
  }

  const targetUid = String(data && data.targetUid || '').trim();
  const reason = String(data && data.reason || '').trim();
  const durationMinutes = Math.floor(Number(data && data.durationMinutes) || 60);

  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID destino requerido.');
  }
  if (targetUid === actorUid) {
    throw new functions.https.HttpsError('permission-denied', 'No puedes otorgarte boost Nexus a ti mismo.');
  }
  if (!reason) {
    throw new functions.https.HttpsError('invalid-argument', 'Motivo obligatorio.');
  }

  const durationMs = Math.min(
    XP_BOOST_MAX_MS,
    Math.max(XP_BOOST_MIN_MS, durationMinutes * 60000 || XP_BOOST_DEFAULT_MS)
  );
  const now = Date.now();
  const expiresAt = now + durationMs;

  await ensureStatsNode(targetUid);

  const actorNickSnap = await admin.database().ref('users/' + actorUid + '/nick').once('value');
  const actorNick = actorNickSnap.val() || 'Commander';

  await admin.database().ref('nexus/users/' + targetUid + '/xpBoost').set({
    multiplier: XP_BOOST_MULTIPLIER,
    expiresAt,
    grantedAt: now,
    durationMs,
    reason,
    byUid: actorUid,
    byNick: actorNick
  });

  await admin.database().ref('nexus/users/' + targetUid + '/commanderGrants').push({
    type: 'nexus_xp_boost',
    multiplier: XP_BOOST_MULTIPLIER,
    durationMs,
    expiresAt,
    reason,
    byUid: actorUid,
    byNick: actorNick,
    at: admin.database.ServerValue.TIMESTAMP
  });

  return {
    targetUid,
    multiplier: XP_BOOST_MULTIPLIER,
    expiresAt,
    durationMs
  };
});

/** Solo Boss of the State: otorga XP a otro usuario (SEC-023). */
exports.grantNexusXpCommander = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const actorUid = context.auth.uid;
  const rango = await readStaffRango(actorUid);
  if (!isBossOfTheState(rango)) {
    throw new functions.https.HttpsError('permission-denied', 'Solo Boss of the State puede otorgar XP Nexus.');
  }

  const targetUid = String(data && data.targetUid || '').trim();
  const reason = String(data && data.reason || '').trim();
  const amount = Math.floor(Math.abs(Number(data && data.amount) || 0));

  const selfGrant = targetUid === actorUid;

  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID destino requerido.');
  }
  if (!reason) {
    throw new functions.https.HttpsError('invalid-argument', 'Motivo obligatorio.');
  }
  if (amount < 1) {
    throw new functions.https.HttpsError('invalid-argument', 'Cantidad de XP inválida.');
  }
  // El tope por entrega y el presupuesto diario protegen a los demás jugadores
  // de una cuenta de staff comprometida; sobre su propia cuenta el Boss decide.
  if (selfGrant) {
    if (amount > MAX_SELF_GRANT_XP) {
      throw new functions.https.HttpsError('invalid-argument', 'Cantidad de XP demasiado grande para almacenarse.');
    }
  } else {
    if (amount > MAX_COMMANDER_GRANT) {
      throw new functions.https.HttpsError('invalid-argument', 'Cantidad fuera de rango (máx. ' + MAX_COMMANDER_GRANT + ' por entrega).');
    }
    await consumeBossDailyNexusXpBudget(actorUid, amount);
  }

  await ensureStatsNode(targetUid);
  const statsRef = admin.database().ref('nexus/users/' + targetUid + '/stats');
  const beforeSnap = await statsRef.once('value');
  const beforeXp = Number((beforeSnap.val() || {}).xp) || 0;

  const result = await statsRef.transaction((cur) => {
    const stats = cur || {};
    const afterXp = (Number(stats.xp) || 0) + amount;
    return {
      ...stats,
      xp: afterXp,
      ...levelFieldsFromXp(afterXp)
    };
  });

  if (!result.committed) {
    throw new functions.https.HttpsError('aborted', 'No se pudo otorgar XP.');
  }

  const newStats = result.snapshot.val() || {};
  const afterXp = Number(newStats.xp) || 0;
  const granted = afterXp - beforeXp;
  const lr = levelFieldsFromXp(afterXp);
  const levelBefore = SGLevels.levelFromXp(Math.max(0, afterXp - amount));

  const actorNickSnap = await admin.database().ref('users/' + actorUid + '/nick').once('value');
  const actorNick = actorNickSnap.val() || 'Commander';

  await admin.database().ref('nexus/users/' + targetUid + '/commanderGrants').push({
    type: 'nexus_xp',
    amount,
    xpBefore: beforeXp,
    xpAfter: afterXp,
    levelAfter: lr.level,
    reason,
    self: selfGrant,
    byUid: actorUid,
    byNick: actorNick,
    at: admin.database.ServerValue.TIMESTAMP
  });

  await appendNexusXpGrantAudit(actorUid, actorNick, targetUid, amount, reason, selfGrant);

  await mirrorUserStatsFromNexus(targetUid, newStats);

  const levelUps = await applyLevelUpRewards(targetUid, levelBefore, lr.level);

  return {
    granted: amount,
    stats: newStats,
    level: lr.level,
    tier: lr.tier,
    tierName: lr.tierName,
    levelUps,
    afterXp
  };
});

/** Bonificación al referidor cuando un nuevo usuario valida referido. */
exports.awardReferralBonus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const newUid = context.auth.uid;
  const refCode = String(data && data.refCode || '').trim().toUpperCase();
  if (!refCode || !/^NEXUS-[A-Z0-9]{1,12}$/.test(refCode)) {
    throw new functions.https.HttpsError('invalid-argument', 'Código de referido inválido.');
  }

  const refSnap = await admin.database().ref('refCodes/' + refCode).once('value');
  const referrerUid = refSnap.val();
  if (!referrerUid || referrerUid === newUid) {
    throw new functions.https.HttpsError('failed-precondition', 'Referido no válido.');
  }

  const lockRef = admin.database().ref('nexus/referralLocks/' + newUid);
  const lockSnap = await lockRef.once('value');
  if (lockSnap.exists()) {
    throw new functions.https.HttpsError('already-exists', 'Referido ya procesado.');
  }

  await lockRef.set({
    referrerUid,
    refCode,
    at: admin.database.ServerValue.TIMESTAMP
  });

  await admin.database().ref('nexus/referrals/' + referrerUid + '/' + newUid).set({
    userId: newUid,
    date: admin.database.ServerValue.TIMESTAMP,
    verified: true
  });

  const newUserSnap = await admin.database().ref('users/' + newUid).once('value');
  const newUser = newUserSnap.val() || {};
  await admin.database().ref('users/' + referrerUid + '/referrals/' + newUid).set({
    nick: newUser.nick || newUser.displayName || newUid,
    timestamp: admin.database.ServerValue.TIMESTAMP
  });

  await ensureStatsNode(referrerUid);
  const bonus = await applyXpGrant(referrerUid, XP_ACTIONS.referral_bonus.max, 'referral_bonus', {
    source: 'Referido: ' + newUid
  });

  await statsRefBumpReferrals(referrerUid);

  return { referrerUid, bonus };
});

async function statsRefBumpReferrals(referrerUid) {
  const statsRef = admin.database().ref('nexus/users/' + referrerUid + '/stats');
  let updated = null;
  await statsRef.transaction((cur) => {
    const stats = cur || {};
    updated = {
      ...stats,
      totalReferrals: (Number(stats.totalReferrals) || 0) + 1,
      verifiedReferrals: (Number(stats.verifiedReferrals) || 0) + 1
    };
    return updated;
  });
  if (updated) await mirrorUserStatsFromNexus(referrerUid, updated);
}

/** Procesa racha diaria y lastLogin server-side (SEC-014). Una vez por día UTC. */
exports.processNexusDailyStreak = functions.https.onCall(async (data, context) => {
  const uid = requireDashboardUser(context);
  await ensureStatsNode(uid);

  const now = Date.now();
  const todayKey = utcDayKey(now);
  const baseRef = 'nexus/users/' + uid + '/';
  const procRef = admin.database().ref(baseRef + 'dailyStreak/lastProcessedDay');
  const procTx = await procRef.transaction((current) => {
    if (current === todayKey) return;
    return todayKey;
  });

  const statsRef = admin.database().ref(baseRef + 'stats');
  const statsSnap = await statsRef.once('value');
  let stats = statsSnap.val() || {};

  if (!procTx.committed || procTx.snapshot.val() !== todayKey) {
    return {
      alreadyProcessed: true,
      stats,
      streakBonus: 0,
      xpGranted: 0
    };
  }

  const lastLogin = stats.lastLogin != null ? Number(stats.lastLogin) : 0;
  let streak = Number(stats.streak) || 0;
  let maxStreak = Number(stats.maxStreak) || 0;
  let streakBonus = 0;

  if (lastLogin > 0) {
    const daysSince = Math.floor((now - lastLogin) / 86400000);
    if (daysSince === 1) {
      streak += 1;
      if (streak > maxStreak) maxStreak = streak;
      const idx = Math.min(streak, STREAK_BONUS.length - 1);
      streakBonus = STREAK_BONUS[idx] || 0;
    } else if (daysSince > 1) {
      streak = 0;
    }
  }

  stats = {
    ...stats,
    streak,
    maxStreak,
    lastLogin: now
  };
  await statsRef.update({
    streak,
    maxStreak,
    lastLogin: now
  });
  await procRef.set(todayKey);
  await admin.database().ref(baseRef + 'dailyStreak/lastVisitAt').set(admin.database.ServerValue.TIMESTAMP);
  await mirrorUserStatsFromNexus(uid, stats);

  let xpGranted = 0;
  if (streakBonus > 0) {
    const bonus = await applyXpGrant(uid, streakBonus, 'streak_bonus', {
      source: 'Racha de ' + streak + ' días'
    });
    xpGranted = bonus.granted;
    stats = bonus.stats || stats;
  }

  return {
    alreadyProcessed: false,
    stats,
    streak,
    maxStreak,
    streakBonus,
    xpGranted
  };
});

/** Actualiza campos de stats NO sensibles (streak, lastLogin, contadores). */
exports.syncNexusActivityStats = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const uid = context.auth.uid;
  await ensureStatsNode(uid);

  throw new functions.https.HttpsError(
    'failed-precondition',
    'Usa processNexusDailyStreak para racha y lastLogin. Esta función ya no acepta escrituras del cliente.'
  );
});

/** Campos de perfil que viven en users/stats y no deben borrarse al sincronizar Nexus. */
const USER_STATS_PRESERVE_KEYS = [
  'nexusTrumpetHelps',
  'trumpetHelps',
  'battleCallHelps',
  'helpedBattleCalls',
  'contributions'
];

/** Espejo server-side: nexus/users/{uid}/stats → users/{uid}/stats (SEC-002). */
async function mirrorUserStatsFromNexus(uid, nexusStats) {
  if (!uid || !nexusStats) return;
  const userStatsRef = admin.database().ref('users/' + uid + '/stats');
  const existingSnap = await userStatsRef.once('value');
  const existing = existingSnap.val() || {};

  // El nivel del espejo se recalcula desde el XP en vez de copiarse: así las
  // cuentas que todavía tengan el nivel viejo (1–5) guardado se corrigen solas
  // en users/stats, que es de donde lee el resto del sitio.
  const xp = Number(nexusStats.xp) || 0;
  const fields = levelFieldsFromXp(xp);

  const mirror = {
    xp,
    level: fields.level,
    rank: fields.rank,
    tier: fields.tier,
    tierName: fields.tierName,
    streak: Number(nexusStats.streak) || 0,
    maxStreak: Number(nexusStats.maxStreak) || 0,
    lastLogin: nexusStats.lastLogin != null ? nexusStats.lastLogin : null,
    totalQuestsCompleted: Number(nexusStats.totalQuestsCompleted) || 0,
    totalReferrals: Number(nexusStats.totalReferrals) || 0,
    verifiedReferrals: Number(nexusStats.verifiedReferrals) || 0,
    overlaysCreated: Number(nexusStats.overlaysCreated) || 0,
    achievementsUnlocked: Number(nexusStats.achievementsUnlocked) || 0,
    syncedFrom: 'nexus',
    syncedAt: admin.database.ServerValue.TIMESTAMP
  };

  USER_STATS_PRESERVE_KEYS.forEach((key) => {
    if (existing[key] != null) mirror[key] = existing[key];
  });

  await userStatsRef.update(mirror);
}

/** RTDB trigger: cualquier cambio en Nexus stats actualiza el espejo en users/stats. */
exports.onNexusStatsUpdated = functions.database
  .ref('nexus/users/{uid}/stats')
  .onWrite(async (change, context) => {
    const after = change.after.val();
    if (!after) return null;
    await mirrorUserStatsFromNexus(context.params.uid, after);
    return null;
  });

/** Helpers para otros módulos del servidor (no son Cloud Functions). */
exports.grantXpInternal = grantXpInternal;
exports.applyLevelUpRewards = applyLevelUpRewards;
exports.levelFieldsFromXp = levelFieldsFromXp;
exports.XP_ACTIONS = XP_ACTIONS;
