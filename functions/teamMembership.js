/**
 * Membresía de equipos — teamId server-side para acciones de capitán (SEC-010)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

const MAX_ROSTER = 10;

async function assertTeamCaptain(db, teamId, uid) {
  const snap = await db.ref('teams/' + teamId + '/captain').once('value');
  if (snap.val() !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Solo el capitán puede hacer esta acción.');
  }
}

async function loadTeam(db, teamId) {
  const snap = await db.ref('teams/' + teamId).once('value');
  if (!snap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Equipo no encontrado.');
  }
  return snap.val() || {};
}

function rosterCount(roster) {
  return roster ? Object.keys(roster).length : 0;
}

/** Capitán envía invitación a un jugador sin equipo (COMP-002). */
exports.sendTeamInvite = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const captainUid = context.auth.uid;
  const teamId = data && data.teamId;
  const targetUserId = data && data.targetUserId;
  if (!teamId || typeof teamId !== 'string' || !targetUserId || typeof targetUserId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o targetUserId.');
  }
  if (targetUserId === captainUid) {
    throw new functions.https.HttpsError('invalid-argument', 'No puedes invitarte a ti mismo.');
  }

  const db = admin.database();
  await assertTeamCaptain(db, teamId, captainUid);
  const team = await loadTeam(db, teamId);
  const roster = team.roster || {};

  if (roster[targetUserId]) {
    throw new functions.https.HttpsError('already-exists', 'Ese jugador ya está en el equipo.');
  }
  if (rosterCount(roster) >= MAX_ROSTER) {
    throw new functions.https.HttpsError('resource-exhausted', 'El equipo está lleno.');
  }

  const targetTeamSnap = await db.ref('users/' + targetUserId + '/teamId').once('value');
  if (targetTeamSnap.exists() && targetTeamSnap.val()) {
    throw new functions.https.HttpsError('failed-precondition', 'El jugador ya pertenece a otro equipo.');
  }

  const inviteRef = db.ref('teamInvites/' + targetUserId + '/' + teamId);
  const existingInvite = await inviteRef.once('value');
  if (existingInvite.exists()) {
    return { success: true, teamId: teamId, targetUserId: targetUserId, alreadySent: true };
  }

  const captainNickSnap = await db.ref('users/' + captainUid + '/nick').once('value');
  const invitedByNick = captainNickSnap.val() || 'Team Captain';

  await inviteRef.set({
    teamId: teamId,
    teamName: team.name || 'Team',
    teamEmblem: team.emblemUrl || null,
    invitedBy: invitedByNick,
    invitedByUid: captainUid,
    timestamp: admin.database.ServerValue.TIMESTAMP
  });

  return { success: true, teamId: teamId, targetUserId: targetUserId };
});

/** Capitán acepta solicitud de unión: actualiza roster y teamId del solicitante. */
exports.acceptTeamJoinRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const captainUid = context.auth.uid;
  const teamId = data && data.teamId;
  const userId = data && data.userId;
  if (!teamId || typeof teamId !== 'string' || !userId || typeof userId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o userId.');
  }

  const db = admin.database();
  await assertTeamCaptain(db, teamId, captainUid);
  const team = await loadTeam(db, teamId);
  const roster = team.roster || {};

  if (rosterCount(roster) >= MAX_ROSTER) {
    throw new functions.https.HttpsError('resource-exhausted', 'El equipo está lleno.');
  }
  if (roster[userId]) {
    throw new functions.https.HttpsError('already-exists', 'El usuario ya pertenece al equipo.');
  }

  const requestSnap = await db.ref('teamJoinRequests/' + teamId + '/' + userId).once('value');
  if (!requestSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'No hay solicitud pendiente para este usuario.');
  }

  const memberTeamSnap = await db.ref('users/' + userId + '/teamId').once('value');
  if (memberTeamSnap.exists() && memberTeamSnap.val() && memberTeamSnap.val() !== teamId) {
    throw new functions.https.HttpsError('failed-precondition', 'El usuario ya pertenece a otro equipo.');
  }

  const updates = {};
  updates['teams/' + teamId + '/roster/' + userId] = { role: 'Member' };
  updates['users/' + userId + '/teamId'] = teamId;
  updates['teamJoinRequests/' + teamId + '/' + userId] = null;
  updates['userJoinRequests/' + userId] = null;

  await db.ref().update(updates);
  return { success: true, teamId, userId };
});

