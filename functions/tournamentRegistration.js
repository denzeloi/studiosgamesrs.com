/**
 * Inscripción de equipos en torneos.
 * ==========================================================================
 * Antes esto lo hacía el cliente: el capitán escribía directamente
 * `tournaments/{tid}/registeredTeams/{teamId} = true` y las reglas se lo
 * permitían por ser capitán. Eso dejaba fuera todas las comprobaciones de
 * negocio: se podía entrar sin invitación, en un torneo lleno, en uno que ya
 * estaba en vivo, con dos jugadores, y sin pagar la cuota de inscripción.
 *
 * Aquí se hace todo en el servidor y en este orden:
 *   1. quién eres (capitán del equipo) y si te invitaron;
 *   2. si el torneo admite equipos ahora mismo;
 *   3. si el roster llega al tamaño que pide el torneo;
 *   4. se reserva la plaza con una transacción sobre `registeredTeams`, que es
 *      lo que impide que dos capitanes se queden con la última a la vez;
 *   5. se cobra la cuota al capitán, y si el cobro falla se devuelve la plaza;
 *   6. se escribe la foto del roster, se borra la invitación por los dos lados
 *      y se avisa al resto del equipo.
 *
 * La foto del roster la construye el servidor leyendo `teams/{teamId}` y los
 * perfiles: el capitán ya no puede publicar una plantilla inventada ni marcar
 * Steam vinculado cuando no lo está.
 *
 * Falta Steam no bloquea la inscripción a propósito: se puede vincular después
 * y antes del partido. Se devuelve la cuenta para que el Hub lo avise.
 *
 * === Instalación (functions/index.js) ===
 *   const tournamentRegistration = require('./tournamentRegistration');
 *   exports.acceptTournamentRegistration = tournamentRegistration.acceptTournamentRegistration;
 *   exports.declineTournamentInviteAsCaptain = tournamentRegistration.declineTournamentInviteAsCaptain;
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

const DEFAULT_TEAM_SIZE = 5;

/** Estados en los que un torneo todavía admite inscripciones. */
const OPEN_STATUSES = ['', 'pendiente', 'pending', 'draft', 'inscripciones', 'registration'];

function normalizeStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function steamIdOf(user) {
  if (!user) return null;
  const raw = String(user.steamID || (user.steam && user.steam.steamid) || '').trim();
  return /^\d{17}$/.test(raw) ? raw : null;
}

function rosterUids(team) {
  const roster = (team && (team.roster || team.members)) || {};
  const uids = Object.keys(roster);
  if (team && team.captain && uids.indexOf(team.captain) === -1) uids.push(team.captain);
  return uids;
}

function roleOf(team, uid) {
  const roster = (team && (team.roster || team.members)) || {};
  const entry = roster[uid];
  if (entry && typeof entry === 'object' && entry.role) return String(entry.role);
  return team && team.captain === uid ? 'Captain' : 'Member';
}

/** Cuántos jugadores exige el torneo: campo explícito, o el "5v5", o 5. */
function requiredTeamSize(tournament) {
  const explicit = Number(tournament && tournament.playersPerTeam);
  if (explicit > 0) return Math.floor(explicit);
  const modality = String((tournament && tournament.modality) || '');
  const match = modality.match(/^(\d+)\s*v/i);
  if (match) return Number(match[1]);
  return DEFAULT_TEAM_SIZE;
}

function tournamentCapacity(tournament) {
  const max = Number(tournament && tournament.maxTeams);
  if (max > 0) return Math.floor(max);
  const nested = Number(tournament && tournament.teams && tournament.teams.max);
  return nested > 0 ? Math.floor(nested) : 0;
}

function entryFeeOf(tournament) {
  const nested = Number(tournament && tournament.prizes && tournament.prizes.entryFee);
  if (nested > 0) return Math.floor(nested);
  const flat = Number(tournament && tournament.entryFee);
  return flat > 0 ? Math.floor(flat) : 0;
}

/**
 * Misma forma que la foto que pintaba el cliente (`tournament-roster.js`), pero
 * construida en el servidor. El SteamID64 no se copia: este nodo lo lee
 * cualquiera que vea el torneo, y basta con saber si está vinculado.
 */
