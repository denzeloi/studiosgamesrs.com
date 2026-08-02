'use strict';

/**
 * Qué hacer con las máquinas cuando termina un cruce.
 * ==========================================================================
 * El cuadro avanza solo desde que el servidor reporta el final, pero las VMs
 * no: al acabar una semifinal su máquina se marcaba para apagado y, cuando la
 * otra semi terminaba media hora después, la final se encontraba sin servidor.
 * El Commander tenía que crear uno nuevo y esperar otra vez el arranque
 * completo, con los dos finalistas mirando una sala vacía.
 *
 * Aquí se decide reaprovechar una de las dos máquinas que ya están en pie:
 *
 *   - al cerrar la primera semi se le cancela el apagado y se reserva para la
 *     final (la otra semi sigue con su plazo normal, que su máquina hará falta
 *     hasta que termine);
 *   - al cerrar la segunda, esa máquina reservada se cuelga de la final, con su
 *     IP y su puerto, lista para que el Commander pulse Comenzar.
 *
 * Y cuando la final cae, al revés: se les vence el plazo a todas las máquinas
 * del torneo de golpe, incluida la que se había reservado, para que no quede
 * ninguna encendida cobrando después de entregar los premios.
 *
 * Lo que NO hace: arrancar MatchZy. La final la saca el Commander cuando los
 * finalistas están, no un webhook a las tres de la mañana.
 *
 * La decisión es una función pura para poder comprobarla entera sin Firebase;
 * debajo hay una capa fina que lee el torneo y escribe lo que la decisión diga.
 */

const rtdb = require('./firebase-rtdb');
const lifecycle = require('./lifecycle');

/** Cruces que ocupan una máquina: la suya no se le puede quitar. */
const BUSY_STATUSES = ['provisioning', 'starting', 'live'];

function matchesOf(tournament) {
  return (tournament && tournament.bracket && tournament.bracket.matches) || {};
}

function liveOf(tournament) {
  return (tournament && tournament.liveMatches) || {};
}

function slotTeamId(slot) {
  return (slot && slot.teamId) || null;
}

/** El cruce al que sube el ganador, según el cuadro o según lo que ya avanzó. */
function nextMatchIdFor(tournament, matchId, advance) {
  if (advance && advance.nextMatchId) return String(advance.nextMatchId);
  const m = matchesOf(tournament)[matchId];
  return m && m.nextMatchId ? String(m.nextMatchId) : null;
}

/**
 * ¿Está la final con el cartel completo? Manda el estado que dejó el cuadro
 * (T2), y si alguien lo rellenó a mano se mira que tenga los dos equipos.
 */
function nextIsReady(next) {
  if (!next) return false;
  if (next.status === 'ready') return true;
  if (next.status === 'waiting') return false;
  return !!(slotTeamId(next.teamA) && slotTeamId(next.teamB));
}

/** Máquinas que no se pueden tocar: están sirviendo otro cruce vivo. */
function busyServerIds(tournament, exceptMatchId) {
  const live = liveOf(tournament);
  const busy = {};
  Object.keys(live).forEach((mid) => {
    if (mid === exceptMatchId) return;
    const lm = live[mid] || {};
    if (lm.serverId && BUSY_STATUSES.indexOf(lm.status) !== -1) {
      busy[String(lm.serverId)] = true;
    }
  });
  return busy;
}

/**
 * La máquina que se le da a la final: primero la que quedó reservada al cerrar
 * la primera semi y, si esa reserva se perdió, la del cruce que acaba de
 * terminar, que también está caliente.
 */
function pickWarmServer(gameServers, nextId, endServerId, busy) {
  const all = gameServers || {};
  const reserved = Object.keys(all).find(function (id) {
    return String((all[id] || {}).reservedForMatchId || '') === nextId && !busy[id];
  });
  if (reserved) return String(reserved);
  if (endServerId && !busy[String(endServerId)] && all[String(endServerId)]) {
    return String(endServerId);
  }
  return null;
}

/**
 * Decide qué hacer con las máquinas tras un fin de partida.
 *
 * Devuelve una de tres cosas: no tocar nada, retener la máquina del cruce que
 * acaba de cerrar para la siguiente ronda, o colgar una máquina caliente del
 * cruce siguiente ya con los dos equipos puestos.
 */
