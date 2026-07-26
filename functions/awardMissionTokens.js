/**
 * PlayZone — Sistema de premios en garantía (escrow) para misiones
 * ================================================================
 * Modelo de "premio retenido", 100% en servidor (seguro):
 *
 *   1) CREAR misión  -> escrowMissionPrize:  RETIENE (descuenta) el premio del
 *                       creador y lo deja "en garantía" (escrowStatus = 'held').
 *   2) COMPLETAR      -> awardMissionTokens:  cuando TODO el equipo confirma y se
 *                       cumplen los requisitos, PAGA el premio a los jugadores y
 *                       guarda un registro PERMANENTE en el historial de cada uno.
 *   3) BORRAR/CANCELAR-> refundMissionEscrow: si la misión se borra ANTES de
 *                       pagarse (p. ej. alguien nunca llegó), REEMBOLSA al creador.
 *
 * El saldo de tokens SOLO lo escribe este servidor (las reglas bloquean al cliente).
 *
 * === Instalación ===
 * En functions/index.js:
 *   const m = require('./awardMissionTokens');
 *   exports.escrowMissionPrize = m.escrowMissionPrize;
 *   exports.awardMissionTokens = m.awardMissionTokens;
 *   exports.refundMissionEscrow = m.refundMissionEscrow;
 * Desplegar:
 *   firebase deploy --only functions:escrowMissionPrize,functions:awardMissionTokens,functions:refundMissionEscrow
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

// ======================= CONFIGURACIÓN =======================
const HARD_CAP = 5;                    // Máximo absoluto de tokens de premio por misión (estándar).
const CS2_FRIENDS_REWARD_PER_PLAYER = 5;
const MAX_REWARD_PER_PLAYER = 5;         // Tope por jugador sin boost de Commander.
const MAX_BOOSTED_REWARD_PER_PLAYER = 50; // Tope por jugador con boost de Commander verificado.

// PZ-002: los premios ya no se crean de la nada. Salen de una bolsa patrocinada
// finita y están limitados por un cupo diario de tokens por jugador.
const DAILY_MISSION_TOKEN_CAP = 25;      // Tokens de misiones por jugador y día.
const BUDGET_PATH = 'playzoneRewardBudget';
const BUDGET_INITIAL = 5000;             // Saldo inicial al sembrar la bolsa por primera vez.

// PZ-004: solo se paga una misión que llegó a jugarse. 'pending' nunca arrancó y
// cualquier otro estado queda fuera del ciclo de vida legítimo.
const PAYABLE_STATUSES = { active: true, finished: true };
const CS2_FRIENDS_MAX_ESCROW = 50;   // Hasta 10 jugadores × 5 tokens
const MIN_PARTICIPANTS_FOR_REWARD = 2; // Se necesita al menos 2 jugadores para pagar.
const TIME_GATE_FACTOR = 0.5;          // Debe pasar al menos la mitad del tiempo estimado.

// ======================= ESTIMADOR (igual que playzone-smart.js) =======================
const BASE_BY_TYPE = {
  ranked: 40, competitivo: 40, cooperativo: 35, coop: 35, evento: 50, torneo: 60, casual: 25,
  friends: 40, amigos: 40
};
const DEFAULT_BASE = 30;
const GAME_FACTOR = {
  'league of legends': 1.30, lol: 1.30, 'dota 2': 1.35, 'counter-strike 2': 1.20, cs2: 1.20,
  'counter strike': 1.20, valorant: 1.15, 'apex legends': 1.10, fortnite: 1.00, 'call of duty': 1.00,
  warzone: 1.05, 'rocket league': 0.70, 'overwatch 2': 1.00, overwatch: 1.00, battlefield: 1.10,
  'gta v': 1.00, 'grand theft auto v': 1.00, minecraft: 1.20, pubg: 1.10, 'rainbow six siege': 1.15,
  r6: 1.15, fifa: 0.80, 'ea sports fc': 0.80
};
const SKILL_FACTOR = {
  principiante: 0.90, novato: 0.90, intermedio: 1.00, avanzado: 1.15, pro: 1.25, experto: 1.25
};

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function isCs2FriendsMission(m) {
  return m && m.verificationMode === 'cs2_steam';
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function roundTo5(n) { return Math.round(n / 5) * 5; }

function estimate(mission) {
  mission = mission || {};
  const base = BASE_BY_TYPE[norm(mission.type)] || DEFAULT_BASE;
  const gameF = GAME_FACTOR[norm(mission.game)] || 1.0;
  const skillF = SKILL_FACTOR[norm(mission.skill)] || 1.0;
  let players = parseInt(mission.maxParticipants, 10);
  if (!players || players < 1) players = 5;
  const playersF = 1 + clamp((players - 2) * 0.03, -0.06, 0.30);
  const estMinutes = clamp(roundTo5(base * gameF * skillF * playersF), 10, 180);
  let tokenCap = clamp(Math.ceil(estMinutes / 40), 1, HARD_CAP);
  return { estMinutes, tokenCap };
}

function normRango(r) {
  return String(r == null ? '' : r).trim().toLowerCase().replace(/\s+/g, '_');
}

function isCommanderRango(r) {
  const n = normRango(r);
  return n === 'commander' || n === 'boss_of_the_state';
}

/**
 * PZ-001: el cliente puede colar rewardPerPlayer al crear la misión, porque el
 * .write de commander del campo queda anulado por la cascada de reglas RTDB.
 * El premio real se decide aquí: solo se supera el tope estándar si la misión
 * lleva un boost cuyo autor tiene rango Commander/Boss comprobado en users.
 */