async function buildRosterSnapshot(db, teamId, team) {
  const uids = rosterUids(team);
  const reads = uids.map(async (uid) => {
    try {
      const snap = await db.ref('users/' + uid).once('value');
      return { uid, user: snap.val() || {} };
    } catch (err) {
      return { uid, user: {} };
    }
  });

  const rows = await Promise.all(reads);
  const players = {};
  let steamReady = 0;

  rows.forEach((row) => {
    const linked = !!steamIdOf(row.user);
    if (linked) steamReady += 1;
    players[row.uid] = {
      nick: row.user.nick || row.user.displayName || row.uid,
      role: roleOf(team, row.uid),
      steam: linked
    };
  });

  return {
    name: team.name || teamId,
    emblem: team.emblem || team.photoURL || null,
    captain: team.captain || null,
    uids,
    size: uids.length,
    steamReady,
    players,
    updatedAt: Date.now()
  };
}

/**
 * Reserva la plaza de forma atómica. Devuelve el número de equipos inscritos
 * tras entrar, o lanza si el torneo se llenó mientras tanto.
 *
 * La transacción va sobre el mapa entero de inscritos porque el cupo depende de
 * cuántos hay, no del equipo concreto: dos capitanes simultáneos reintentan y
 * solo uno se queda con la última plaza.
 */
async function claimSlot(db, tournamentId, teamId, capacity) {
  const ref = db.ref('tournaments/' + tournamentId + '/registeredTeams');
  const result = await ref.transaction((current) => {
    const teams = current || {};
    if (teams[teamId]) return; // aborta: ya estaba dentro
    const count = Object.keys(teams).filter((k) => teams[k]).length;
    if (capacity > 0 && count >= capacity) return; // aborta: lleno
    teams[teamId] = true;
    return teams;
  });

  if (!result.committed) {
    const teams = (result.snapshot && result.snapshot.val()) || {};
    if (teams[teamId]) {
      throw new functions.https.HttpsError('already-exists', 'Tu equipo ya está inscrito en este torneo.');
    }
    throw new functions.https.HttpsError('resource-exhausted', 'El torneo se acaba de llenar.');
  }

  const teams = result.snapshot.val() || {};
  return Object.keys(teams).filter((k) => teams[k]).length;
}

/** Cobra la cuota al capitán. Devuelve el saldo restante. */
async function chargeEntryFee(db, uid, fee) {
  const ref = db.ref('users/' + uid + '/tokens');
  const txn = await ref.transaction((current) => {
    if (current === null || typeof current === 'undefined') return current;
    if (current < fee) return; // aborta: saldo insuficiente
    return current - fee;
  });

  const balance = txn.snapshot.val();
  if (!txn.committed || balance === null || typeof balance === 'undefined') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'No tienes suficientes tokens para la inscripción (necesitas ' + fee + ').'
    );
  }
  return balance;
}

