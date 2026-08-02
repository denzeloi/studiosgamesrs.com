'use strict';

/**
 * Cuántas partidas puede tener vivas un torneo a la vez.
 *
 * La infraestructura aguanta dos en paralelo (dos GSLT, dos VMs), pero un
 * campeonato se puede querer correr servidor por servidor: una sola partida
 * viva, retransmitida, y la siguiente cuando esa termine. Eso se elige por
 * torneo en `serverMode` y se hace cumplir en las funciones, no solo en el
 * panel: la función es la única puerta real al proveedor de nube y a los GSLT.
 *
 * Por defecto 'single', que es lo barato y lo que no se rompe por accidente:
 * levantar un segundo servidor cuesta dinero y quema un token GSLT.
 */

const LIMIT_BY_MODE = { single: 1, dual: 2 };
const BUSY_STATUSES = ['live', 'starting', 'provisioning'];

function modeOf(tournament) {
  const raw = String((tournament && tournament.serverMode) || 'single').toLowerCase();
  return LIMIT_BY_MODE[raw] ? raw : 'single';
}

function limitOf(tournament) {
  return LIMIT_BY_MODE[modeOf(tournament)];
}

/** Cruces ocupando un servidor ahora mismo, sin contar el que se está tocando. */
function busyMatchIds(tournament, exceptMatchId) {
  const live = (tournament && tournament.liveMatches) || {};
  return Object.keys(live).filter((mid) => {
    if (exceptMatchId && mid === exceptMatchId) return false;
    const m = live[mid] || {};
    return BUSY_STATUSES.indexOf(m.status) !== -1;
  });
}

/**
 * ¿Cabe este cruce y en qué slot GSLT? El slot lo decide el backend; lo que
 * pida el panel es solo una preferencia.
 */
function plan(tournament, matchId, requestedSlot) {
  const mode = modeOf(tournament);
  const limit = LIMIT_BY_MODE[mode];
  const busy = busyMatchIds(tournament, matchId);
  if (busy.length >= limit) {
    return { allowed: false, mode, limit, busy, slot: null };
  }
  if (limit === 1) {
    return { allowed: true, mode, limit, busy, slot: 0 };
  }

  const live = (tournament && tournament.liveMatches) || {};
  const used = busy.map((mid) => Number((live[mid] || {}).gsltIndex) || 0);
  const wanted = Number(requestedSlot) || 0;
  let slot = 0;
  if (wanted < limit && used.indexOf(wanted) === -1) {
    slot = wanted;
  } else {
    for (let i = 0; i < limit; i += 1) {
      if (used.indexOf(i) === -1) { slot = i; break; }
    }
  }
  return { allowed: true, mode, limit, busy, slot };
}

