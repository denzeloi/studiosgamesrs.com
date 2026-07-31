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
  plan,
  blockedMessage,
};