/** Jugador acepta invitación pendiente en teamInvites/{uid}/{teamId} (COMP-001). */
exports.acceptTeamInvite = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const userId = context.auth.uid;
  const teamId = data && data.teamId;
  if (!teamId || typeof teamId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Falta teamId.');
  }

  const db = admin.database();

  const inviteSnap = await db.ref('teamInvites/' + userId + '/' + teamId).once('value');
  if (!inviteSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'No tienes invitación pendiente para este equipo.');
  }

  const memberTeamSnap = await db.ref('users/' + userId + '/teamId').once('value');
  if (memberTeamSnap.exists() && memberTeamSnap.val()) {
    await db.ref('teamInvites/' + userId).remove();
    throw new functions.https.HttpsError('failed-precondition', 'Ya perteneces a un equipo.');
  }

  const team = await loadTeam(db, teamId);
  const roster = team.roster || {};

  if (rosterCount(roster) >= MAX_ROSTER) {
    throw new functions.https.HttpsError('resource-exhausted', 'El equipo está lleno.');
  }
  if (roster[userId]) {
    await db.ref('teamInvites/' + userId + '/' + teamId).remove();
    throw new functions.https.HttpsError('already-exists', 'Ya perteneces a este equipo.');
  }

  const updates = {};
  updates['teams/' + teamId + '/roster/' + userId] = { role: 'Member' };
  updates['users/' + userId + '/teamId'] = teamId;
  updates['teamInvites/' + userId + '/' + teamId] = null;
  updates['userJoinRequests/' + userId] = null;

  await db.ref().update(updates);
  return { success: true, teamId, userId };
});

/** Miembro (no capitán) abandona el equipo (COMP-001). */
exports.leaveTeam = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const userId = context.auth.uid;
  const teamId = data && data.teamId;
  if (!teamId || typeof teamId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Falta teamId.');
  }

  const db = admin.database();
  const team = await loadTeam(db, teamId);

  if (team.captain === userId) {
    throw new functions.https.HttpsError('failed-precondition', 'El capitán debe disolver el equipo, no abandonarlo.');
  }

  const roster = team.roster || {};
  if (!roster[userId]) {
    throw new functions.https.HttpsError('not-found', 'No perteneces a este equipo.');
  }

  const userTeamSnap = await db.ref('users/' + userId + '/teamId').once('value');
  if (userTeamSnap.val() && userTeamSnap.val() !== teamId) {
    throw new functions.https.HttpsError('failed-precondition', 'Tu perfil apunta a otro equipo.');
  }

  const updates = {};
  updates['teams/' + teamId + '/roster/' + userId] = null;
  updates['users/' + userId + '/teamId'] = null;

  await db.ref().update(updates);
  return { success: true, teamId, userId };
});

/** Capitán disuelve el equipo y limpia teamId de todos los miembros. */
exports.disbandTeam = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const captainUid = context.auth.uid;
  const teamId = data && data.teamId;
  if (!teamId || typeof teamId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Falta teamId.');
  }

  const db = admin.database();
  const team = await loadTeam(db, teamId);
  if (team.captain !== captainUid) {
    throw new functions.https.HttpsError('permission-denied', 'Solo el capitán puede disolver el equipo.');
  }

  const updates = {};
  const roster = team.roster || {};
  Object.keys(roster).forEach(function (uid) {
    updates['users/' + uid + '/teamId'] = null;
  });
  updates['teams/' + teamId] = null;
  updates['teamJoinRequests/' + teamId] = null;
  updates['teamChats/' + teamId] = null;

  await db.ref().update(updates);
  return { success: true, teamId };
});

/** Capitán expulsa a un miembro (no al capitán). */
exports.kickTeamMember = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const captainUid = context.auth.uid;
  const teamId = data && data.teamId;
  const memberUid = data && data.memberUid;
  if (!teamId || typeof teamId !== 'string' || !memberUid || typeof memberUid !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Faltan teamId o memberUid.');
  }
  if (memberUid === captainUid) {
    throw new functions.https.HttpsError('invalid-argument', 'El capitán no puede expulsarse a sí mismo.');
  }

  const db = admin.database();
  await assertTeamCaptain(db, teamId, captainUid);
  const team = await loadTeam(db, teamId);
  const roster = team.roster || {};
  const member = roster[memberUid];
  if (!member) {
    throw new functions.https.HttpsError('not-found', 'El usuario no pertenece a este equipo.');
  }
  if ((member.role || '').toLowerCase() === 'captain') {
    throw new functions.https.HttpsError('permission-denied', 'No se puede expulsar al capitán.');
  }

  const updates = {};
  updates['teams/' + teamId + '/roster/' + memberUid] = null;
  updates['users/' + memberUid + '/teamId'] = null;

  await db.ref().update(updates);
  return { success: true, teamId, memberUid };
});
