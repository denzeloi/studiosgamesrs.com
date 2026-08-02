'use strict';

/**
 * Verificación de equipo en el circuito de torneos.
 * ==========================================================================
 * Un equipo se verifica pagando entre todos sus miembros, y esa verificación
 * vale para tres partidas de torneo. El problema era que nadie la miraba: se
 * podía jugar un torneo oficial sin verificar, y las tres partidas no las
 * descontaba nadie porque la función que lo hace solo se podía llamar a mano.
 *
 * No se puede exigir al inscribirse, porque pagar la verificación requiere estar
 * ya inscrito en un torneo. Así que la puerta se pone justo antes de lanzar la
 * partida, que es cuando el equipo ya tuvo tiempo de pagarla, y se descuenta una
 * cuando la partida termina.
 *
 * El Commander puede saltarse la puerta para amistosos o pruebas.
 */

const admin = require('firebase-admin');

const VERIFIED = 'verified';

function db() {
  return admin.database();
}

/** Estado de verificación de un equipo, tolerante con datos viejos. */
function statusOf(team) {
  const v = (team && team.verification) || {};
  const status = String(v.status || 'unverified').toLowerCase();
  const remaining = Number(v.matchesRemaining);
  return {
    verified: status === VERIFIED && (!Number.isFinite(remaining) || remaining > 0),
    status,
    matchesRemaining: Number.isFinite(remaining) ? remaining : 0,
  };
}

/**
 * De la pareja que va a jugar, cuáles no pueden. Devuelve nombre y motivo para
 * que el Commander sepa a quién avisar sin ir a buscarlo.
 */
function blockingTeams(entries) {
  return (entries || [])
    .filter((entry) => entry && entry.teamId)
    .map((entry) => {
      const state = statusOf(entry.team);
      if (state.verified) return null;
      return {
        teamId: entry.teamId,
        name: (entry.team && entry.team.name) || entry.name || entry.teamId,
        status: state.status,
        matchesRemaining: state.matchesRemaining,
      };
    })
    .filter(Boolean);
}

function blockedMessage(blocked) {
  const names = blocked.map((b) => b.name).join(' y ');
  const plural = blocked.length > 1;
  return 'Falta verificar ' + (plural ? 'a los equipos ' : 'al equipo ') + names + '. '
    + 'Cada miembro paga su parte desde el Competition Hub, y la verificación vale para tres partidas. '
    + 'Si es un amistoso o una prueba, lanza marcando que permites equipos sin verificar.';
}

/** Comprueba los dos equipos del cruce contra la base. */
async function checkTeams(teamIds) {
  const ids = (teamIds || []).filter(Boolean);
  if (!ids.length) return { blocked: [], checked: [] };

  const entries = await Promise.all(ids.map(async (teamId) => {
    const snap = await db().ref('teams/' + teamId).once('value');
    return { teamId: String(teamId), team: snap.val() || null };
  }));

  return { blocked: blockingTeams(entries), checked: entries.map((e) => e.teamId) };
}

/** Una partida menos. Al llegar a cero el equipo vuelve a estar sin verificar. */
function spendOne(v) {
  if (!v || String(v.status || '').toLowerCase() !== VERIFIED) return v;
  const remaining = (Number(v.matchesRemaining) || 0) - 1;
  if (remaining <= 0) {
    return Object.assign({}, v, { status: 'unverified', matchesRemaining: 0, payments: null });
  }
  return Object.assign({}, v, { matchesRemaining: remaining });
}

/**
 * Descuenta una partida a los dos equipos, una sola vez por cruce.
 *
 * El sello va primero y por transacción: si el servidor reenvía el fin de
 * partida, el segundo intento no encuentra hueco y no vuelve a descontar.
 */
async function consumeForMatch(tournamentId, matchId, teamIds) {
  const ids = (teamIds || []).filter(Boolean);
  if (!tournamentId || !matchId || !ids.length) return { consumed: [], skipped: true };

  const guard = db().ref(
    'tournaments/' + tournamentId + '/liveMatches/' + matchId + '/verificationConsumedAt'
  );
  const claim = await guard.transaction((current) => (current ? undefined : Date.now()));
  if (!claim.committed) return { consumed: [], skipped: true, reason: 'already_consumed' };

  const consumed = [];
  for (const teamId of ids) {
    try {
      const res = await db().ref('teams/' + teamId + '/verification').transaction(spendOne);
      const v = (res.snapshot && res.snapshot.val()) || {};
      consumed.push({
        teamId: String(teamId),
        status: v.status || 'unverified',
        matchesRemaining: Number(v.matchesRemaining) || 0,
      });
    } catch (err) {
      console.warn('[verification] no se pudo descontar a', teamId, err.message);
    }
  }

  return { consumed, skipped: false };
}

module.exports = {
  statusOf,
  blockingTeams,
  blockedMessage,
  checkTeams,
  spendOne,
  consumeForMatch,
};