function planAfterMatchEnd({ tournament, matchId, serverId, gameServers, advance, now }) {
  const at = Number(now) || Date.now();
  if (!tournament || !matchId) return { action: 'none', reason: 'no_context' };

  // La final no retiene nada: apagar las máquinas del torneo es otra tarea.
  if (advance && advance.tournamentComplete) {
    return { action: 'none', reason: 'tournament_complete' };
  }

  const nextId = nextMatchIdFor(tournament, matchId, advance);
  if (!nextId) return { action: 'none', reason: 'no_next_match' };

  const matches = matchesOf(tournament);
  const live = liveOf(tournament);

  if (!nextIsReady(matches[nextId])) {
    // Falta la otra semifinal. La máquina que acaba de quedar libre se guarda
    // en vez de apagarse: es la que jugará la final dentro de un rato.
    if (!serverId) return { action: 'none', reason: 'no_server' };
    return {
      action: 'retain',
      serverId: String(serverId),
      nextMatchId: nextId,
      serverPatch: Object.assign({
        reservedForMatchId: nextId,
        // Vuelve a ser una máquina encendida y libre, no una partida cerrada:
        // con 'match_complete' el barrido la apagaba al vencer el plazo corto
        // aunque se le hubiera quitado la fecha.
        status: 'online',
        reservedAt: at,
      }, lifecycle.cancelShutdownPatch()),
    };
  }

  const already = live[nextId] || {};
  if (already.serverId && BUSY_STATUSES.indexOf(already.status) !== -1) {
    return { action: 'none', reason: 'already_assigned', serverId: String(already.serverId) };
  }

  const busy = busyServerIds(tournament, nextId);
  const warmId = pickWarmServer(gameServers, nextId, serverId, busy);
  if (!warmId) return { action: 'none', reason: 'no_warm_server' };

  const gs = (gameServers || {})[warmId] || {};
  const ip = gs.ip ? String(gs.ip).trim() : null;
  if (!ip) return { action: 'none', reason: 'no_server_ip' };

  const next = matches[nextId] || {};
  const liveMatchPatch = {
    status: 'starting',
    serverId: warmId,
    serverIp: ip,
    serverPort: Number(gs.port) || 27015,
    // Marca de que aquí no ha lanzado nadie: la máquina está esperando el
    // saque, no es un lanzamiento que se quedó a medias.
    prewarmed: true,
    prewarmedAt: at,
  };
  if (gs.gsltIndex != null) liveMatchPatch.gsltIndex = Number(gs.gsltIndex) || 0;

  return {
    action: 'assign',
    serverId: warmId,
    nextMatchId: nextId,
    teamIds: [slotTeamId(next.teamA), slotTeamId(next.teamB)].filter(Boolean),
    serverPatch: Object.assign({
      status: 'online',
      matchId: nextId,
      tournamentId: tournament.id || null,
      reservedForMatchId: nextId,
    }, lifecycle.cancelShutdownPatch()),
    liveMatchPatch,
  };
}

/**
 * Qué hacer con las máquinas cuando el torneo entero se acaba.
 *
 * Hasta aquí cada máquina se apagaba por su cuenta: la del último cruce con su
 * plazo de cortesía y las demás cuando el barrido se fijaba en ellas. La que
 * T6 había reservado para la final no se apagaba en absoluto mientras durase
 * su ventana de ociosa, y una máquina que se aprovisionó y nunca llegó a jugar
 * no aparecía colgada de ningún cruce. Con el torneo cerrado ya no hay ninguna
 * razón para tener nada encendido, así que se les vence el plazo a todas a la
 * vez y el barrido las recoge en la siguiente pasada.
 *
 * No se borra nada desde aquí: el borrado en el proveedor vive en el barrido,
 * que ya sabe reintentar y registrar lo que pasó.
 */
function planTournamentCloseout({ tournament, tournamentId, gameServers, env, now }) {
  const at = Number(now) || Date.now();
  const tid = String(tournamentId || (tournament && tournament.id) || '');
  if (!tid) return { action: 'none', reason: 'no_context', servers: [], skipped: [] };

  // El interruptor de "dejadme los servidores encendidos" manda también aquí:
  // es el mismo que usa el fin de partida.
  if (!lifecycle.autoShutdownEnabled(env)) {
    return { action: 'none', reason: 'autoshutdown_off', servers: [], skipped: [] };
  }

  const busy = busyServerIds(tournament, null);
  const all = gameServers || {};
  const servers = [];
  const skipped = [];

  Object.keys(all).forEach(function (id) {
    const gs = all[id] || {};
    const owner = gs.tournamentId ? String(gs.tournamentId) : null;
    // Una máquina de otro torneo puede estar en mitad de una partida: cerrar el
    // nuestro no es motivo para tirarle el servidor a nadie.
    if (owner && owner !== tid) {
      skipped.push({ serverId: String(id), reason: 'other_tournament' });
      return;
    }
    if (busy[String(id)]) {
      skipped.push({ serverId: String(id), reason: 'busy' });
      return;
    }
    servers.push({
      serverId: String(id),
      patch: {
        shutdownAfter: at,
        shutdownReason: 'tournament_complete',
        // La reserva de la final ya no vale para nada y, si se quedara puesta,
        // solo serviría para confundir a quien mire el registro.
        reservedForMatchId: null,
      },
    });
  });

  return {
    action: servers.length ? 'closeout' : 'none',
    reason: servers.length ? null : 'no_servers',
    tournamentId: tid,
    servers,
    skipped,
  };
}