/** Número de cruce dentro de su ronda, para ordenar r1_m1 antes que r1_m2. */
function matchNumber(matchId) {
  const parsed = /_m(\d+)\s*$/.exec(String(matchId || ''));
  const n = parsed ? Number(parsed[1]) : NaN;
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Cruces de primera ronda con los dos equipos ya puestos, en orden de cuadro.
 *
 * Se exigen los dos equipos porque un cuadro de cinco inscritos deja huecos
 * (BYE) en primera ronda, y levantar una máquina para un cruce con un solo
 * equipo es pagar por un servidor donde no juega nadie.
 */
function firstRoundMatchIds(tournament) {
  const matches = (tournament && tournament.bracket && tournament.bracket.matches) || {};
  return Object.keys(matches)
    .filter((mid) => {
      const m = matches[mid] || {};
      // Cuadros viejos no guardaban `round`; el identificador lo dice igual.
      const round = Number(m.round) || (/^r1_m\d+$/.test(mid) ? 1 : 0);
      if (round !== 1) return false;
      return !!(m.teamA && m.teamA.teamId && m.teamB && m.teamB.teamId);
    })
    .sort((a, b) => matchNumber(a) - matchNumber(b));
}

/**
 * Las dos semifinales de un cuadro de cuatro, repartidas entre los dos GSLT.
 *
 * En modo dos servidores lo normal es querer las dos semis a la vez: pedirlas
 * de una en una obliga a esperar a que la primera termine de arrancar para
 * poder pedir la segunda, y en ese hueco alguien ya cambió de pestaña. Aquí
 * solo se decide qué se levanta y en qué ranura; provisionar es cosa de las
 * funciones.
 *
 * Un cruce que ya tiene servidor no se vuelve a levantar: se marca `skipped`
 * para que pedir las dos con una ya en pie siga sirviendo para levantar la que
 * falta, en vez de fallar entero.
 */
function planDualSemis(tournament) {
  const mode = modeOf(tournament);
  const limit = LIMIT_BY_MODE[mode];
  if (mode !== 'dual') {
    return { ok: false, reason: 'not_dual', mode, limit, entries: [], found: [] };
  }

  const found = firstRoundMatchIds(tournament);
  const semis = found.slice(0, limit);
  if (semis.length < limit) {
    return { ok: false, reason: 'not_enough_matches', mode, limit, entries: [], found };
  }

  const live = (tournament && tournament.liveMatches) || {};
  // Las ranuras ya gastadas incluyen cruces de otras rondas: si una segunda
  // ronda sigue viva, su GSLT no está libre por mucho que la semi lo pida.
  const used = busyMatchIds(tournament, null)
    .map((mid) => Number((live[mid] || {}).gsltIndex) || 0);

  const entries = semis.map((matchId) => {
    const m = live[matchId] || {};
    if (BUSY_STATUSES.indexOf(m.status) !== -1) {
      return {
        matchId,
        gsltIndex: Number(m.gsltIndex) || 0,
        serverId: m.serverId ? String(m.serverId) : null,
        skipped: m.status,
      };
    }

    let slot = null;
    for (let i = 0; i < limit; i += 1) {
      if (used.indexOf(i) === -1) { slot = i; break; }
    }
    if (slot === null) {
      return { matchId, gsltIndex: null, serverId: null, blocked: true };
    }
    used.push(slot);
    return { matchId, gsltIndex: slot, serverId: null };
  });

  return {
    ok: true,
    mode,
    limit,
    entries,
    provision: entries.filter((e) => !e.skipped && !e.blocked),
  };
}

/** Por qué no se pueden pedir las dos semis, dicho para quien está delante del panel. */
function dualSemisBlockedMessage(plan) {
  if (plan && plan.reason === 'not_dual') {
    return 'Este torneo corre en modo servidor único: pásalo a modo dos servidores ' +
      'antes de levantar las dos semifinales de una vez.';
  }
  if (plan && plan.reason === 'not_enough_matches') {
    return 'Hacen falta dos cruces de primera ronda con los dos equipos puestos y solo hay ' +
      ((plan.found || []).length) + '. Genera el cuadro con 4 equipos inscritos antes de ' +
      'levantar las dos semifinales.';
  }
  return 'No se pueden levantar las dos semifinales de este torneo ahora mismo.';
}

/**
 * ¿Puede esta máquina quedarse con los punteros de nivel torneo?
 *
 * activeServerId / serverIp son un único hueco que se dejó para los clientes
 * viejos. Levantar la segunda máquina lo sobrescribía con la que aún estaba
 * arrancando, y la partida que ya estaba en juego perdía su IP de cara a esos
 * clientes. Se cede el hueco solo si está libre o si el que lo ocupa ya no está
 * jugando.
 */
function canClaimPrimary(tournament, serverId) {
  const current = tournament && tournament.activeServerId;
  if (!current || String(current) === String(serverId)) return true;

  const live = (tournament && tournament.liveMatches) || {};
  const stillPlaying = Object.keys(live).some((mid) => {
    const m = live[mid] || {};
    if (String(m.serverId || '') !== String(current)) return false;
    return m.status === 'live' || m.status === 'starting';
  });
  return !stillPlaying;
}

/** Por qué no cabe, dicho para quien está delante del panel. */
function blockedMessage(result, action) {
  const list = (result.busy || []).join(', ');
  if (result.limit === 1) {
    return 'Este torneo corre en modo servidor único: ya hay una partida en curso (' + list + '). ' +
      'Ciérrala (o libera su servidor) antes de ' + action + ', o pasa el torneo a modo dos servidores.';
  }
  return 'Ya hay ' + (result.busy || []).length + ' partidas ocupando servidor (' + list + '), ' +
    'el máximo de este torneo. Cierra una antes de ' + action + '.';
}

module.exports = {
  LIMIT_BY_MODE,
  BUSY_STATUSES,
  modeOf,
  limitOf,
  busyMatchIds,
  canClaimPrimary,
  plan,
  blockedMessage,
  matchNumber,
  firstRoundMatchIds,
  planDualSemis,
  dualSemisBlockedMessage,
};