async function resolveRewardPerPlayer(mission) {
  const requested = parseInt(mission && mission.rewardPerPlayer, 10) || CS2_FRIENDS_REWARD_PER_PLAYER;
  if (requested <= MAX_REWARD_PER_PLAYER) return clamp(requested, 1, MAX_REWARD_PER_PLAYER);

  const boostBy = mission && mission.commanderRewardBoostBy;
  if (mission && mission.commanderRewardBoost === true && typeof boostBy === 'string' && boostBy) {
    try {
      const snap = await admin.database().ref('users/' + boostBy + '/rango').once('value');
      if (isCommanderRango(snap.val())) {
        return clamp(requested, 1, MAX_BOOSTED_REWARD_PER_PLAYER);
      }
    } catch (e) {
      console.error('[reward] no se pudo verificar el rango de ' + boostBy, e);
    }
  }

  console.warn('[reward] rewardPerPlayer ' + requested + ' sin boost válido: recortado a ' + MAX_REWARD_PER_PLAYER);
  return MAX_REWARD_PER_PLAYER;
}

/**
 * PZ-003: la única marca de inicio fiable es startedAt, porque las reglas solo
 * dejan escribirla al creador y la obligan a caer dentro de ±60 s del momento
 * real, así que no se puede antedatar. schedule y createdAt los manda el cliente
 * sin ninguna validación, de modo que servían para saltarse la espera (createdAt
 * antiguo) o para anularla del todo (omitir los tres campos).
 */
function getStartTime(mission) {
  if (!mission) return null;
  if (typeof mission.startedAt === 'number') return mission.startedAt;
  return null;
}

function dayKey(ts) {
  return new Date(typeof ts === 'number' ? ts : Date.now()).toISOString().slice(0, 10);
}

function dailyRef(uid) {
  return admin.database().ref('tokenAwardsDaily/' + uid + '/' + dayKey());
}

/**
 * Reserva parte del cupo diario del jugador. Devuelve cuánto se pudo reservar,
 * que puede ser menos de lo pedido (o 0 si ya agotó el cupo del día).
 */
