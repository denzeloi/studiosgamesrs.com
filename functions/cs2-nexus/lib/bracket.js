'use strict';

const rtdb = require('./firebase-rtdb');

function buildSingleElimBracket(teamIds) {
  const n = teamIds.length;
  if (n < 2) throw new Error('Need at least 2 teams');

  const rounds = Math.ceil(Math.log2(n));
  const bracketSize = 2 ** rounds;
  const slots = [...teamIds];
  while (slots.length < bracketSize) slots.push(null);

  const matches = {};
  let matchNum = 1;
  const round1 = [];

  for (let i = 0; i < bracketSize; i += 2) {
    const matchId = `r1_m${matchNum}`;
    matches[matchId] = {
      id: matchId,
      round: 1,
      teamA: slots[i] ? { teamId: slots[i] } : null,
      teamB: slots[i + 1] ? { teamId: slots[i + 1] } : null,
      status: 'pending',
      winnerTeamId: null,
      nextMatchId: null,
    };
    round1.push(matchId);
    matchNum += 1;
  }

  let prevRound = round1;
  for (let r = 2; r <= rounds; r += 1) {
    const thisRound = [];
    for (let i = 0; i < prevRound.length; i += 2) {
      const matchId = `r${r}_m${Math.floor(i / 2) + 1}`;
      matches[matchId] = {
        id: matchId,
        round: r,
        teamA: null,
        teamB: null,
        status: 'pending',
        winnerTeamId: null,
        nextMatchId: r < rounds ? `r${r + 1}_m${Math.floor(i / 4) + 1}` : null,
      };
      matches[prevRound[i]].nextMatchId = matchId;
      if (prevRound[i + 1]) matches[prevRound[i + 1]].nextMatchId = matchId;
      thisRound.push(matchId);
    }
    prevRound = thisRound;
  }

  return { format: 'SingleElim', rounds, matches, currentMatchId: round1[0] };
}

/**
 * En qué ranura del siguiente cruce entra el ganador.
 *
 * Antes se cogía "la primera libre", y eso es lo que duplicaba al ganador: el
 * webhook y el piloto automático del War Room avanzaban el mismo cruce, el
 * primero ocupaba teamA y el segundo, viendo teamA lleno, metía al mismo equipo
 * en teamB. Con la ranura atada al número del cruce de origen (impar arriba,
 * par abajo), escribir dos veces deja exactamente el mismo cuadro.
 */
function slotForFeeder(feederMatchId, nextMatch) {
  const parsed = /_m(\d+)\s*$/.exec(String(feederMatchId || ''));
  if (parsed) {
    const n = Number(parsed[1]);
    if (Number.isFinite(n) && n > 0) return n % 2 === 1 ? 'teamA' : 'teamB';
  }
  // Cuadros de otra procedencia, sin numeración reconocible.
  return !nextMatch || !nextMatch.teamA ? 'teamA' : 'teamB';
}

function slotTeamId(slot) {
  return slot && slot.teamId ? slot.teamId : null;
}

function bracketMatches(tournament) {
  return (tournament && tournament.bracket && tournament.bracket.matches) || null;
}

/**
 * ¿Hay que sembrar el cuadro al lanzar este cruce?
 *
 * Solo si el torneo todavía no tiene ninguno. El lanzamiento reconstruía el
 * cuadro con los equipos que le llegaran, y quien lanza un cruce manda los dos
 * de ese cruce y nada más: comenzar r1_m1 de un cuadro de cuatro lo rehacía
 * como un cuadro de dos y se llevaba por delante r1_m2 y la final, con sus
 * equipos y sus horas. La siembra tiene su sitio (el botón de generar cuadro);
 * aquí solo se cubre el atajo de lanzar sin cuadro previo.
 */
function shouldSeedBracket(tournament, teamIds, skipRebuild) {
  if (skipRebuild === true) return false;
  if (!Array.isArray(teamIds) || teamIds.length < 2) return false;
  const matches = bracketMatches(tournament);
  return !(matches && Object.keys(matches).length);
}

/**
 * Los dos equipos de un cruce según el cuadro, para no depender de que el
 * panel los mande bien. Devuelve [] si el cruce no tiene a los dos puestos.
 */
function teamIdsForMatch(tournament, matchId) {
  const matches = bracketMatches(tournament) || {};
  const m = matches[matchId];
  const a = m && m.teamA && m.teamA.teamId;
  const b = m && m.teamB && m.teamB.teamId;
  return a && b ? [a, b] : [];
}

function roundOf(match, matchId) {
  const n = Number(match && match.round);
  if (Number.isFinite(n) && n > 0) return n;
  // Cuadros importados o viejos no guardaban `round`; el identificador lo dice.
  const parsed = /^r(\d+)_/.exec(String(matchId || ''));
  return parsed ? Number(parsed[1]) : 0;
}

/** El otro cruce de la misma ronda que desemboca en el mismo siguiente. */
function peerFeederId(matches, matchId, nextId) {
  const round = roundOf(matches[matchId], matchId);
  const found = Object.keys(matches).filter((mid) => {
    if (mid === matchId) return false;
    const m = matches[mid] || {};
    if (String(m.nextMatchId || '') !== String(nextId)) return false;
    return roundOf(m, mid) === round;
  });
  return found.length ? found[0] : null;
}

