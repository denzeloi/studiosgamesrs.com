/**
 * Centro de torneos Studiosgamesrs — UI compartida Hub + Commander.
 * Depende de: firebase, funciones sendTournamentInvite / cancelTournamentInvite.
 */
(function (global) {
  'use strict';

  var state = {
    tournamentId: null,
    tournament: null,
    teamsCache: null,
    outboundUnsub: null,
    registeredUnsub: null,
    searchTimer: null,
    filterSameGame: true,
    filterHideRegistered: true,
    filterHidePending: true,
    outboundCount: 0,
    escapeBound: false,
    commanderListLoaded: false,
    deps: null
  };

  function fn() {
    return (typeof firebase !== 'undefined' && firebase.functions) ? firebase.functions() : null;
  }

  function db() {
    return (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
  }

  function esc(s) {
    if (state.deps && state.deps.sanitizeText) return state.deps.sanitizeText(s);
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function notify(type, msg) {
    if (state.deps && state.deps.notify) state.deps.notify(type, msg);
  }

  function fnErr(err, fallback) {
    if (state.deps && state.deps.fnError) return state.deps.fnError(err, fallback);
    return (err && err.message) ? err.message : fallback;
  }

  /**
   * Debe coincidir con el .write de `tournaments/{id}` en database.rules.json y con
   * COMMANDER_RANKS en functions/cs2-nexus/index.js. Si aquí falta un rango, el botón
   * no responde aunque la base de datos sí acepte la escritura.
   */
  var ORGANIZER_RANKS = ['commander', 'divisional_commander', 'boss_of_the_state'];

  function rankCanOrganize(userData) {
    if (!userData || !userData.rango) return false;
    var r = String(userData.rango).toLowerCase().replace(/\s+/g, '_');
    return ORGANIZER_RANKS.indexOf(r) !== -1;
  }

  function canOrganize(userData) {
    if (state.deps && state.deps.canOrganize) return state.deps.canOrganize(userData);
    return rankCanOrganize(userData);
  }

  function getUser() {
    return state.deps && state.deps.getUser ? state.deps.getUser() : null;
  }

  function getUserData() {
    return state.deps && state.deps.getUserData ? state.deps.getUserData() : null;
  }

  function formatDate(ms) {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleString('es-ES', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return '—'; }
  }

  function countRegistered(t) {
    if (!t || !t.registeredTeams) return 0;
    return Object.keys(t.registeredTeams).filter(function (k) { return t.registeredTeams[k]; }).length;
  }

  function isTourFull(t) {
    var max = (t && t.teams && t.teams.max) || 0;
    if (!max) return false;
    return countRegistered(t) >= max;
  }

  function updateStatsHeader() {
    var t = state.tournament;
    if (!t) return;
    var max = (t.teams && t.teams.max) || 0;
    var reg = countRegistered(t);
    var set = function (id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('sgTourStatRegistered', reg + (max ? ' / ' + max : ''));
    set('sgTourStatPrize', (t.prizePool != null ? t.prizePool : 0) + ' T');
    set('sgTourStatFee', (t.entryFee != null ? t.entryFee : 0) + ' T');
    set('sgTourStatPending', String(state.outboundCount || 0));
    set('sgTourStatSchedule', formatDate(t.schedule));

    var pct = max > 0 ? Math.min(100, Math.round((reg / max) * 100)) : 0;
    var capText = document.getElementById('sgTourCapacityText');
    var capPct = document.getElementById('sgTourCapacityPct');
    var capFill = document.getElementById('sgTourCapacityFill');
    var capTrack = document.getElementById('sgTourCapacityTrack');
    if (capText) {
      capText.textContent = max
        ? ('Plazas ocupadas: ' + reg + ' de ' + max)
        : ('Equipos inscritos: ' + reg);
    }
    if (capPct) capPct.textContent = max ? pct + '%' : '—';
    if (capFill) {
      capFill.style.width = (max ? pct : 0) + '%';
      capFill.classList.toggle('sg-tour-capacity-full', max > 0 && reg >= max);
    }
    if (capTrack) {
      capTrack.setAttribute('aria-valuenow', String(max ? pct : 0));
      capTrack.setAttribute('aria-valuemax', '100');
    }
  }

  async function assertAccess(tournamentId) {
    var user = getUser();
    var snap = await db().ref('tournaments/' + tournamentId).once('value');
    if (!snap.exists()) throw new Error('Torneo no encontrado.');
    var t = snap.val() || {};
    var org = (t.organizer && t.organizer.uid) || t.creatorUid;
    if (user && (org === user.uid || canOrganize(getUserData()))) {
      return t;
    }
    throw new Error('Solo el organizador o un Commander pueden gestionar invitaciones.');
  }

  function detachListeners() {
    if (state.outboundUnsub) {
      state.outboundUnsub();
      state.outboundUnsub = null;
    }
    if (state.registeredUnsub) {
      state.registeredUnsub();
      state.registeredUnsub = null;
    }
  }

  function switchTab(tabId) {
    document.querySelectorAll('.sg-tour-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-sg-tour-tab') === tabId);
    });
    document.querySelectorAll('.sg-tour-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'sgTourPanel' + tabId);
    });
  }

  async function loadTeamsCache() {
    if (state.teamsCache) return state.teamsCache;
    var snap = await db().ref('teams').once('value');
    state.teamsCache = snap.val() || {};
    return state.teamsCache;
  }

  function teamMatchesFilters(teamId, team, t) {
    if (!team) return false;
    if (state.filterHideRegistered && t.registeredTeams && t.registeredTeams[teamId]) return false;
    if (state.filterHidePending && t.outboundInvites && t.outboundInvites[teamId]) return false;
    if (state.filterSameGame && t.game && team.game && team.game !== t.game) return false;
    var roster = team.roster || {};
    if (Object.keys(roster).length >= 10) return false;
    return true;
  }

  function teamHasPendingInvite(teamId) {
    var t = state.tournament;
    return !!(t && t.outboundInvites && t.outboundInvites[teamId]);
  }

  async function renderSearchResults(query) {
    var list = document.getElementById('sgTourSearchResults');
    if (!list || !state.tournamentId) return;
    var q = (query || '').trim().toLowerCase();
    if (q.length < 2) {
      list.innerHTML = '<div class="sg-tour-empty"><i class="fas fa-keyboard"></i>Escribe al menos 2 letras del nombre del equipo.</div>';
      return;
    }
    if (isTourFull(state.tournament)) {
      list.innerHTML = '<div class="sg-tour-empty"><i class="fas fa-ban"></i>El torneo está lleno. No puedes enviar más invitaciones.</div>';
      return;
    }
    list.innerHTML = '<div class="sg-tour-empty"><i class="fas fa-spinner fa-spin"></i>Buscando equipos…</div>';
    try {
      var teams = await loadTeamsCache();
      var t = state.tournament;
      var matches = [];
      Object.keys(teams).forEach(function (id) {
        var team = teams[id];
        if (!team || !team.name) return;
        if (String(team.name).toLowerCase().indexOf(q) === -1) return;
        if (!teamMatchesFilters(id, team, t)) return;
        matches.push({ id: id, name: team.name, game: team.game || '—' });
      });
      matches.sort(function (a, b) { return a.name.localeCompare(b.name); });
      matches = matches.slice(0, 30);
      if (!matches.length) {
        list.innerHTML = '<div class="sg-tour-empty"><i class="fas fa-search"></i>No hay equipos elegibles con esos filtros.</div>';
        return;
      }
      list.innerHTML = '';
      var full = isTourFull(t);
      matches.forEach(function (team) {
        var row = document.createElement('div');
        row.className = 'sg-tour-row';
        var pending = teamHasPendingInvite(team.id);
        var actionHtml = pending
          ? '<span class="sg-tour-badge-pending"><i class="fas fa-clock"></i> Invite pendiente</span>'
          : '<button type="button" class="sg-tour-btn sg-tour-btn-primary"><i class="fas fa-paper-plane"></i> Invitar</button>';
        row.innerHTML =
          '<div class="sg-tour-row-main">' +
            '<div class="sg-tour-row-title">' + esc(team.name) + '</div>' +
            '<div class="sg-tour-row-meta">' + esc(team.game) + '</div>' +
          '</div>' +
          actionHtml;
        if (!pending && !full) {
          var btn = row.querySelector('button');
          btn.addEventListener('click', function () { sendInvite(team.id, team.name, btn); });
        }
        list.appendChild(row);
      });
    } catch (e) {
      console.error(e);
      list.innerHTML = '<div class="sg-tour-empty">Error al buscar equipos.</div>';
    }
  }

  async function sendInvite(teamId, teamName, btn) {
    var f = fn();
    if (!f) {
      notify('error', 'Cloud Functions no disponibles.');
      return;
    }
    if (isTourFull(state.tournament)) {
      notify('error', 'El torneo ya no tiene plazas libres.');
      return;
    }
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    try {
      await f.httpsCallable('sendTournamentInvite')({
        teamId: teamId,
        tournamentId: state.tournamentId
      });
      notify('success', 'Invitación enviada a «' + teamName + '». El capitán la verá en su panel de equipo.');
      if (btn) btn.innerHTML = '<i class="fas fa-check"></i> Enviada';
      var s = document.getElementById('sgTourTeamSearchInput');
      if (s && s.value.trim().length >= 2) renderSearchResults(s.value);
    } catch (err) {
      console.error(err);
      notify('error', fnErr(err, 'No se pudo enviar la invitación.'));
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Invitar';
      }
    }
  }

  function renderOutboundList(snap) {
    var list = document.getElementById('sgTourOutboundList');
    if (!list) return;
    var val = snap.val() || {};
    if (state.tournament) state.tournament.outboundInvites = val;
    var keys = Object.keys(val);
    state.outboundCount = keys.length;
    if (!keys.length) {
      list.innerHTML = '<div class="sg-tour-empty"><i class="fas fa-inbox"></i>Aún no has enviado invitaciones para este torneo.</div>';
      updateStatsHeader();
      return;
    }
    list.innerHTML = '';
    keys.forEach(function (teamId) {
      var row = val[teamId] || {};
      var div = document.createElement('div');
      div.className = 'sg-tour-row';
      div.innerHTML =
        '<div class="sg-tour-row-main">' +
          '<div class="sg-tour-row-title">' + esc(row.teamName || teamId) + '</div>' +
          '<div class="sg-tour-row-meta">Enviada ' + formatDate(row.sentAt) + (row.sentByNick ? ' · ' + esc(row.sentByNick) : '') + '</div>' +
        '</div>' +
        '<button type="button" class="sg-tour-btn sg-tour-btn-danger"><i class="fas fa-times"></i> Retirar</button>';
      div.querySelector('button').addEventListener('click', function () {
        cancelInvite(teamId, div);
      });
      list.appendChild(div);
    });
    updateStatsHeader();
  }

  async function cancelInvite(teamId, rowEl) {
    var f = fn();
    if (!f) return;
    if (!confirm('¿Retirar la invitación a este equipo?')) return;
    try {
      await f.httpsCallable('cancelTournamentInvite')({
        teamId: teamId,
        tournamentId: state.tournamentId
      });
      notify('success', 'Invitación retirada.');
      if (rowEl && rowEl.parentNode) rowEl.remove();
      updateStatsHeader();
    } catch (err) {
      notify('error', fnErr(err, 'No se pudo retirar.'));
    }
  }

  function renderRegisteredList(snap) {
    var list = document.getElementById('sgTourRegisteredList');
    if (!list) return;
    var reg = snap.val() || {};
    var ids = Object.keys(reg).filter(function (k) { return reg[k]; });
    if (!ids.length) {
      list.innerHTML = '<div class="sg-tour-empty"><i class="fas fa-users"></i>Ningún equipo inscrito todavía.</div>';
      return;
    }
    loadTeamsCache().then(function (teams) {
      list.innerHTML = '';
      ids.forEach(function (teamId) {
        var team = teams[teamId] || {};
        var div = document.createElement('div');
        div.className = 'sg-tour-row';
        div.innerHTML =
          '<div class="sg-tour-row-main">' +
            '<div class="sg-tour-row-title">' + esc(team.name || teamId) + '</div>' +
            '<div class="sg-tour-row-meta">' + esc(team.game || '—') + '</div>' +
          '</div>' +
          '<span class="sg-tour-row-meta" style="color:#4caf50;font-weight:700;"><i class="fas fa-check-circle"></i> Inscrito</span>';
        list.appendChild(div);
      });
    });
  }

  function bindRealtime(tournamentId) {
    detachListeners();
    var outboundRef = db().ref('tournaments/' + tournamentId + '/outboundInvites');
    state.outboundUnsub = outboundRef.on('value', renderOutboundList);
    var regRef = db().ref('tournaments/' + tournamentId + '/registeredTeams');
    state.registeredUnsub = regRef.on('value', function (snap) {
      if (state.tournament) {
        state.tournament.registeredTeams = snap.val() || {};
        updateStatsHeader();
      }
      renderRegisteredList(snap);
    });
  }

  function bindOverviewPanel() {
    var overview = document.getElementById('sgTourPanelOverview');
    if (!overview || !state.tournament) return;
    var t = state.tournament;
    overview.innerHTML =
      '<p class="sg-tour-inline-hint">Los capitanes reciben la invitación en <strong>Competition Hub → panel de su equipo</strong>. ' +
      'Desde la pestaña <strong>Invitar equipos</strong> buscas por nombre; en <strong>Pendientes</strong> ves lo enviado y puedes retirar invites.</p>' +
      '<div class="sg-tour-row"><div class="sg-tour-row-main">' +
      '<div class="sg-tour-row-title">' + esc(t.description || 'Sin descripción') + '</div>' +
      '<div class="sg-tour-row-meta">Estado: ' + esc(t.status || 'pendiente') + ' · Formato: ' + esc(t.format || '—') + ' · Región: ' + esc(t.region || '—') + '</div>' +
      '</div></div>';
  }

  function wireTabsAndSearch() {
    document.querySelectorAll('.sg-tour-tab').forEach(function (btn) {
      btn.onclick = function () { switchTab(btn.getAttribute('data-sg-tour-tab')); };
    });
    var search = document.getElementById('sgTourTeamSearchInput');
    if (search && !search.dataset.sgBound) {
      search.dataset.sgBound = '1';
      search.addEventListener('input', function () {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(function () {
          renderSearchResults(search.value);
        }, 280);
      });
    }
    document.querySelectorAll('[data-sg-tour-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var key = chip.getAttribute('data-sg-tour-filter');
        if (key === 'sameGame') {
          state.filterSameGame = !state.filterSameGame;
          chip.classList.toggle('active', state.filterSameGame);
        }
        if (key === 'hideReg') {
          state.filterHideRegistered = !state.filterHideRegistered;
          chip.classList.toggle('active', state.filterHideRegistered);
        }
        if (key === 'hidePending') {
          state.filterHidePending = !state.filterHidePending;
          chip.classList.toggle('active', state.filterHidePending);
        }
        var s = document.getElementById('sgTourTeamSearchInput');
        if (s && s.value.trim().length >= 2) renderSearchResults(s.value);
      });
    });
    var clearBtn = document.getElementById('sgTourSearchClear');
    if (clearBtn && !clearBtn.dataset.sgBound) {
      clearBtn.dataset.sgBound = '1';
      clearBtn.addEventListener('click', function () {
        var s = document.getElementById('sgTourTeamSearchInput');
        if (s) {
          s.value = '';
          s.focus();
          renderSearchResults('');
        }
      });
    }
  }

  async function openCommandCenter(tournamentId) {
    var modal = document.getElementById('sgTourCommandCenterModal');
    if (!modal) return;
    try {
      state.tournament = await assertAccess(tournamentId);
      state.tournamentId = tournamentId;
      state.teamsCache = null;
      var title = document.getElementById('sgTourCcTitle');
      var sub = document.getElementById('sgTourCcSubtitle');
      if (title) title.textContent = state.tournament.name || 'Torneo';
      if (sub) {
        sub.textContent = 'Gestión de invitaciones · ' + formatDate(state.tournament.schedule);
      }
      bindOverviewPanel();
      updateStatsHeader();
      bindRealtime(tournamentId);
      wireTabsAndSearch();
      switchTab('Invite');
      var search = document.getElementById('sgTourTeamSearchInput');
      if (search) {
        search.value = '';
        setTimeout(function () { search.focus(); }, 80);
      }
      renderSearchResults('');
      modal.style.display = 'flex';
      document.body.classList.add('sg-tour-modal-open');
    } catch (err) {
      notify('error', err.message || 'Acceso denegado.');
    }
  }

  function closeCommandCenter() {
    var modal = document.getElementById('sgTourCommandCenterModal');
    if (modal) modal.style.display = 'none';
    document.body.classList.remove('sg-tour-modal-open');
    detachListeners();
    state.tournamentId = null;
    state.tournament = null;
    state.outboundCount = 0;
  }

  function bindGlobalEscape() {
    if (state.escapeBound) return;
    state.escapeBound = true;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var cc = document.getElementById('sgTourCommandCenterModal');
      if (cc && cc.style.display === 'flex') {
        closeCommandCenter();
        return;
      }
      var cr = document.getElementById('tournamentCreationModal');
      if (cr && cr.style.display === 'flex') cr.style.display = 'none';
    });
  }

  var GAMES = [
    { v: 'cs2', l: 'Counter-Strike 2' },
    { v: 'valorant', l: 'Valorant' },
    { v: 'lol', l: 'League of Legends' },
    { v: 'rl', l: 'Rocket League' }
  ];

  function populateGameSelect() {
    var sel = document.getElementById('tournamentGameSelect');
    if (!sel || sel.options.length) return;
    GAMES.forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.v;
      o.textContent = g.l;
      sel.appendChild(o);
    });
  }

  function gameLabel(value) {
    for (var i = 0; i < GAMES.length; i += 1) {
      if (GAMES[i].v === value) return GAMES[i].l;
    }
    return value || '—';
  }

  function el(id) { return document.getElementById(id); }

  function strVal(id) {
    var node = el(id);
    return node ? String(node.value || '').trim() : '';
  }

  function numVal(id, fallback) {
    var node = el(id);
    var n = node ? Number(node.value) : NaN;
    return isFinite(n) ? n : fallback;
  }

  /**
   * Forma del cuadro de eliminación simple: cuántas rondas salen y cuántos
   * equipos pasan de ronda sin jugar. Es lo que el Commander necesita saber
   * antes de fijar el cupo, no después de sembrar el bracket.
   */
  function bracketShape(teams) {
    var n = Math.max(2, Math.floor(Number(teams) || 0));
    var size = 2;
    var rounds = 1;
    while (size < n) { size *= 2; rounds += 1; }
    return { teams: n, size: size, rounds: rounds, byes: size - n };
  }

  /** Valor para <input type="datetime-local">: hora local, no UTC. */
  function toLocalInput(ms) {
    var d = new Date(ms);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function isCs2Selected() {
    return strVal('tournamentGameSelect') === 'cs2';
  }

  /** Mapa, bandos y servidor doble solo existen en CS2: fuera del resto. */
  function syncGameFields() {
    var cs2 = isCs2Selected();
    var nodes = document.querySelectorAll('#createTournamentForm [data-sg-cs2-only]');
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].style.display = cs2 ? '' : 'none';
    }
  }

  function readCreateForm() {
    var teamSize = Math.max(1, numVal('tournamentTeamSizeSelect', 5));
    var scheduleRaw = strVal('tournamentScheduleInput');
    var scheduleMs = scheduleRaw ? new Date(scheduleRaw).getTime() : NaN;
    return {
      name: strVal('tournamentNameInput'),
      game: strVal('tournamentGameSelect') || 'cs2',
      region: strVal('tournamentRegionSelect') || 'LATAM',
      format: strVal('tournamentFormatSelect') || 'SingleElim',
      teamSize: teamSize,
      maxTeams: numVal('tournamentMaxTeamsInput', 0),
      map: isCs2Selected() ? (strVal('tournamentMapSelect') || 'de_mirage') : null,
      bestOf: isCs2Selected() ? numVal('tournamentBestOfSelect', 1) : 1,
      serverMode: isCs2Selected() && strVal('tournamentServerModeSelect') === 'dual' ? 'dual' : 'single',
      scheduleMs: scheduleMs,
      matchMinutes: numVal('tournamentMatchMinutesInput', 45),
      prizePool: numVal('tournamentPrizeInput', 0),
      entryFee: numVal('tournamentEntryFeeInput', 0),
      mvpTokens: numVal('tournamentMvpTokensInput', 0),
      cashPrize: numVal('tournamentCashPrizeInput', 0),
      description: strVal('tournamentDescriptionTextarea')
    };
  }

  function validateCreate(d) {
    var errors = [];
    if (d.name.length < 3) errors.push('El nombre necesita al menos 3 caracteres.');
    if (!d.game) errors.push('Elige el juego del torneo.');
    if (!(d.maxTeams >= 2 && d.maxTeams <= 64) || d.maxTeams % 1 !== 0) {
      errors.push('El cupo de equipos va de 2 a 64.');
    }
    if (!isFinite(d.scheduleMs)) errors.push('Falta la fecha y hora de inicio.');
    else if (d.scheduleMs < Date.now() - 60000) errors.push('La fecha de inicio ya pasó.');
    if (!(d.matchMinutes >= 10 && d.matchMinutes <= 180)) {
      errors.push('Los minutos por partida van de 10 a 180.');
    }
    if (d.prizePool < 0 || d.entryFee < 0 || d.mvpTokens < 0 || d.cashPrize < 0) {
      errors.push('Los premios y la cuota no pueden ser negativos.');
    }
    if (d.cashPrize > 100000) {
      errors.push('La recompensa en dólares parece un error: revisa el importe.');
    }
    if (d.format !== 'SingleElim') {
      errors.push('Por ahora solo se puede correr eliminación simple.');
    }
    return errors;
  }

  function fmtDateTime(ms) {
    if (!isFinite(ms)) return 'sin fecha';
    return new Date(ms).toLocaleString('es-ES', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  }

  function summaryChip(icon, text) {
    return '<span class="sg-tour-sum-chip"><i class="fas ' + icon + '" aria-hidden="true"></i>' + text + '</span>';
  }

  /** Resumen vivo: lo que se va a guardar, en una línea, mientras se escribe. */
  function renderCreateSummary() {
    var box = el('sgTourCreateSummary');
    if (!box) return;
    var d = readCreateForm();
    var shape = bracketShape(d.maxTeams);

    var hint = el('sgTourBracketHint');
    if (hint) {
      hint.textContent = d.maxTeams >= 2
        ? shape.teams + ' equipos: ' + shape.rounds + ' rondas' +
          (shape.byes ? ', ' + shape.byes + ' pasan la primera sin jugar' : ', sin descansos')
        : 'Hacen falta al menos 2 equipos.';
    }

    var prizeHint = el('sgTourPrizeHint');
    if (prizeHint) {
      var recaudo = d.entryFee * shape.teams;
      prizeHint.textContent = recaudo
        ? 'Con el cupo lleno se recaudan ' + recaudo.toLocaleString('es-ES') +
          ' tokens en cuotas, aparte del premio base.'
        : 'La bolsa que se anuncia es el premio base; las cuotas se suman aparte.';
    }

    box.innerHTML =
      summaryChip('fa-gamepad', gameLabel(d.game)) +
      summaryChip('fa-users', d.teamSize + 'v' + d.teamSize) +
      summaryChip('fa-sitemap', shape.teams + ' equipos · ' + shape.rounds + ' rondas') +
      summaryChip('fa-clock', fmtDateTime(d.scheduleMs)) +
      (d.map ? summaryChip('fa-map', d.map) : '') +
      (d.serverMode === 'dual' ? summaryChip('fa-server', 'dos servidores') : '') +
      summaryChip('fa-coins', (d.prizePool || 0).toLocaleString('es-ES') + ' tokens') +
      (d.cashPrize > 0
        ? '<span class="sg-tour-sum-chip sg-tour-sum-cash"><i class="fas fa-sack-dollar" aria-hidden="true"></i>$' +
          d.cashPrize.toLocaleString('es-ES') + ' USD al ganador</span>'
        : '');
  }

  function showCreateErrors(errors) {
    var box = el('sgTourCreateError');
    if (!box) return;
    if (!errors || !errors.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i><ul>' +
      errors.map(function (e) { return '<li>' + e + '</li>'; }).join('') + '</ul>';
  }

  /** Deja el formulario listo para escribir: nada de campos en blanco al abrir. */
  function setupCreateDefaults() {
    populateGameSelect();
    var schedule = el('tournamentScheduleInput');
    if (schedule && !schedule.value) {
      var d = new Date();
      d.setHours(d.getHours() + 2, 0, 0, 0);
      schedule.value = toLocalInput(d.getTime());
      schedule.min = toLocalInput(Date.now());
    }
    var maxTeams = el('tournamentMaxTeamsInput');
    if (maxTeams && !maxTeams.value) maxTeams.value = '8';
    showCreateErrors(null);
    syncGameFields();
    renderCreateSummary();
  }

  /**
   * Torneo recién nacido pero completo: escribe también lo que leen la sala, el
   * War Room y cs2-nexus (cupo, roster, premios, calendario, modo de servidor).
   * Lo único que falta a propósito es el bracket, que se siembra cuando ya hay
   * equipos inscritos; por eso tampoco se escribe currentMatchId.
   */
  function buildTournamentPayload(d, id, user, nick) {
    var now = Date.now();
    var cs2 = d.game === 'cs2';
    var payload = {
      id: id,
      name: d.name,
      name_lowercase: d.name.toLowerCase(),
      game: d.game,
      format: 'SingleElim',
      modality: d.teamSize + 'v' + d.teamSize,
      playersPerTeam: d.teamSize,
      region: d.region,
      regionServer: d.region,
      maxTeams: d.maxTeams,
      teams: { max: d.maxTeams, registered: 0 },
      schedule: d.scheduleMs,
      prizePool: d.prizePool,
      entryFee: d.entryFee,
      prizes: {
        tokenPool: d.prizePool,
        entryFee: d.entryFee,
        mvpTokens: d.mvpTokens,
        cashPool: d.cashPrize,
        cashCurrency: 'USD',
        // El dinero va entero al campeón; el War Room puede repartirlo luego.
        places: { first: { tokens: d.prizePool, cash: d.cashPrize } },
        updatedAt: now
      },
      scheduleConfig: {
        startAt: d.scheduleMs,
        matchMinutes: d.matchMinutes,
        gapMinutes: 10,
        roundGapMinutes: 20,
        serverSlots: d.serverMode === 'dual' ? 2 : 1,
        bestOf: d.bestOf,
        defaultMap: cs2 ? d.map : null,
        seedMode: 'power'
      },
      description: d.description,
      status: 'pendiente',
      organizer: { uid: user.uid, nick: nick },
      creatorUid: user.uid,
      registeredTeams: {},
      outboundInvites: {},
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    };
    if (cs2) {
      payload.serverMode = d.serverMode;
      payload.activeMap = d.map;
    }
    return payload;
  }

  function bindCreateForm(onCreated) {
    populateGameSelect();
    var form = document.getElementById('createTournamentForm');
    if (!form || form.dataset.sgTourBound) return;
    form.dataset.sgTourBound = '1';

    form.addEventListener('input', renderCreateSummary);
    form.addEventListener('change', function (ev) {
      if (ev.target && ev.target.id === 'tournamentGameSelect') syncGameFields();
      renderCreateSummary();
    });
    var cancelBtn = document.getElementById('cancelTournamentBtn');
    var modal = document.getElementById('tournamentCreationModal');
    if (cancelBtn && modal) {
      cancelBtn.onclick = function () { modal.style.display = 'none'; };
    }

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var user = getUser();
      var ud = getUserData();
      if (!user || !canOrganize(ud)) {
        notify('error', 'Solo Commanders pueden crear torneos oficiales.');
        return;
      }

      var d = readCreateForm();
      var errors = validateCreate(d);
      showCreateErrors(errors);
      if (errors.length) {
        notify('error', errors[0]);
        return;
      }

      var saveBtn = document.getElementById('saveTournamentBtn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando…';
      }
      try {
        var nick = (ud && ud.nick) ? ud.nick : (user.displayName || 'Organizador');
        var ref = db().ref('tournaments').push();
        var id = ref.key;
        await ref.set(buildTournamentPayload(d, id, user, nick));
        notify('success', 'Torneo creado. Ahora invita equipos desde el centro de gestión.');
        document.getElementById('tournamentCreationModal').style.display = 'none';
        form.reset();
        setupCreateDefaults();
        if (onCreated) onCreated(id);
        openCommandCenter(id);
      } catch (err) {
        showCreateErrors([err.message || 'No se pudo guardar el torneo.']);
        notify('error', err.message || 'No se pudo crear el torneo.');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<i class="fas fa-check-circle"></i> Crear torneo';
        }
      }
    });
  }

  function refreshCommanderTournamentSelect(done) {
    var sel = document.getElementById('cmdTourInviteSelect');
    if (!sel || !db()) {
      if (typeof done === 'function') done(false);
      return;
    }
    sel.innerHTML = '<option value="">Cargando torneos…</option>';
    db().ref('tournaments').limitToLast(50).once('value').then(function (snap) {
      var list = [];
      snap.forEach(function (c) {
        var t = c.val() || {};
        var st = String(t.status || '').toLowerCase();
        if (st === 'finalizado' || st === 'cancelado' || st === 'finished') return;
        list.push({ id: c.key, name: t.name || c.key, at: t.createdAt || 0 });
      });
      list.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
      sel.innerHTML = '';
      if (!list.length) {
        sel.innerHTML = '<option value="">No hay torneos activos</option>';
        if (typeof done === 'function') done(true);
        return;
      }
      list.forEach(function (item, i) {
        var o = document.createElement('option');
        o.value = item.id;
        o.textContent = item.name;
        if (i === 0) o.selected = true;
        sel.appendChild(o);
      });
      if (typeof done === 'function') done(true);
    }).catch(function () {
      sel.innerHTML = '<option value="">Error al cargar torneos</option>';
      if (typeof done === 'function') done(false);
    });
  }

  function ensureCommanderTournamentListLoaded(done) {
    var sel = document.getElementById('cmdTourInviteSelect');
    if (!sel) {
      if (typeof done === 'function') done(false);
      return;
    }
    if (state.commanderListLoaded && sel.options.length > 1) {
      if (typeof done === 'function') done(true);
      return;
    }
    refreshCommanderTournamentSelect(function (ok) {
      state.commanderListLoaded = !!ok;
      if (typeof done === 'function') done(ok);
    });
  }

  function initCommanderSelect() {
    var sel = document.getElementById('cmdTourInviteSelect');
    if (!sel) return;
    var openBtn = document.getElementById('cmdTourOpenCenterBtn');
    if (openBtn && !openBtn.dataset.sgBound) {
      openBtn.dataset.sgBound = '1';
      openBtn.onclick = function () {
        ensureCommanderTournamentListLoaded(function () {
          var id = sel.value;
          if (!id) {
            notify('error', 'Selecciona un torneo.');
            return;
          }
          openCommandCenter(id);
        });
      };
    }
    var refBtn = document.getElementById('cmdTourRefreshBtn');
    if (refBtn && !refBtn.dataset.sgBound) {
      refBtn.dataset.sgBound = '1';
      refBtn.onclick = function () {
        state.commanderListLoaded = false;
        refreshCommanderTournamentSelect(function () {
          state.commanderListLoaded = true;
          notify('success', 'Lista de torneos actualizada.');
        });
      };
    }
  }

  global.SGTournamentOrganizer = {
    init: function (deps) {
      state.deps = deps || {};
      bindGlobalEscape();
      var createModal = document.getElementById('tournamentCreationModal');
      var closeCreate = document.getElementById('closeTournamentCreationModal');
      if (closeCreate && createModal) {
        closeCreate.onclick = function () { createModal.style.display = 'none'; };
        createModal.addEventListener('click', function (e) {
          if (e.target === createModal) createModal.style.display = 'none';
        });
      }
      var ccModal = document.getElementById('sgTourCommandCenterModal');
      var closeCc = document.getElementById('sgTourCloseCommandCenter');
      if (closeCc) closeCc.onclick = closeCommandCenter;
      if (ccModal) {
        ccModal.addEventListener('click', function (e) {
          if (e.target === ccModal) closeCommandCenter();
        });
      }
      bindCreateForm(deps.onTournamentCreated);
      initCommanderSelect();
    },
    openCreate: function () {
      if (!canOrganize(getUserData())) {
        notify('error', 'Solo Commanders pueden crear torneos oficiales.');
        return;
      }
      var m = document.getElementById('tournamentCreationModal');
      if (m) {
        m.style.display = 'flex';
        setupCreateDefaults();
        var nameInput = document.getElementById('tournamentNameInput');
        if (nameInput) setTimeout(function () { nameInput.focus(); }, 80);
      }
    },
    openManage: function (tournamentId) {
      return openCommandCenter(tournamentId);
    },
    refreshCommanderTournaments: refreshCommanderTournamentSelect,
    ensureCommanderTournamentListLoaded: ensureCommanderTournamentListLoaded,
    rankCanOrganize: rankCanOrganize,
    ORGANIZER_RANKS: ORGANIZER_RANKS
  };

  global.openTournamentCreationModal = function () {
    global.SGTournamentOrganizer.openCreate();
  };
  global.openTournamentOrganizerModal = function (id) {
    global.SGTournamentOrganizer.openManage(id);
  };
})(typeof window !== 'undefined' ? window : this);
