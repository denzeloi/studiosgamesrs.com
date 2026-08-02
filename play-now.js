/**
 * "Juega ahora": la ventana de torneos del Competition Hub.
 *
 * Los torneos estaban al final de la página y las partidas en directo no se
 * veían desde aquí: había que entrar a la sala de cada torneo para saber si
 * alguien estaba jugando. Ahora el botón abre esta ventana con el marcador en
 * tiempo real delante y la lista de torneos debajo.
 *
 * De dónde salen los datos:
 *   tournaments/{id}                  → nombre, portada, estado, equipos
 *   partida_en_vivo/{torneo}/{cruce}  → marcador, ronda, bandos y tabla
 *
 * El marcador se lee del mismo sitio que la sala del torneo, así que lo que se
 * ve aquí y lo que se ve allí no pueden discrepar.
 */
(function (global) {
  'use strict';

  var LIVE_STATUSES = { en_vivo: true, live: true, active: true };
  var TOP_PLAYERS = 3;

  var state = {
    open: false,
    tournaments: {},
    live: {},
    liveRefs: {},
    teams: {},
    teamsPending: {},
    tournamentsRef: null,
    myTeamId: null,
    booted: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function db() {
    return (global.firebase && firebase.database) ? firebase.database() : null;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function emblemFor(teamId) {
    var team = state.teams[teamId];
    if (global.SGTeamEmblem) return global.SGTeamEmblem.urlFor(team, { small: true });
    return (team && team.emblemUrl) || '';
  }

  function emblemFallback() {
    return global.SGTeamEmblem ? global.SGTeamEmblem.DEFAULT_SMALL : '';
  }

  // ---------------------------------------------------------------------------
  // Datos
  // ---------------------------------------------------------------------------

  function isLive(tournament) {
    return !!(tournament && LIVE_STATUSES[String(tournament.status || '').toLowerCase()]);
  }

  /**
   * Se escuchan solo los torneos en vivo, no toda la base.
   *
   * partida_en_vivo es público y puede tener el histórico de muchos torneos:
   * suscribirse a la raíz descargaría partidas que ya terminaron hace semanas.
   */
  function syncLiveSubscriptions() {
    var database = db();
    if (!database) return;

    var wanted = {};
    Object.keys(state.tournaments).forEach(function (id) {
      if (isLive(state.tournaments[id])) wanted[id] = true;
    });

    Object.keys(state.liveRefs).forEach(function (id) {
      if (wanted[id]) return;
      state.liveRefs[id].off();
      delete state.liveRefs[id];
      delete state.live[id];
    });

    Object.keys(wanted).forEach(function (id) {
      if (state.liveRefs[id]) return;
      var ref = database.ref('partida_en_vivo/' + id);
      ref.on('value', function (snap) {
        state.live[id] = snap.val() || {};
        if (state.open) renderLive();
        updateBadge();
      }, function () {
        delete state.live[id];
      });
      state.liveRefs[id] = ref;
    });
  }

  function watchTournaments() {
    var database = db();
    if (!database || state.tournamentsRef) return;
    // Los mismos 20 últimos que ya carga el hub: no se pide nada extra.
    state.tournamentsRef = database.ref('tournaments').orderByChild('createdAt').limitToLast(20);
    state.tournamentsRef.on('value', function (snap) {
      state.tournaments = snap.val() || {};
      syncLiveSubscriptions();
      updateBadge();
      if (state.open) renderLive();
    }, function (err) {
      console.warn('[play-now] no se pudieron leer los torneos:', err && err.message);
    });
  }

  /**
   * Nombre y emblema de un equipo, pedidos de uno en uno.
   *
   * Escuchar teams entero descargaría la plantilla de todos los equipos del
   * sitio para pintar cuatro nombres. Solo se piden los que están jugando y se
   * guardan; si un equipo aparece dos veces, se pide una sola.
   */
  function ensureTeam(teamId) {
    if (!teamId || state.teams[teamId] || state.teamsPending[teamId]) return;
    var database = db();
    if (!database) return;
    state.teamsPending[teamId] = true;
    database.ref('teams/' + teamId).once('value').then(function (snap) {
      var team = snap.val() || {};
      state.teams[teamId] = { name: team.name || teamId, emblemUrl: team.emblemUrl || '' };
      delete state.teamsPending[teamId];
      if (state.open) renderLive();
    }).catch(function () {
      delete state.teamsPending[teamId];
    });
  }

  /** Cruces en marcha, aplanados a una lista para pintar. */
  function liveMatches() {
    var out = [];
    Object.keys(state.live).forEach(function (tournamentId) {
      var tournament = state.tournaments[tournamentId];
      if (!tournament) return;
      var matches = state.live[tournamentId] || {};
      Object.keys(matches).forEach(function (matchId) {
        var match = matches[matchId];
        if (!match || typeof match !== 'object') return;
        if (String(match.status || '').toLowerCase() !== 'live') return;
        out.push({
          tournamentId: tournamentId,
          tournament: tournament,
          matchId: matchId,
          live: match,
        });
      });
    });
    out.sort(function (a, b) {
      return num(b.live.lastEventAt || b.live.startedAt) - num(a.live.lastEventAt || a.live.startedAt);
    });
    return out;
  }

  /**
   * Qué equipo juega de cada lado.
   *
   * El servidor manda el marcador por bandos (CT y T) y los bandos cambian a la
   * mitad, así que sin esta traducción el marcador quedaría al revés en la
   * segunda parte. sideByTeam lo escribe el webhook con la plantilla real.
   */
  function sidesOf(entry) {
    var match = (entry.tournament.bracket && entry.tournament.bracket.matches &&
      entry.tournament.bracket.matches[entry.matchId]) || {};
    var teamA = match.teamA && match.teamA.teamId;
    var teamB = match.teamB && match.teamB.teamId;
    var sideByTeam = entry.live.sideByTeam || null;
    var ct = null;
    var t = null;

    if (sideByTeam && teamA && sideByTeam[teamA]) {
      if (sideByTeam[teamA] === 'CT') { ct = teamA; t = teamB; }
      else { ct = teamB; t = teamA; }
    } else if (sideByTeam && teamB && sideByTeam[teamB]) {
      if (sideByTeam[teamB] === 'CT') { ct = teamB; t = teamA; }
      else { ct = teamA; t = teamB; }
    } else {
      ct = teamA;
      t = teamB;
    }
    return { ct: ct, t: t, known: !!sideByTeam };
  }

  function teamNameOf(teamId) {
    if (!teamId) return 'Por decidir';
    var team = state.teams[teamId];
    if (team && team.name) return team.name;
    ensureTeam(teamId);
    return teamId;
  }

  // ---------------------------------------------------------------------------
  // Pintado
  // ---------------------------------------------------------------------------

  function sideHtml(teamId, sideLabel, alignRight) {
    return '<div class="sg-playnow-side' + (alignRight ? ' is-right' : '') + '">' +
      '<img src="' + esc(emblemFor(teamId)) + '" alt="" ' +
        'onerror="this.onerror=null;this.src=\'' + emblemFallback() + '\';">' +
      '<div class="sg-playnow-side-name">' + esc(teamNameOf(teamId)) +
        (sideLabel ? '<span class="sg-playnow-side-tag ' + sideLabel.toLowerCase() + '">' +
          esc(sideLabel) + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  function statsHtml(live) {
    var rows = Array.isArray(live.scoreboard) ? live.scoreboard.slice(0, TOP_PLAYERS) : [];
    if (!rows.length) return '';
    var mvpName = live.mvp && live.mvp.name;
    var head = '<div class="sg-playnow-stat-row is-head">' +
      '<span>Jugador</span><span class="num">B</span><span class="num">M</span><span class="num">ADR</span>' +
      '</div>';
    var body = rows.map(function (row) {
      var isMvp = mvpName && row.name === mvpName;
      return '<div class="sg-playnow-stat-row">' +
        '<span class="sg-playnow-stat-name' + (isMvp ? ' sg-playnow-mvp' : '') + '">' +
          (isMvp ? '<i class="fas fa-star" aria-hidden="true"></i> ' : '') + esc(row.name || '—') +
        '</span>' +
        '<span class="num">' + num(row.kills) + '</span>' +
        '<span class="num">' + num(row.deaths) + '</span>' +
        '<span class="num">' + num(row.adr) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="sg-playnow-stats">' + head + body + '</div>';
  }

  /**
   * La foto del torneo, con el mapa como segunda opción.
   *
   * Si el organizador subió portada se enseña esa. Si no la hay, o el archivo
   * ya no está en el bucket, se cae a la miniatura del mapa que se está
   * jugando, que dice más que el logo del sitio repetido en cada tarjeta.
   */
  function thumbHtml(tournament, live) {
    // Solo el mapa del propio cruce: `activeMap` es un campo de nivel torneo y
    // en modo dos servidores puede estar apuntando a la otra partida, que quizá
    // ni siquiera ha sacado todavía.
    var map = String(live.map || '');
    var mapThumb = map ? '/map-thumbs/' + map.toLowerCase() + '.jpg' : '/logo-studiosgamesrs.png';
    var src = tournament.bannerUrl || mapThumb;
    var chain = src === mapThumb
      ? "this.onerror=null;this.src='/logo-studiosgamesrs.png';"
      : "this.onerror=function(){this.onerror=null;this.src='/logo-studiosgamesrs.png';};" +
        "this.src='" + mapThumb + "';";
    return '<div class="sg-playnow-thumb">' +
      '<img src="' + esc(src) + '" alt="" loading="lazy" onerror="' + chain + '">' +
      (map ? '<span class="sg-playnow-thumb-tag">' + esc(map) + '</span>' : '') +
    '</div>';
  }

  function matchHtml(entry) {
    var live = entry.live;
    var sides = sidesOf(entry);
    var ctScore = live.scoreCT != null ? live.scoreCT : '—';
    var tScore = live.scoreT != null ? live.scoreT : '—';
    var round = live.currentRound != null ? ('Ronda ' + live.currentRound) : 'Calentando';
    var url = '/tournament-details?id=' + encodeURIComponent(entry.tournamentId);
    var mine = state.myTeamId &&
      (sides.ct === state.myTeamId || sides.t === state.myTeamId);

    return '<article class="sg-playnow-match">' +
      thumbHtml(entry.tournament, live) +
      '<div class="sg-playnow-match-body">' +
        '<div class="sg-playnow-match-top">' +
          '<h4 class="sg-playnow-tour-name">' + esc(entry.tournament.name || 'Torneo') + '</h4>' +
          '<span class="sg-playnow-round">' + esc(round) + '</span>' +
        '</div>' +
        '<div class="sg-playnow-score">' +
          sideHtml(sides.ct, sides.known ? 'CT' : '', false) +
          '<span class="sg-playnow-score-nums">' + esc(ctScore) + ' : ' + esc(tScore) + '</span>' +
          sideHtml(sides.t, sides.known ? 'T' : '', true) +
        '</div>' +
        statsHtml(live) +
        '<div class="sg-playnow-match-actions">' +
          '<a class="sg-playnow-watch' + (mine ? ' is-mine' : '') + '" href="' + url + '">' +
            '<i class="fas fa-' + (mine ? 'gamepad' : 'eye') + '" aria-hidden="true"></i> ' +
            (mine ? 'Entrar a mi partida' : 'Ver en directo') +
          '</a>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderLive() {
    var section = $('playNowLiveSection');
    var list = $('playNowLiveList');
    if (!section || !list) return;

    var matches = liveMatches();
    if (!matches.length) {
      section.hidden = true;
      list.innerHTML = '';
      return;
    }
    section.hidden = false;
    list.innerHTML = matches.map(matchHtml).join('');
  }

  function updateBadge() {
    var badge = $('playNowLiveBadge');
    var count = $('playNowLiveCount');
    if (!badge || !count) return;
    var total = liveMatches().length;
    count.textContent = String(total);
    badge.hidden = total === 0;
  }

  // ---------------------------------------------------------------------------
  // Ventana
  // ---------------------------------------------------------------------------

  function open() {
    var modal = $('playNowModal');
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('sg-tour-modal-open');
    state.open = true;
    renderLive();
    // La lista de torneos la sigue armando el hub, que es quien sabe si soy
    // capitán, si ya estoy inscrito y qué botón toca en cada tarjeta.
    if (typeof global.loadAllTournaments === 'function') global.loadAllTournaments();
    var closeBtn = modal.querySelector('.sg-playnow-close');
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    var modal = $('playNowModal');
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('sg-tour-modal-open');
    state.open = false;
    var btn = $('playNowBtn');
    if (btn) btn.focus();
  }

  function wire() {
    if (state.booted) return;
    var btn = $('playNowBtn');
    var modal = $('playNowModal');
    if (!btn || !modal) return;
    state.booted = true;

    btn.addEventListener('click', open);
    modal.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-playnow-close]')) close();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.open) close();
    });

    watchTournaments();

    if (global.firebase && firebase.auth) {
      firebase.auth().onAuthStateChanged(function (user) {
        if (!user) { state.myTeamId = null; return; }
        var database = db();
        if (!database) return;
        database.ref('users/' + user.uid + '/teamId').once('value').then(function (snap) {
          state.myTeamId = snap.val() || null;
          if (state.open) renderLive();
        }).catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  global.SGPlayNow = { open: open, close: close };
})(typeof window !== 'undefined' ? window : this);
