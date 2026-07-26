/**
 * PlayZone Smart — Regulación inteligente de misiones
 * ---------------------------------------------------
 * Módulo AUTÓNOMO (no depende de nada de playzone.js). Expone window.PlayzoneSmart.
 *
 * Qué hace:
 *  1) Estima cuánto dura una misión según juego / tipo / nivel / nº de jugadores.
 *  2) Recomienda una recompensa PEQUEÑA de tokens y calcula un TOPE por misión.
 *  3) Valida el completado: exige que haya pasado un tiempo mínimo (anti-abuso).
 *
 * IMPORTANTE (seguridad): el acreditado REAL de tokens debe hacerlo el backend
 * (Cloud Function / servidor). Este módulo solo calcula y valida en el cliente
 * para dar feedback y evitar abusos obvios; no "regala" tokens por sí mismo.
 */
(function (global) {
  'use strict';

  // Tope duro global de tokens por misión. Nunca se recomienda ni se permite más.
  var HARD_CAP = 3;

  // Minutos base por tipo de misión.
  var BASE_BY_TYPE = {
    'ranked':       40,
    'competitivo':  40,
    'cooperativo':  35,
    'coop':         35,
    'evento':       50,
    'torneo':       60,
    'casual':       25,
    'friends':      40,
    'amigos':       40
  };
  var DEFAULT_BASE = 30;

  // Factor por juego (partidas más largas = factor mayor). Claves normalizadas.
  var GAME_FACTOR = {
    'league of legends':   1.30,
    'lol':                 1.30,
    'dota 2':              1.35,
    'counter-strike 2':    1.20,
    'cs2':                 1.20,
    'counter strike':      1.20,
    'valorant':            1.15,
    'apex legends':        1.10,
    'fortnite':            1.00,
    'call of duty':        1.00,
    'warzone':             1.05,
    'rocket league':       0.70,
    'overwatch 2':         1.00,
    'overwatch':           1.00,
    'battlefield':         1.10,
    'gta v':               1.00,
    'grand theft auto v':  1.00,
    'minecraft':           1.20,
    'pubg':                1.10,
    'rainbow six siege':   1.15,
    'r6':                  1.15,
    'fifa':                0.80,
    'ea sports fc':        0.80
  };

  // Factor por nivel de habilidad.
  var SKILL_FACTOR = {
    'principiante': 0.90,
    'novato':       0.90,
    'intermedio':   1.00,
    'avanzado':     1.15,
    'pro':          1.25,
    'experto':      1.25
  };

  function norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function roundTo5(n) {
    return Math.round(n / 5) * 5;
  }

  /**
   * Estima la misión. Devuelve siempre un objeto válido (nunca lanza).
   * @returns {{estMinutes:number, difficulty:number, recommendedTokens:number, tokenCap:number}}
   */
  function estimate(mission) {
    mission = mission || {};

    var base = BASE_BY_TYPE[norm(mission.type)] || DEFAULT_BASE;
    var gameF = GAME_FACTOR[norm(mission.game)] || 1.0;
    var skillF = SKILL_FACTOR[norm(mission.skill)] || 1.0;

    var players = parseInt(mission.maxParticipants, 10);
    if (!players || players < 1) players = 5;
    // Coordinar a más jugadores suma un poco de tiempo (efecto pequeño).
    var playersF = 1 + clamp((players - 2) * 0.03, -0.06, 0.30);

    var raw = base * gameF * skillF * playersF;
    var estMinutes = clamp(roundTo5(raw), 10, 180);

    // Dificultad relativa (para mostrar / escalar). ~1.0 = media.
    var difficulty = Math.round(gameF * skillF * 100) / 100;

    // Recompensa pequeña: ~1 token por cada 30 min de esfuerzo, con tope duro.
    var recommendedTokens = clamp(Math.round(estMinutes / 30), 1, HARD_CAP);

    // Tope por misión: escala suave con el tiempo (misiones cortas topan bajo).
    var tokenCap = clamp(Math.ceil(estMinutes / 40), 1, HARD_CAP);
    if (recommendedTokens > tokenCap) recommendedTokens = tokenCap;

    return {
      estMinutes: estMinutes,
      difficulty: difficulty,
      recommendedTokens: recommendedTokens,
      tokenCap: tokenCap
    };
  }

  /** Formatea minutos como "45 min" o "1 h 30 min". */
  function formatDuration(minutes) {
    minutes = Math.max(0, Math.round(minutes || 0));
    if (minutes < 60) return minutes + ' min';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return m ? (h + ' h ' + m + ' min') : (h + ' h');
  }

  /**
   * Devuelve el instante (ms) en que la misión empezó a contar, o null.
   * Solo vale startedAt: es el único campo que las reglas atan al creador y
   * obligan a coincidir con el momento real, así que el servidor tampoco acepta
   * otro (ver awardMissionTokens). schedule y createdAt son manipulables.
   */
  function getStartTime(mission) {
    if (!mission) return null;
    if (typeof mission.startedAt === 'number') return mission.startedAt;
    return null;
  }

  /**
   * Valida si ya se puede marcar como completada.
   * Regla: la misión debe haberse iniciado y haber transcurrido al menos la
   * MITAD del tiempo estimado. Sin startedAt no hay premio posible, así que se
   * bloquea para no dejar al jugador confirmando algo que nunca se pagará.
   * @returns {{ok:boolean, requiredMs:number, elapsedMs:number, remainingMs:number, reason:string}}
   */
  function checkMinTime(mission) {
    var est = estimate(mission);
    var requiredMs = Math.round(est.estMinutes * 0.5) * 60 * 1000;
    var start = getStartTime(mission);

    if (start == null) {
      return { ok: false, requiredMs: requiredMs, elapsedMs: 0, remainingMs: requiredMs, reason: 'not-started' };
    }

    var elapsedMs = Date.now() - start;
    if (elapsedMs >= requiredMs) {
      return { ok: true, requiredMs: requiredMs, elapsedMs: elapsedMs, remainingMs: 0, reason: 'ok' };
    }
    return {
      ok: false,
      requiredMs: requiredMs,
      elapsedMs: elapsedMs,
      remainingMs: requiredMs - elapsedMs,
      reason: 'too-soon'
    };
  }

  global.PlayzoneSmart = {
    HARD_CAP: HARD_CAP,
    estimate: estimate,
    formatDuration: formatDuration,
    getStartTime: getStartTime,
    checkMinTime: checkMinTime
  };
})(typeof window !== 'undefined' ? window : this);
