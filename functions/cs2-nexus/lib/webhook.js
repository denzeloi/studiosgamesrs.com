'use strict';

const rtdb = require('./firebase-rtdb');
const matchzy = require('./matchzy');
const stats = require('./match-stats');
const bracket = require('./bracket');
const lifecycle = require('./lifecycle');
const orchestrator = require('./orchestrator');
const verification = require('./verification');

const RECENT_KILLS_MAX = 8;

/**
 * Rounds are needed to turn raw damage into ADR. Older plugin builds did not
 * report them, and the score sum is exact for a completed match.
 */
function roundsPlayedFrom(body) {
  const reported = Number(body.roundsPlayed);
  if (Number.isFinite(reported) && reported > 0) return reported;
  const fromScore = (Number(body.scoreCT) || 0) + (Number(body.scoreT) || 0);
  return fromScore > 0 ? fromScore : 1;
}

/**
 * Builds the public scoreboard. The raw payload is keyed by SteamID64 and must
 * never be written to partida_en_vivo, which anyone can read.
 */
async function scoreboardFor(tournamentId, matchId, body) {
  const rounds = roundsPlayedFrom(body);
  const steamMap = await stats.getSteamMap(tournamentId, matchId);
  return {
    rounds: rounds,
    rows: stats.buildScoreboard(body.players, rounds, steamMap),
  };
}

async function resolveWinner(tournamentId, matchId, body) {
  if (body.winnerTeamId) return { teamId: body.winnerTeamId, reason: 'reported' };
  const config = await matchzy.getStoredMatchConfig(tournamentId, matchId);
  return stats.resolveWinnerTeamId(config, stats.winnerSteamIdsFor(body));
}

function applySides(livePatch, sides) {
  if (!sides) return false;
  livePatch.sideByTeam = sides.sideByTeam;
  livePatch.team1Side = sides.team1Side;
  livePatch.team2Side = sides.team2Side;
  return true;
}

async function attachLiveSides(livePatch, tournamentId, matchId, body) {
  if (!body.ctSteamIds && !body.tSteamIds) return;
  const config = await matchzy.getStoredMatchConfig(tournamentId, matchId);
  applySides(livePatch, stats.resolveSideByTeam(config, body.ctSteamIds, body.tSteamIds));
}

/**
 * Bandos al arrancar. El marcador público no debe estar etiquetando a ojo
 * durante el calentamiento: el lado ya se fijó al lanzar y está en el config,
 * así que se publica desde el primer segundo y luego cada round_end lo corrige
 * con la plantilla real (cuchillo, cambio de mitad).
 */
async function attachStartingSides(livePatch, tournamentId, matchId) {
  if (!tournamentId || !matchId) return;
  const config = await matchzy.getStoredMatchConfig(tournamentId, matchId);
  applySides(livePatch, stats.sideByTeamAtStart(config));
}

function durationFromBody(body) {
  const reported = Number(body.durationSeconds);
  if (Number.isFinite(reported) && reported >= 0) return Math.floor(reported);
  return null;
}

/**
 * Cuenta el resultado por la campana a los dos rosters.
 *
 * El marcador del servidor viene por bandos (CT/T) y los bandos cambian a la
 * mitad, así que el resultado de cada equipo se arma desde el ganador: el que
 * gana se lleva el número alto. Si no se pudo resolver quién ganó, se avisa del
 * final sin repartir victoria, que es peor decir a un equipo que perdió.
 */
async function notifyResult(tournamentId, matchId, body, winner) {
  try {
    const bracketMatch = await rtdb.getBracketMatch(tournamentId, matchId);
    const teamA = bracketMatch && bracketMatch.teamA ? bracketMatch.teamA.teamId : null;
    const teamB = bracketMatch && bracketMatch.teamB ? bracketMatch.teamB.teamId : null;
    if (!teamA && !teamB) return;

    const tournament = await rtdb.getTournament(tournamentId);
    const tournamentName = (tournament && tournament.name) || 'tu torneo';
    const noticeId = `tourend_${tournamentId}_${matchId}`;
    const link = `/tournament-details?id=${tournamentId}`;
    const ct = Number(body.scoreCT) || 0;
    const t = Number(body.scoreT) || 0;
    const high = Math.max(ct, t);
    const low = Math.min(ct, t);

    if (!winner || !winner.teamId) {
      await rtdb.notifyTeamRosters([teamA, teamB], noticeId, {
        text: `Terminó tu partida de ${tournamentName} (${high}-${low}). Entra a ver las estadísticas.`,
        icon: 'fa-flag-checkered',
        link,
        type: 'tournament_result',
      });
      return;
    }

    const losers = [teamA, teamB].filter((id) => id && id !== winner.teamId);
    await rtdb.notifyTeamRosters([winner.teamId], noticeId, {
      text: `Ganaste ${high}-${low} en ${tournamentName}. Entra a ver las estadísticas.`,
      icon: 'fa-trophy',
      link,
      type: 'tournament_result',
    });
    if (losers.length) {
      await rtdb.notifyTeamRosters(losers, noticeId, {
        text: `Perdiste ${low}-${high} en ${tournamentName}. Entra a ver las estadísticas.`,
        icon: 'fa-flag-checkered',
        link,
        type: 'tournament_result',
      });
    }
  } catch (err) {
    // Avisar es lo último y lo menos importante: si falla, la partida ya quedó
    // cerrada, el cuadro avanzado y las estadísticas guardadas.
    console.warn('[webhook] no se pudo avisar del resultado:', err.message);
  }
}

