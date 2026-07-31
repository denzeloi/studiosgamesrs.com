/* tournament-roster.js — foto del roster al inscribirse en un torneo
 * ===========================================================================
 * Cuando el capitán acepta la invitación, el torneo tiene que saber QUIÉNES
 * entran, no solo qué equipo. Antes solo se escribía
 * `tournaments/{tid}/registeredTeams/{teamId} = true` y el roster real vivía
 * únicamente en `teams/{teamId}`, que cambia con el tiempo: si alguien se iba
 * del equipo después de inscribirse, no quedaba rastro de con quién se aceptó.
 *
 * Esta foto se guarda en `tournaments/{tid}/registeredRosters/{teamId}` y la
 * usan tres sitios:
 *   - tournament-details, para saber si quien mira es JUGADOR (y enseñarle la
 *     IP y las reglas) o espectador;
 *   - la sala del torneo, para listar los 5/6 de cada equipo;
 *   - el Commander, para ver de un vistazo a quién le falta vincular Steam
 *     antes de lanzar (sin eso MatchZy no sabe de qué equipo es cada jugador).
 *
 * La fuente de verdad para lanzar la partida sigue siendo `teams/{teamId}`
 * (functions/cs2-nexus/lib/matchzy.js): esto es una foto para la web, no un
 * duplicado autoritativo. Por eso se puede resincronizar cuando el capitán
 * vuelve a entrar.
 *
 * Escribir aquí solo lo permite el capitán del equipo (database.rules.json).
 */
(function (global) {
  'use strict';

  // Plantilla estándar de CS2. Solo se usa para el "n/5" de la interfaz.
  var DEFAULT_TEAM_SIZE = 5;

  function db() {
    return global.firebase && global.firebase.database ? global.firebase.database() : null;
  }

  /** SteamID64 vinculado, o null. Sin él MatchZy no puede colocar al jugador. */
  function steamIdOf(user) {
    if (!user) return null;
    var raw = user.steamID || (user.steam && user.steam.steamid) || '';
    raw = String(raw).trim();
    return /^\d{17}$/.test(raw) ? raw : null;
  }

  function rosterUids(team) {
    var roster = (team && (team.roster || team.members)) || {};
    var uids = Object.keys(roster);
    if (team && team.captain && uids.indexOf(team.captain) === -1) uids.push(team.captain);
    return uids;
  }

  function roleOf(team, uid) {
    var roster = (team && (team.roster || team.members)) || {};
    var entry = roster[uid];
    if (entry && typeof entry === 'object' && entry.role) return String(entry.role);
    return (team && team.captain === uid) ? 'Captain' : 'Member';
  }

  /**
   * Foto del equipo tal y como está AHORA. Lee el perfil de cada miembro para
   * quedarse con el nick y si tiene Steam vinculado; el SteamID64 en sí no se
   * copia, que este nodo lo puede leer cualquiera que vea el torneo.
   */
  function snapshotFor(teamId, teamData) {
    var database = db();
    if (!database || !teamId) return Promise.resolve(null);

    var load = teamData
      ? Promise.resolve(teamData)
      : database.ref('teams/' + teamId).once('value').then(function (snap) { return snap.val(); });

    return load.then(function (team) {
      if (!team) return null;
      var uids = rosterUids(team);
      var reads = uids.map(function (uid) {
        return database.ref('users/' + uid).once('value')
          .then(function (snap) { return { uid: uid, user: snap.val() || {} }; })
          .catch(function () { return { uid: uid, user: {} }; });
      });

      return Promise.all(reads).then(function (rows) {
        var players = {};
        var steamReady = 0;
        rows.forEach(function (row) {
          var linked = !!steamIdOf(row.user);
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
          uids: uids,
          size: uids.length,
          steamReady: steamReady,
          players: players,
          updatedAt: Date.now()
        };
      });
    });
  }

  /**
   * Rutas que hay que escribir para dejar al equipo dentro del torneo, para
   * que quien llame pueda meterlas en un `update()` atómico junto con el
   * borrado de la invitación.
   */
  function registrationUpdates(tournamentId, teamId, snapshot) {
    var updates = {};
    if (!tournamentId || !teamId) return updates;
    updates['tournaments/' + tournamentId + '/registeredTeams/' + teamId] = true;
    if (snapshot) {
      updates['tournaments/' + tournamentId + '/registeredRosters/' + teamId] = snapshot;
    }
    return updates;
  }

  /** ¿La foto guardada sigue coincidiendo con el equipo de hoy? */
  function isStale(saved, fresh) {
    if (!fresh) return false;
    if (!saved || !saved.players || !saved.uids) return true;
    if (Number(saved.size) !== Number(fresh.size)) return true;
    if (Number(saved.steamReady) !== Number(fresh.steamReady)) return true;
    if (String(saved.name || '') !== String(fresh.name || '')) return true;
    var savedUids = Array.isArray(saved.uids) ? saved.uids.slice().sort() : [];
    var freshUids = fresh.uids.slice().sort();
    return savedUids.join(',') !== freshUids.join(',');
  }

  /**
   * Rellena o refresca la foto. Pensado para equipos que se inscribieron antes
   * de que esto existiera y para cuando el roster cambia entre la inscripción
   * y el día del partido. Solo hace algo si quien lo pide es el capitán, que es
   * el único con permiso de escritura en ese nodo.
   */
  function ensureSnapshot(tournamentId, teamId, uid) {
    var database = db();
    if (!database || !tournamentId || !teamId || !uid) return Promise.resolve(null);

    return database.ref('teams/' + teamId).once('value').then(function (snap) {
      var team = snap.val();
      if (!team || team.captain !== uid) return null;

      return Promise.all([
        database.ref('tournaments/' + tournamentId + '/registeredRosters/' + teamId).once('value'),
        snapshotFor(teamId, team)
      ]).then(function (res) {
        var saved = res[0].val();
        var fresh = res[1];
        if (!fresh || !isStale(saved, fresh)) return null;
        return database.ref('tournaments/' + tournamentId + '/registeredRosters/' + teamId)
          .set(fresh)
          .then(function () { return fresh; })
          .catch(function () { return null; });
      });
    }).catch(function () { return null; });
  }

  /** Lista ordenada de jugadores de una foto: capitán primero, luego por nick. */
  function playersOf(entry) {
    if (!entry) return [];
    var players = entry.players || {};
    var uids = Object.keys(players);
    if (!uids.length && Array.isArray(entry.uids)) {
      return entry.uids.map(function (uid) {
        return { uid: uid, nick: uid, role: uid === entry.captain ? 'Captain' : 'Member', steam: null };
      });
    }
    return uids.map(function (uid) {
      var p = players[uid] || {};
      return {
        uid: uid,
        nick: p.nick || uid,
        role: p.role || (uid === entry.captain ? 'Captain' : 'Member'),
        steam: p.steam === true
      };
    }).sort(function (a, b) {
      var ca = a.role === 'Captain' ? 0 : 1;
      var cb = b.role === 'Captain' ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return String(a.nick).localeCompare(String(b.nick));
    });
  }

  global.SGTournamentRoster = {
    DEFAULT_TEAM_SIZE: DEFAULT_TEAM_SIZE,
    snapshotFor: snapshotFor,
    registrationUpdates: registrationUpdates,
    ensureSnapshot: ensureSnapshot,
    playersOf: playersOf,
    isStale: isStale
  };
})(typeof window !== 'undefined' ? window : this);