/**
 * Las máquinas que pueden entrar en la decisión: las que este torneo tiene
 * colgadas de algún cruce, más la que acaba de terminar. Se leen una a una en
 * vez de barrer el registro entero, que es de todos los torneos.
 */
async function loadTournamentServers(tournament, extraServerId) {
  const live = liveOf(tournament);
  const ids = [];
  Object.keys(live).forEach(function (mid) {
    const sid = live[mid] && live[mid].serverId;
    if (sid && ids.indexOf(String(sid)) === -1) ids.push(String(sid));
  });
  if (extraServerId && ids.indexOf(String(extraServerId)) === -1) {
    ids.push(String(extraServerId));
  }

  const out = {};
  for (const id of ids) {
    const gs = await rtdb.getGameServer(id);
    if (gs) out[id] = gs;
  }
  return out;
}

/**
 * Aplica la decisión. Se llama desde el webhook después de que el cuadro haya
 * avanzado, con el torneo releído para que la final ya diga si tiene cartel.
 */
async function applyAfterMatchEnd(tournamentId, matchId, serverId, advance) {
  if (!tournamentId || !matchId) return { action: 'none', reason: 'no_context' };

  const tournament = await rtdb.getTournament(tournamentId);
  if (!tournament) return { action: 'none', reason: 'no_tournament' };
  tournament.id = tournamentId;

  // Ganada la final no hay nada que precalentar: lo que toca es apagarlo todo.
  if (advance && advance.tournamentComplete) {
    return applyTournamentCloseout(tournamentId, tournament);
  }
  // El otro corte barato, antes de leer ninguna máquina.
  if (!nextMatchIdFor(tournament, matchId, advance)) {
    return { action: 'none', reason: 'no_next_match' };
  }

  const gameServers = await loadTournamentServers(tournament, serverId);
  const plan = planAfterMatchEnd({ tournament, matchId, serverId, gameServers, advance });

  if (plan.action === 'none') return plan;

  await rtdb.writeGameServer(plan.serverId, plan.serverPatch);
  if (plan.action === 'assign') {
    await rtdb.writeTournamentLiveMatch(tournamentId, plan.nextMatchId, plan.liveMatchPatch);
    await notifyFinalReady(tournament, plan);
  }
  return plan;
}

/**
 * Cierra el torneo por el lado de la infraestructura: a todas sus máquinas se
 * les vence el plazo ahora mismo. Se juntan las que cuelgan de un cruce con las
 * que dicen ser del torneo aunque ya no cuelguen de nada.
 */
async function applyTournamentCloseout(tournamentId, tournament) {
  const owned = await rtdb.getGameServersByTournament(tournamentId);
  const linked = await loadTournamentServers(tournament, null);
  const gameServers = Object.assign({}, linked, owned);

  const plan = planTournamentCloseout({
    tournament,
    tournamentId,
    gameServers,
    env: process.env,
  });

  for (const item of plan.servers) {
    await rtdb.writeGameServer(item.serverId, item.patch);
  }
  if (plan.servers.length) {
    console.log('[orchestrator] torneo', tournamentId, 'cerrado — apagando',
      plan.servers.map(function (s) { return s.serverId; }).join(', '));
  }
  return plan;
}

/**
 * El aviso solo sale cuando la siguiente ronda ya tiene servidor y cartel: es
 * lo único accionable de todo esto, y decirlo antes sería avisar de una partida
 * a la que todavía le falta un finalista.
 */
async function notifyFinalReady(tournament, plan) {
  if (!plan.teamIds || plan.teamIds.length < 2) return;
  try {
    const name = tournament.name || 'tu torneo';
    await rtdb.notifyTeamRosters(
      plan.teamIds,
      `tourwarm_${tournament.id}_${plan.nextMatchId}`,
      {
        text: `Tu siguiente partida de ${name} ya tiene servidor preparado. `
          + 'Entra a la sala: empieza en cuanto el organizador dé el saque.',
        icon: 'fa-server',
        link: `/tournament-details?id=${tournament.id}`,
        type: 'tournament_prewarm',
      }
    );
  } catch (err) {
    // Avisar es lo último: la final ya tiene máquina aunque esto falle.
    console.warn('[orchestrator] no se pudo avisar del servidor listo:', err.message);
  }
}

module.exports = {
  BUSY_STATUSES,
  nextMatchIdFor,
  nextIsReady,
  pickWarmServer,
  planAfterMatchEnd,
  applyAfterMatchEnd,
  planTournamentCloseout,
  applyTournamentCloseout,
};