async function consumeDailyAllowance(uid, want) {
  if (!uid || want <= 0) return 0;
  let granted = 0;
  const res = await dailyRef(uid).transaction((cur) => {
    const used = Number(cur) || 0;
    const room = Math.max(0, DAILY_MISSION_TOKEN_CAP - used);
    granted = Math.min(want, room);
    if (granted <= 0) return; // aborta: sin cupo disponible hoy
    return used + granted;
  });
  return res.committed ? granted : 0;
}

/** Devuelve al cupo diario lo que al final no se pagó (p. ej. bolsa agotada). */
async function releaseDailyAllowance(uid, amount) {
  if (!uid || amount <= 0) return;
  try {
    await dailyRef(uid).transaction((cur) => Math.max(0, (Number(cur) || 0) - amount));
  } catch (e) {
    console.error('[budget] no se pudo liberar cupo de ' + uid, e);
  }
}

/**
 * Descuenta de la bolsa patrocinada global. Devuelve cuánto se pudo retirar
 * realmente: 0 si está agotada. La bolsa se siembra la primera vez.
 */
async function consumeBudget(want) {
  if (want <= 0) return 0;
  let taken = 0;
  const res = await admin.database().ref(BUDGET_PATH + '/remaining').transaction((cur) => {
    const remaining = (cur === null || cur === undefined) ? BUDGET_INITIAL : (Number(cur) || 0);
    taken = Math.min(want, Math.max(0, remaining));
    return remaining - taken;
  });
  if (!res.committed) return 0;
  if (taken > 0) {
    try {
      await admin.database().ref(BUDGET_PATH).update({
        updatedAt: admin.database.ServerValue.TIMESTAMP,
        totalGranted: admin.database.ServerValue.increment(taken)
      });
    } catch (e) {
      console.error('[budget] no se pudo actualizar el acumulado', e);
    }
  }
  return taken;
}

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
      source: 'awardMissionTokens',
      missionId: meta && meta.missionId ? meta.missionId : null,
      byUid: 'system',
      byNick: 'PlayZone'
    });
  } catch (e) {
    console.error('[creditTokens] ledger', uid, e);
  }
}

// Registro PERMANENTE en el historial del jugador (sobrevive aunque se borre la misión).
async function writeMissionHistory(uid, mission, missionId) {
  const rec = {
    at: (typeof mission.nexusVerifiedComplete === 'number') ? mission.nexusVerifiedComplete : Date.now(),
    title: mission.title || 'Misión',
    type: isCs2FriendsMission(mission) ? 'CS2 con amigos' : 'Misión Nexus',
    game: mission.game || '',
    missionId: missionId
  };
  await admin.database().ref(`users/${uid}/extraVerifiedMatches/${missionId}`).set(rec);
}

// ============================================================================
// 1) CREAR MISIÓN -> Sin costo (creación gratuita; premios al completar vía servidor)
// ============================================================================
exports.escrowMissionPrize = functions.database
  .ref('/missions/{missionId}')
  .onCreate(async (snap, context) => {
    const m = snap.val();
    if (!m || !m.creatorUid) return null;

    const claim = await snap.ref.child('escrowStatus').transaction((cur) => {
      if (cur) return;
      return 'processing';
    });
    if (!claim.committed) return null;

    const updates = {
      tokenPrize: 0,
      escrow: 0,
      escrowStatus: 'none',
      sponsoredReward: true,
      rewardPerPlayer: await resolveRewardPerPlayer(m)
    };

    await snap.ref.update(updates);
    console.log(`[escrow] ${context.params.missionId}: misión creada sin costo.`);
    return null;
  });