/**
 * Deja el resultado en la ficha de cada jugador de los dos rosters.
 *
 * De ese nodo cuelgan la animación de victoria o derrota que sale al volver a
 * la página y la EXP de torneo. Nadie escribía ahí: el overlay llevaba desde el
 * principio escuchando un sitio vacío y la EXP no se repartió nunca.
 *
 * Solo se escribe con un ganador resuelto. El overlay trata cualquier resultado
 * que no diga 'loss' como victoria, así que un resultado a medias le diría a
 * los dos equipos que ganaron.
 */
async function publishMatchResults(tournamentId, matchId, body, winner, map) {
  if (!winner || !winner.teamId) return;
  try {
    const bracketMatch = await rtdb.getBracketMatch(tournamentId, matchId);
    const teamAId = bracketMatch && bracketMatch.teamA ? bracketMatch.teamA.teamId : null;
    const teamBId = bracketMatch && bracketMatch.teamB ? bracketMatch.teamB.teamId : null;
    if (!teamAId || !teamBId) return;

    const [teamA, teamB] = await Promise.all([
      rtdb.getTeamSummary(teamAId),
      rtdb.getTeamSummary(teamBId),
    ]);
    if (!teamA || !teamB) return;

    const tournament = await rtdb.getTournament(tournamentId);
    const tournamentName = (tournament && tournament.name) || '';
    const mapName = map || (tournament && tournament.activeMap) || '';
    // El marcador viene por bandos y los bandos cambian a la mitad: el número
    // alto es del ganador, sin más.
    const high = Math.max(Number(body.scoreCT) || 0, Number(body.scoreT) || 0);
    const low = Math.min(Number(body.scoreCT) || 0, Number(body.scoreT) || 0);
    const at = Date.now();
    const resultId = `${tournamentId}_${matchId}`;

    const entries = [];
    [[teamA, teamB], [teamB, teamA]].forEach(([team, rival]) => {
      const won = team.id === winner.teamId;
      team.uids.forEach((uid) => {
        entries.push({
          uid,
          data: {
            at,
            result: won ? 'win' : 'loss',
            tournamentId,
            matchId,
            tournamentName,
            teamName: team.name,
            opponentName: rival.name,
            score: won ? `${high}-${low}` : `${low}-${high}`,
            map: mapName,
          },
        });
      });
    });

    await rtdb.writeMatchResults(resultId, entries);
  } catch (err) {
    console.warn('[webhook] no se pudo publicar el resultado por jugador:', err.message);
  }
}

/**
 * La verificación cubre tres partidas de torneo y hasta ahora no las gastaba
 * nadie: la única forma de descontarlas era una llamada manual que nunca se
 * hacía. Se descuenta al terminar, no al lanzar, para no cobrar una partida que
 * se cayó antes de empezar.
 */
async function spendVerification(tournamentId, matchId) {
  try {
    const bracketMatch = await rtdb.getBracketMatch(tournamentId, matchId);
    const teamA = bracketMatch && bracketMatch.teamA ? bracketMatch.teamA.teamId : null;
    const teamB = bracketMatch && bracketMatch.teamB ? bracketMatch.teamB.teamId : null;
    const teams = [teamA, teamB].filter(Boolean);
    if (!teams.length) return;
    await verification.consumeForMatch(tournamentId, matchId, teams);
  } catch (err) {
    console.warn('[webhook] no se pudo descontar la verificación:', err.message);
  }
}

