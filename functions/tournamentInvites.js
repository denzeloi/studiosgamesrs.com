/**

 * Invitaciones a torneos por equipo (COMP-003).

 */

const functions = require('firebase-functions');

const admin = require('firebase-admin');



function normalizeRango(r) {

  return String(r || '').toLowerCase().replace(/\s+/g, '_');

}



function isCommanderRango(rango) {

  var r = normalizeRango(rango);

  return r === 'commander' || r === 'boss_of_the_state';

}



async function loadTournament(db, tournamentId) {

  const snap = await db.ref('tournaments/' + tournamentId).once('value');

  if (!snap.exists()) {

    throw new functions.https.HttpsError('not-found', 'Torneo no encontrado.');

  }

  return snap.val() || {};

}



async function assertCanSendTournamentInvite(db, tournamentId, uid) {

  const tournament = await loadTournament(db, tournamentId);

  const organizerUid = (tournament.organizer && tournament.organizer.uid) || tournament.creatorUid;

  if (organizerUid === uid) {

    return tournament;

  }

  const rangoSnap = await db.ref('users/' + uid + '/rango').once('value');

  if (isCommanderRango(rangoSnap.val())) {

    return tournament;

  }

  throw new functions.https.HttpsError(

    'permission-denied',

    'Solo el organizador del torneo o un Commander puede enviar invitaciones.'

  );

}



/** Organizador / Commander invita a un equipo al torneo. */

exports.sendTournamentInvite = functions.https.onCall(async (data, context) => {

  if (!context.auth) {

    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');

  }



  const senderUid = context.auth.uid;

  const teamId = data && data.teamId;

  const tournamentId = data && data.tournamentId;

  if (!teamId || typeof teamId !== 'string' || !tournamentId || typeof tournamentId !== 'string') {

    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o tournamentId.');

  }



  const db = admin.database();

  const tournament = await assertCanSendTournamentInvite(db, tournamentId, senderUid);



  const teamSnap = await db.ref('teams/' + teamId).once('value');

  if (!teamSnap.exists()) {

    throw new functions.https.HttpsError('not-found', 'Equipo no encontrado.');

  }

  const team = teamSnap.val() || {};



  const reg = tournament.registeredTeams || {};

  if (reg[teamId]) {

    throw new functions.https.HttpsError('already-exists', 'Este equipo ya está inscrito.');

  }



  // El cupo se escribe en dos sitios; el creador nuevo usa maxTeams.

  const max = Number(tournament.maxTeams) || Number(tournament.teams && tournament.teams.max) || 0;

  const regCount = Object.keys(reg).filter(function (k) { return reg[k]; }).length;

  if (max > 0 && regCount >= max) {

    throw new functions.https.HttpsError('resource-exhausted', 'El torneo está lleno.');

  }



  // Las invitaciones sin responder también ocupan sitio: si no se cuentan, se

  // pueden invitar veinte equipos a un torneo de cuatro y los cuatro primeros

  // en aceptar dejan fuera al resto sin avisar.

  const pending = tournament.outboundInvites || {};

  const pendingCount = Object.keys(pending).filter(function (k) {

    return k !== teamId && !reg[k];

  }).length;

  if (max > 0 && regCount + pendingCount >= max) {

    throw new functions.https.HttpsError(

      'resource-exhausted',

      'No quedan plazas libres: ' + regCount + ' inscritos y ' + pendingCount + ' invitaciones sin responder para ' + max + ' plazas.'

    );

  }



  const inviteRef = db.ref('tournamentInvites/' + teamId + '/' + tournamentId);

  const existing = await inviteRef.once('value');

  if (existing.exists()) {

    return { success: true, teamId: teamId, tournamentId: tournamentId, alreadySent: true };

  }



  const senderNickSnap = await db.ref('users/' + senderUid + '/nick').once('value');

  const invitedBy = senderNickSnap.val() || 'Staff del torneo';

  const now = admin.database.ServerValue.TIMESTAMP;



  const updates = {};

  updates['tournamentInvites/' + teamId + '/' + tournamentId] = {

    tournamentId: tournamentId,

    tournamentName: tournament.name || tournament.title || 'Torneo',

    invitedBy: invitedBy,

    invitedByUid: senderUid,

    timestamp: now

  };

  updates['tournaments/' + tournamentId + '/outboundInvites/' + teamId] = {

    teamId: teamId,

    teamName: team.name || 'Equipo',

    sentAt: now,

    sentByUid: senderUid,

    sentByNick: invitedBy

  };



  await db.ref().update(updates);

  return { success: true, teamId: teamId, tournamentId: tournamentId };

});



/** Retira invitación pendiente (organizador / Commander). */

exports.cancelTournamentInvite = functions.https.onCall(async (data, context) => {

  if (!context.auth) {

    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');

  }



  const uid = context.auth.uid;

  const teamId = data && data.teamId;

  const tournamentId = data && data.tournamentId;

  if (!teamId || !tournamentId) {

    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o tournamentId.');

  }



  const db = admin.database();

  await assertCanSendTournamentInvite(db, tournamentId, uid);



  const updates = {};

  updates['tournamentInvites/' + teamId + '/' + tournamentId] = null;

  updates['tournaments/' + tournamentId + '/outboundInvites/' + teamId] = null;

  await db.ref().update(updates);

  return { success: true };

});