// ============================================================================
// 2) COMPLETAR MISIÓN -> PAGAR A LOS JUGADORES + GUARDAR HISTORIAL
// ============================================================================
exports.awardMissionTokens = functions.database
  .ref('/missions/{missionId}')
  .onUpdate(async (change, context) => {
    const missionId = context.params.missionId;
    const after = change.after.val();

    if (!after || !after.participants) return null;
    if (after.tokensAwarded) return null; // ya procesado (idempotencia)

    // --- PZ-004: la misión debe estar en un estado que admita pago ---
    const status = String(after.status || '').trim().toLowerCase();
    if (!PAYABLE_STATUSES[status]) {
      console.warn(`[award] ${missionId}: estado "${status || 'sin estado'}" no admite pago.`);
      return null;
    }

    // --- ¿confirmaron TODOS? ---
    const participants = after.participants || {};
    const pIds = Object.keys(participants);
    const conf = after.completionConfirmations || {};
    const allConfirmed = pIds.length > 0 && pIds.every((id) => conf[id] === true);
    if (!allConfirmed) return null;

    // --- mínimo de participantes ---
    if (pIds.length < MIN_PARTICIPANTS_FOR_REWARD) return null;

    // --- tiempo mínimo transcurrido ---
    const est = estimate(after);
    const start = getStartTime(after);
    const requiredMs = Math.round(est.estMinutes * TIME_GATE_FACTOR) * 60 * 1000;
    if (start == null) {
      console.warn(`[award] ${missionId}: sin startedAt verificable (la misión nunca se inició). Sin pago.`);
      return null;
    }
    if ((Date.now() - start) < requiredMs) {
      console.warn(`[award] ${missionId}: tiempo mínimo no cumplido. Sin pago aún.`);
      return null;
    }

    // --- RESERVA idempotente del pago ---
    const claim = await change.after.ref.child('tokensAwarded').transaction((cur) => {
      if (cur) return; // ya reclamado
      return true;
    });
    if (!claim.committed) return null;

    // --- Reparto: cupo diario del jugador + bolsa patrocinada global (PZ-002) ---
    const payouts = {};
    const perPlayer = await resolveRewardPerPlayer(after);
    const recipients = pIds.slice();
    let prize = 0;
    let capped = false;

    for (const uid of recipients) {
      // 1) ¿Le queda cupo diario a este jugador?
      const allowance = await consumeDailyAllowance(uid, perPlayer);
      if (allowance <= 0) {
        payouts[uid] = 0;
        capped = true;
        console.warn(`[award] ${missionId}: ${uid} agotó su cupo diario. Sin pago.`);
        continue;
      }

      // 2) ¿Hay saldo en la bolsa patrocinada?
      const funded = await consumeBudget(allowance);
      if (funded < allowance) {
        await releaseDailyAllowance(uid, allowance - funded);
        capped = true;
      }
      if (funded <= 0) {
        payouts[uid] = 0;
        console.warn(`[award] ${missionId}: bolsa patrocinada agotada. ${uid} sin pago.`);
        continue;
      }

      await creditTokens(uid, funded, {
        type: 'mission_reward',
        reason: 'Premio misión: ' + (after.title || missionId),
        missionId
      });
      payouts[uid] = funded;
      prize += funded;
    }

    // --- Historial PERMANENTE para TODOS los participantes ---
    for (const uid of pIds) {
      try { await writeMissionHistory(uid, after, missionId); } catch (e) { console.error('history', uid, e); }
    }

    // --- Sellar la misión ---
    await change.after.ref.update({
      nexusVerifiedComplete: after.nexusVerifiedComplete || admin.database.ServerValue.TIMESTAMP,
      escrowStatus: prize > 0 ? 'sponsored' : (after.escrowStatus || 'none'),
      awardedAmount: prize,
      awardedPayouts: payouts,
      awardedCapped: capped,
      estMinutes: est.estMinutes,
      awardedAt: admin.database.ServerValue.TIMESTAMP
    });

    console.log(`[award] ${missionId}: pagados ${prize} tokens${capped ? ' (recortado por cupo o bolsa)' : ''}.`, payouts);
    return null;
  });

// ============================================================================
// 2b) BOLSA PATROCINADA -> consultar y recargar (solo Commander / Boss)
// ============================================================================
const MAX_BUDGET_REFILL = 100000;

