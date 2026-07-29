/**
 * EXP Nexus por partidas de torneo
 * =================================
 * Los servidores privados de los torneos escriben el resultado de cada partida
 * en tournamentMatchResults/{uid}/{resultId} con credenciales de Admin SDK (el
 * cliente solo lee: database.rules.json tiene .write false ahí). Ese nodo ya lo
 * consume welcome-overlay.js para lanzar la animación 3D de victoria/derrota,
 * pero hasta ahora jugar un torneo no daba ni un punto de EXP.
 *
 * Forma real del nodo, tal y como la lee welcome-overlay.js:
 *   { at, result, tournamentName, teamName, opponentName, score, map }
 * El único campo que decide el premio es `result` ('win' / 'loss').
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');

const nexusXp = require('./nexusXp');

const WIN_XP = nexusXp.XP_ACTIONS.tournament_win.max;
const LOSS_XP = nexusXp.XP_ACTIONS.tournament_loss.max;

// Se aceptan las variantes que puede mandar un servidor de partidas ajeno al
// repositorio; el empate cobra como derrota porque también se jugó.
const WIN_RESULTS = { win: true, won: true, victory: true, victoria: true, ganada: true };
const LOSS_RESULTS = {
  loss: true, lose: true, lost: true, defeat: true, derrota: true, perdida: true,
  draw: true, tie: true, empate: true
};

exports.awardTournamentMatchXp = functions.database
  .ref('/tournamentMatchResults/{uid}/{resultId}')
  .onCreate(async (snap, context) => {
    const uid = context.params.uid;
    const resultId = context.params.resultId;
    const match = snap.val() || {};
    const result = String(match.result || '').trim().toLowerCase();

    let amount = 0;
    let actionKey = '';
    if (WIN_RESULTS[result]) {
      amount = WIN_XP;
      actionKey = 'tournament_win';
    } else if (LOSS_RESULTS[result]) {
      amount = LOSS_XP;
      actionKey = 'tournament_loss';
    } else {
      // Sin un resultado reconocible no se reparte nada: es preferible no dar
      // EXP a repartirla por un campo que no sabemos leer.
      console.warn(`[tournamentXp] ${uid}/${resultId}: resultado "${result || 'vacío'}" desconocido; sin EXP.`);
      return null;
    }

    // Cerrojo dentro del propio resultado: la idempotencia es por resultId, que
    // es justo lo que se repetiría si el trigger se reintentara. onCreate no
    // vuelve a dispararse por añadir este hijo.
    const claim = await snap.ref.child('xpAwarded').transaction((cur) => {
      if (cur) return;
      return { actionKey, at: Date.now() };
    });
    if (!claim.committed || !claim.snapshot.exists()) return null;

    try {
      const res = await nexusXp.grantXpInternal(uid, amount, actionKey, {
        source: 'Torneo: ' + (match.tournamentName || 'partida')
      });
      await snap.ref.child('xpAwarded').update({
        granted: res.granted,
        at: admin.database.ServerValue.TIMESTAMP
      });
      return null;
    } catch (err) {
      console.error(`[tournamentXp] ${uid}/${resultId}: no se pudo otorgar EXP`, err);
      return null;
    }
  });