function isFinished(match) {
  return !!(match && match.status === 'finished' && match.winnerTeamId);
}

/**
 * Decide qué hay que escribir, sin tocar la base. Devuelve `skip` cuando el
 * cruce ya estaba cerrado con ese mismo ganador: repetir el aviso del servidor
 * no puede volver a mover el cuadro.
 */
function planAdvance(bracket, matchId, winnerTeamId, score = {}, now = Date.now()) {
  const matches = (bracket && bracket.matches) || {};
  const match = matches[matchId];
  if (!match) return { ok: false, reason: 'match_not_found' };
  if (!winnerTeamId) return { ok: false, reason: 'no_winner' };

  const already = match.status === 'finished' && match.winnerTeamId;
  if (already && match.winnerTeamId !== winnerTeamId) {
    // Dos ganadores distintos para el mismo cruce: alguien lo cerró a mano y el
    // servidor dice otra cosa. Se deja como está y que lo mire un Commander.
    return { ok: false, reason: 'winner_conflict', current: match.winnerTeamId };
  }

  const plan = {
    ok: true,
    skip: !!already,
    matchId,
    matchPatch: {
      status: 'finished',
      winnerTeamId,
      score,
      finishedAt: match.finishedAt || now,
    },
    nextId: match.nextMatchId || null,
  };

  if (!plan.nextId) {
    plan.complete = true;
    plan.tournamentPatch = {
      status: 'finalizado',
      championTeamId: winnerTeamId,
      finishedAt: now,
    };
    return plan;
  }

  const nextMatch = matches[plan.nextId] || {};
  const slot = slotForFeeder(matchId, nextMatch);
  const other = slot === 'teamA' ? 'teamB' : 'teamA';
  const occupant = slotTeamId(nextMatch[slot]);

  // Cerrar la primera semifinal no convierte la final en la partida del
  // momento: le falta la mitad del cartel. Apuntando currentMatchId a la final
  // en cuanto cae una semi, el War Room ofrecía lanzarla contra un hueco vacío
  // y el otro cruce, que era lo que tocaba jugar, dejaba de ser el actual.
  const peerId = peerFeederId(matches, matchId, plan.nextId);
  const peerDone = !peerId || isFinished(matches[peerId]);
  const ready = peerDone && !!slotTeamId(nextMatch[other]);

  plan.complete = false;
  plan.slot = slot;
  plan.peerMatchId = peerId;
  plan.ready = ready;
  plan.nextPatch = occupant === winnerTeamId ? {} : {
    [slot]: { teamId: winnerTeamId, fromMatchId: matchId },
  };
  plan.nextPatch.status = ready ? 'ready' : 'waiting';
  plan.tournamentPatch = {
    // Mientras falte el otro feeder, lo que toca es ese cruce; y si no existe,
    // el que se acaba de cerrar, nunca una final a medio cartel.
    currentMatchId: ready ? plan.nextId : (peerId || matchId),
    status: 'en_vivo',
  };
  return plan;
}

async function advanceWinner(tournamentId, matchId, winnerTeamId, score = {}) {
  const tournament = await rtdb.getTournament(tournamentId);
  const plan = planAdvance(tournament && tournament.bracket, matchId, winnerTeamId, score);

  if (!plan.ok) {
    if (plan.reason === 'match_not_found') throw new Error(`Match ${matchId} not found in bracket`);
    if (plan.reason === 'winner_conflict') {
      console.warn('[bracket]', matchId, 'ya estaba cerrado con', plan.current, '— ignoro', winnerTeamId);
      return { tournamentComplete: false, conflict: true, winnerTeamId: plan.current };
    }
    throw new Error(`Cannot advance ${matchId}: ${plan.reason}`);
  }

  if (plan.skip) {
    return plan.complete
      ? { tournamentComplete: true, championTeamId: winnerTeamId, alreadyAdvanced: true }
      : { tournamentComplete: false, nextMatchId: plan.nextId, alreadyAdvanced: true };
  }

  await rtdb.writeBracketMatch(tournamentId, matchId, plan.matchPatch);

  if (plan.complete) {
    await rtdb.writeTournament(tournamentId, plan.tournamentPatch);
    return { tournamentComplete: true, championTeamId: winnerTeamId };
  }

  await rtdb.writeBracketMatch(tournamentId, plan.nextId, plan.nextPatch);
  await rtdb.writeTournament(tournamentId, plan.tournamentPatch);

  return { tournamentComplete: false, nextMatchId: plan.nextId };
}

async function handleMatchEndEvent(tournamentId, matchId, payload) {
  const winnerTeamId = payload.winnerTeamId;
  if (!winnerTeamId) return null;

  await rtdb.writeMatchLive(tournamentId, matchId, {
    status: 'finished',
    winnerTeamId,
    scoreCT: payload.scoreCT,
    scoreT: payload.scoreT,
    durationSeconds: payload.durationSeconds,
    mvp: payload.mvp || null,
    kills: payload.kills || {},
  });

  return advanceWinner(tournamentId, matchId, winnerTeamId, {
    scoreCT: payload.scoreCT,
    scoreT: payload.scoreT,
  });
}

module.exports = {
  buildSingleElimBracket,
  slotForFeeder,
  peerFeederId,
  shouldSeedBracket,
  teamIdsForMatch,
  planAdvance,
  advanceWinner,
  handleMatchEndEvent,
};