/** El capitán acepta la invitación e inscribe al equipo. */
exports.acceptTournamentRegistration = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const teamId = data && data.teamId;
  const tournamentId = data && data.tournamentId;

  if (!teamId || typeof teamId !== 'string' || !tournamentId || typeof tournamentId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o tournamentId.');
  }

  const db = admin.database();

  const [teamSnap, tournamentSnap, inviteSnap, nickSnap] = await Promise.all([
    db.ref('teams/' + teamId).once('value'),
    db.ref('tournaments/' + tournamentId).once('value'),
    db.ref('tournamentInvites/' + teamId + '/' + tournamentId).once('value'),
    db.ref('users/' + uid + '/nick').once('value')
  ]);

  if (!teamSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Equipo no encontrado.');
  }
  if (!tournamentSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Torneo no encontrado.');
  }

  const team = teamSnap.val() || {};
  const tournament = tournamentSnap.val() || {};

  if (team.captain !== uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo el capitán del equipo puede inscribirlo en un torneo.'
    );
  }

  if (!inviteSnap.exists()) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Tu equipo no tiene invitación a este torneo.'
    );
  }

  const status = normalizeStatus(tournament.status);
  if (OPEN_STATUSES.indexOf(status) === -1) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Este torneo ya no admite inscripciones (' + (tournament.status || 'estado desconocido') + ').'
    );
  }

  if ((tournament.registeredTeams || {})[teamId]) {
    throw new functions.https.HttpsError('already-exists', 'Tu equipo ya está inscrito en este torneo.');
  }

  const required = requiredTeamSize(tournament);
  const uids = rosterUids(team);
  if (uids.length < required) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Necesitas ' + required + ' jugadores en el equipo para inscribirte; ahora mismo hay ' + uids.length + '.'
    );
  }

  const capacity = tournamentCapacity(tournament);
  const fee = entryFeeOf(tournament);

  // A partir de aquí ya se toca la base: primero la plaza, luego el dinero.
  const registeredCount = await claimSlot(db, tournamentId, teamId, capacity);

  let balance = null;
  if (fee > 0) {
    try {
      balance = await chargeEntryFee(db, uid, fee);
    } catch (err) {
      // Sin cobro no hay inscripción: se devuelve la plaza para no dejarla
      // ocupada por un equipo que no ha pagado.
      await db.ref('tournaments/' + tournamentId + '/registeredTeams/' + teamId).remove().catch(() => {});
      throw err;
    }
  }

  const snapshot = await buildRosterSnapshot(db, teamId, team);
  const acceptedBy = nickSnap.val() || 'el capitán';
  const now = Date.now();

  const updates = {};
  updates['tournaments/' + tournamentId + '/registeredRosters/' + teamId] = snapshot;
  updates['tournaments/' + tournamentId + '/teams/registered'] = registeredCount;
  updates['tournaments/' + tournamentId + '/outboundInvites/' + teamId] = null;
  updates['tournamentInvites/' + teamId + '/' + tournamentId] = null;
  updates['tournamentRegistrations/' + teamId + '/' + tournamentId] = {
    tournamentName: tournament.name || tournament.title || 'Torneo',
    acceptedBy,
    acceptedAt: now,
    entryFeePaid: fee
  };
  if (fee > 0) {
    // Incremento del servidor y no suma sobre lo leído: dos equipos que se
    // inscriben a la vez sumarían los dos sobre el mismo valor viejo.
    updates['tournaments/' + tournamentId + '/prizes/collectedTokens'] =
      admin.database.ServerValue.increment(fee);
  }

  await db.ref().update(updates);

  return {
    success: true,
    teamId,
    tournamentId,
    registeredCount,
    size: snapshot.size,
    steamReady: snapshot.steamReady,
    steamPending: Math.max(0, snapshot.size - snapshot.steamReady),
    entryFeePaid: fee,
    tokensLeft: balance
  };
});

/**
 * Refresca la foto del roster de un equipo ya inscrito.
 *
 * Sirve para los equipos que se inscribieron antes de que existiera la foto y
 * para cuando el roster cambia entre la inscripción y el día del partido. La
 * rehace el servidor por el mismo motivo que la inscripción: el capitán ya no
 * puede publicar una plantilla a mano.
 */
exports.resyncTournamentRoster = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const teamId = data && data.teamId;
  const tournamentId = data && data.tournamentId;

  if (!teamId || typeof teamId !== 'string' || !tournamentId || typeof tournamentId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o tournamentId.');
  }

  const db = admin.database();
  const [teamSnap, registeredSnap] = await Promise.all([
    db.ref('teams/' + teamId).once('value'),
    db.ref('tournaments/' + tournamentId + '/registeredTeams/' + teamId).once('value')
  ]);

  const team = teamSnap.val();
  if (!team || team.captain !== uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo el capitán del equipo puede refrescar el roster del torneo.'
    );
  }
  if (registeredSnap.val() !== true) {
    throw new functions.https.HttpsError('failed-precondition', 'Este equipo no está inscrito en el torneo.');
  }

  const snapshot = await buildRosterSnapshot(db, teamId, team);
  await db.ref('tournaments/' + tournamentId + '/registeredRosters/' + teamId).set(snapshot);

  return {
    success: true,
    size: snapshot.size,
    steamReady: snapshot.steamReady,
    steamPending: Math.max(0, snapshot.size - snapshot.steamReady)
  };
});

/**
 * El capitán rechaza la invitación. Va por función porque el aviso vive en dos
 * sitios y el del panel del Commander (`outboundInvites`) el cliente no lo
 * puede borrar: antes se quedaba ahí como pendiente para siempre.
 */
exports.declineTournamentInviteAsCaptain = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const uid = context.auth.uid;
  const teamId = data && data.teamId;
  const tournamentId = data && data.tournamentId;

  if (!teamId || typeof teamId !== 'string' || !tournamentId || typeof tournamentId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o tournamentId.');
  }

  const db = admin.database();
  const captainSnap = await db.ref('teams/' + teamId + '/captain').once('value');
  if (captainSnap.val() !== uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo el capitán del equipo puede rechazar invitaciones.'
    );
  }

  const updates = {};
  updates['tournamentInvites/' + teamId + '/' + tournamentId] = null;
  updates['tournaments/' + tournamentId + '/outboundInvites/' + teamId] = null;
  await db.ref().update(updates);

  return { success: true, teamId, tournamentId };
});