async function requireCommander(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  const snap = await admin.database().ref('users/' + context.auth.uid + '/rango').once('value');
  if (!isCommanderRango(snap.val())) {
    throw new functions.https.HttpsError('permission-denied', 'Solo Commander o Boss of the State.');
  }
  return context.auth.uid;
}

/** Estado de la bolsa: saldo restante, total repartido y última recarga. */
exports.getPlayzoneRewardBudget = functions.https.onCall(async (data, context) => {
  await requireCommander(context);
  const snap = await admin.database().ref(BUDGET_PATH).once('value');
  const b = snap.val() || {};
  return {
    remaining: (b.remaining === null || b.remaining === undefined) ? BUDGET_INITIAL : Number(b.remaining) || 0,
    totalGranted: Number(b.totalGranted) || 0,
    dailyCapPerPlayer: DAILY_MISSION_TOKEN_CAP,
    lastRefillAt: b.lastRefillAt || null,
    lastRefillByNick: b.lastRefillByNick || null,
    seeded: b.remaining !== null && b.remaining !== undefined
  };
});

/** Recarga la bolsa. amount positivo suma, negativo retira. Queda en auditoría. */
exports.refillPlayzoneRewardBudget = functions.https.onCall(async (data, context) => {
  const actorUid = await requireCommander(context);

  const amount = Math.trunc(Number(data && data.amount) || 0);
  const reason = String((data && data.reason) || '').trim().slice(0, 300);
  if (!amount) {
    throw new functions.https.HttpsError('invalid-argument', 'Indica una cantidad distinta de cero.');
  }
  if (Math.abs(amount) > MAX_BUDGET_REFILL) {
    throw new functions.https.HttpsError('invalid-argument', 'Máximo ' + MAX_BUDGET_REFILL + ' tokens por operación.');
  }
  if (!reason) {
    throw new functions.https.HttpsError('invalid-argument', 'El motivo es obligatorio para la auditoría.');
  }

  const nickSnap = await admin.database().ref('users/' + actorUid + '/nick').once('value');
  const actorNick = String(nickSnap.val() || actorUid).slice(0, 80);

  const res = await admin.database().ref(BUDGET_PATH + '/remaining').transaction((cur) => {
    const remaining = (cur === null || cur === undefined) ? BUDGET_INITIAL : (Number(cur) || 0);
    return Math.max(0, remaining + amount);
  });
  if (!res.committed) {
    throw new functions.https.HttpsError('aborted', 'No se pudo actualizar la bolsa.');
  }
  const remaining = Number(res.snapshot.val()) || 0;

  await admin.database().ref(BUDGET_PATH).update({
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    lastRefillAt: admin.database.ServerValue.TIMESTAMP,
    lastRefillAmount: amount,
    lastRefillByUid: actorUid,
    lastRefillByNick: actorNick,
    lastRefillReason: reason
  });

  await admin.database().ref('security/auditLog').push({
    action: 'playzone_budget_refill',
    detail: (amount > 0 ? '+' : '') + amount + ' tokens · saldo ' + remaining + ' · ' + reason,
    byUid: actorUid,
    byNick: actorNick,
    at: admin.database.ServerValue.TIMESTAMP
  }).catch(function () {});

  return { remaining, amount };
});

// ============================================================================
// 3) BORRAR/CANCELAR MISIÓN -> REEMBOLSAR AL CREADOR (si no se pagó)
// ============================================================================
exports.refundMissionEscrow = functions.database
  .ref('/missions/{missionId}')
  .onDelete(async (snap, context) => {
    const m = snap.val();
    if (!m || !m.creatorUid) return null;

    const held = m.escrowStatus === 'held';
    const amount = parseInt(m.escrow, 10) || 0;

    if (held && amount > 0) {
      await creditTokens(m.creatorUid, amount, {
        type: 'mission_refund',
        reason: 'Reembolso escrow misión cancelada',
        missionId: context.params.missionId
      });
      console.log(`[refund] ${context.params.missionId}: reembolsados ${amount} tokens a ${m.creatorUid}.`);
    }
    return null;
  });