async function processMatchEvent(body) {
  const { event, tournamentId, matchId, serverId } = body;
  if (!event || !matchId) throw new Error('Invalid webhook payload');

  // El plugin no manda serverId (no lo conoce), así que escribirlo como null en
  // cada evento borraba el que dejó el lanzamiento. Se omite si no viene.
  const livePatch = {
    tournamentId: tournamentId || null,
    lastEvent: event,
    lastEventAt: Date.now(),
  };
  if (serverId) livePatch.serverId = serverId;

  switch (event) {
    case 'match_start':
      livePatch.status = 'live';
      livePatch.startedAt = Date.now();
      livePatch.durationSeconds = 0;
      livePatch.roster = body.roster || {};
      livePatch.phase = 'warmup';
      // Un relanzamiento reutiliza el mismo cruce y el mismo nodo: sin borrar
      // esto la sala arrancaba enseñando el feed y la tabla de la partida
      // anterior hasta que cayera la primera baja de la nueva.
      livePatch.recentKills = [];
      livePatch.scoreboard = null;
      livePatch.kills = null;
      livePatch.mvp = null;
      // Absent means the server is still running a plugin build from before
      // stats were tracked by SteamID, so match_end will never arrive.
      livePatch.pluginVersion = body.pluginVersion || 'legacy';
      await attachStartingSides(livePatch, tournamentId, matchId);
      if (tournamentId) {
        await rtdb.writeTournament(tournamentId, { status: 'en_vivo', activeMatchId: matchId });
        const startPatch = {
          status: 'live',
          startedAt: livePatch.startedAt,
          durationSeconds: 0,
        };
        if (serverId) startPatch.serverId = serverId;
        if (livePatch.sideByTeam) startPatch.sideByTeam = livePatch.sideByTeam;
        await rtdb.writeTournamentLiveMatch(tournamentId, matchId, startPatch);
      }
      break;

    case 'round_end': {
      livePatch.currentRound = body.round;
      livePatch.scoreCT = body.scoreCT;
      livePatch.scoreT = body.scoreT;
      livePatch.kills = body.kills || {};
      livePatch.phase = 'live';
      const dur = durationFromBody(body);
      if (dur != null) livePatch.durationSeconds = dur;
      if (body.players) {
        const live = await scoreboardFor(tournamentId, matchId, body);
        livePatch.scoreboard = live.rows;
        livePatch.roundsPlayed = live.rounds;
      }
      await attachLiveSides(livePatch, tournamentId, matchId, body);
      if (tournamentId) {
        const roundPatch = {
          status: 'live',
          scoreCT: body.scoreCT,
          scoreT: body.scoreT,
          currentRound: body.round,
        };
        // Igual que la duración: si esta ronda no dejó claro el bando (plantilla
        // incompleta, empate de coincidencias), se calla en vez de borrar el
        // que ya se publicó al arrancar.
        if (livePatch.sideByTeam) roundPatch.sideByTeam = livePatch.sideByTeam;
        if (dur != null) roundPatch.durationSeconds = dur;
        await rtdb.writeTournamentLiveMatch(tournamentId, matchId, roundPatch);
      }
      break;
    }

    /**
     * Quién está dentro antes de que empiece a contar el marcador.
     *
     * El calentamiento dura lo que tarde en llegar el último, y hasta ahora la
     * sala no tenía forma de enseñarlo: el primer dato que publicaba el
     * servidor era el final de la primera ronda.
     */
    case 'lobby': {
      const steamMap = await stats.getSteamMap(tournamentId, matchId);
      livePatch.lobby = stats.buildLobby(body.connected, steamMap);
      livePatch.phase = body.phase === 'live' ? 'live' : 'warmup';
      // El parte de sala llega desde que la máquina arranca, antes que ningún
      // match_start, así que es la primera y a veces única prueba de qué build
      // cargó el servidor.
      if (body.pluginVersion) livePatch.pluginVersion = body.pluginVersion;
      break;
    }

    case 'kill': {
      // Las últimas bajas, ya recortadas por el plugin. Se acota igual aquí
      // porque el nodo lo lee cualquiera y no puede crecer sin tope.
      livePatch.recentKills = Array.isArray(body.recentKills)
        ? body.recentKills.slice(0, RECENT_KILLS_MAX)
        : [];
      livePatch.kills = body.kills || {};
      // La tabla se movía solo al cerrar la ronda. Con la plantilla en cada
      // baja el tablero va al mismo ritmo que el feed, que es lo que se mira.
      if (body.players) {
        const live = await scoreboardFor(tournamentId, matchId, body);
        livePatch.scoreboard = live.rows;
        livePatch.roundsPlayed = live.rounds;
      }
      if (body.scoreCT != null) livePatch.scoreCT = body.scoreCT;
      if (body.scoreT != null) livePatch.scoreT = body.scoreT;
      if (body.phase) livePatch.phase = body.phase === 'live' ? 'live' : 'warmup';
      break;
    }

    case 'mvp':
      livePatch.lastMvp = body.mvp;
      break;

    case 'match_end': {
      livePatch.status = 'finished';
      livePatch.finishedAt = Date.now();
      // Se valida igual que en round_end y solo se escribe si viene: un build
      // viejo del plugin no lo manda, y machacar el campo con null borraría la
      // duración que ya había dejado la última ronda.
      const endDuration = durationFromBody(body);
      if (endDuration != null) livePatch.durationSeconds = endDuration;
      livePatch.scoreCT = body.scoreCT;
      livePatch.scoreT = body.scoreT;
      livePatch.winnerSide = body.winnerSide || null;

      const board = await scoreboardFor(tournamentId, matchId, body);
      const mvp = stats.pickMvp(board.rows);
      const winner = await resolveWinner(tournamentId, matchId, body);
      await attachLiveSides(livePatch, tournamentId, matchId, body);

      livePatch.scoreboard = board.rows;
      livePatch.roundsPlayed = board.rounds;
      livePatch.mvp = mvp;
      livePatch.winnerTeamId = winner.teamId || null;
      livePatch.winnerResolution = winner.reason || null;

      // El plugin no sabe en qué servidor corre, así que el que hay que cerrar
      // se busca en el cruce: sin esto la partida terminaba y el servidor se
      // quedaba marcado como si siguiera jugando.
      const entry = await rtdb.getTournamentLiveMatch(tournamentId, matchId);
      const endServerId = serverId || (entry && entry.serverId) || null;
      if (endServerId) {
        // Y con el fin de partida arranca la cuenta atrás del apagado: la
        // máquina factura hasta que se borra, y antes solo se borraba a mano.
        await rtdb.writeGameServer(String(endServerId), Object.assign({
          status: 'match_complete',
          lastMatchId: matchId,
        }, lifecycle.scheduleShutdownPatch(Date.now(), process.env)));
      }

      if (tournamentId) {
        await stats.saveMatchStats(tournamentId, matchId, {
          scoreboard: board.rows,
          roundsPlayed: board.rounds,
          mvp: mvp,
          scoreCT: body.scoreCT || 0,
          scoreT: body.scoreT || 0,
          winnerSide: body.winnerSide || null,
          winnerTeamId: winner.teamId || null,
          winnerResolution: winner.reason || null,
          finishedAt: Date.now(),
        });
        await stats.accumulateTournamentStats(tournamentId, board.rows, board.rounds);
        const endPatch = {
          status: 'finished',
          finishedAt: Date.now(),
          scoreCT: body.scoreCT,
          scoreT: body.scoreT,
          winnerTeamId: winner.teamId || null,
          mvp: mvp,
        };
        if (livePatch.sideByTeam) endPatch.sideByTeam = livePatch.sideByTeam;
        if (endDuration != null) endPatch.durationSeconds = endDuration;
        await rtdb.writeTournamentLiveMatch(tournamentId, matchId, endPatch);
      }

      if (tournamentId) {
        await notifyResult(tournamentId, matchId, body, winner);
        await publishMatchResults(tournamentId, matchId, body, winner, entry && entry.map);
        await spendVerification(tournamentId, matchId);
      }

      if (tournamentId && winner.teamId) {
        const advance = await bracket.handleMatchEndEvent(
          tournamentId,
          matchId,
          Object.assign({}, body, { winnerTeamId: winner.teamId, mvp: mvp, kills: body.kills || {} })
        );
        // Con el cuadro ya movido se decide qué pasa con la máquina: al cerrar
        // la primera semifinal se guarda para la final en vez de apagarse, y al
        // cerrar la segunda la final se queda con ella. Va después a propósito,
        // porque hasta aquí no se sabe si la siguiente ronda tiene cartel.
        try {
          await orchestrator.applyAfterMatchEnd(tournamentId, matchId, endServerId, advance);
        } catch (err) {
          // El resultado ya está guardado y el cuadro avanzado: quedarse sin
          // máquina caliente solo obliga al Commander a crear una.
          console.warn('[webhook] no se pudo preparar el servidor siguiente:', err.message);
        }
      } else if (tournamentId) {
        // The bracket stays put rather than advancing a guess; the War Room shows
        // the reason so the commander can pick the winner by hand.
        console.warn('[webhook] match_end without a resolvable winner', matchId, winner.reason);
      }
      break;
    }

    default:
      livePatch.raw = body;
  }

  await rtdb.writeMatchLive(tournamentId, matchId, livePatch);
  return { ok: true, event };
}

module.exports = { processMatchEvent };
