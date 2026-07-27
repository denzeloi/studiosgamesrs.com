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

  function canOrganize(userData) {
    if (state.deps && state.deps.canOrganize) return state.deps.canOrganize(userData);
    if (!userData || !userData.rango) return false;
    var r = String(userData.rango).toLowerCase().replace(/\s+/g, '_');
    return r === 'commander' || r === 'boss_of_the_state';
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

  function populateGameSelect() {
    var sel = document.getElementById('tournamentGameSelect');
    if (!sel || sel.options.length) return;
    [
      { v: 'cs2', l: 'Counter-Strike 2' },
      { v: 'valorant', l: 'Valorant' },
      { v: 'lol', l: 'League of Legends' },
      { v: 'rl', l: 'Rocket League' }
    ].forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.v;
      o.textContent = g.l;
      sel.appendChild(o);
    });
  }

  function bindCreateForm(onCreated) {
    populateGameSelect();
    var form = document.getElementById('createTournamentForm');
    if (!form || form.dataset.sgTourBound) return;
    form.dataset.sgTourBound = '1';
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var user = getUser();
      var ud = getUserData();
      if (!user || !canOrganize(ud)) {
        notify('error', 'Solo Commanders pueden crear torneos oficiales.');
        return;
      }
      var saveBtn = document.getElementById('saveTournamentBtn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando…';
      }
      try {
        var name = (document.getElementById('tournamentNameInput').value || '').trim();
        var maxTeams = Number(document.getElementById('tournamentMaxTeamsInput').value);
        var scheduleRaw = document.getElementById('tournamentScheduleInput').value;
        if (!name || maxTeams < 2 || !scheduleRaw) throw new Error('Completa los campos obligatorios.');
        var scheduleMs = new Date(scheduleRaw).getTime();
        if (isNaN(scheduleMs)) throw new Error('Fecha de inicio no válida.');
        var nick = (ud && ud.nick) ? ud.nick : (user.displayName || 'Organizador');
        var ref = db().ref('tournaments').push();
        var id = ref.key;
        await ref.set({
          id: id,
          name: name,
          name_lowercase: name.toLowerCase(),
          game: document.getElementById('tournamentGameSelect').value,
          format: document.getElementById('tournamentFormatSelect').value,
          modality: document.getElementById('tournamentFormatSelect').value,
          region: document.getElementById('tournamentRegionSelect').value,
          regionServer: document.getElementById('tournamentRegionSelect').value,
          teams: { max: maxTeams, registered: 0 },
          schedule: scheduleMs,
          prizePool: Number(document.getElementById('tournamentPrizeInput').value) || 0,
          entryFee: Number(document.getElementById('tournamentEntryFeeInput').value) || 0,
          description: (document.getElementById('tournamentDescriptionTextarea').value || '').trim(),
          status: 'pendiente',
          organizer: { uid: user.uid, nick: nick },
          creatorUid: user.uid,
          registeredTeams: {},
          outboundInvites: {},
          createdAt: firebase.database.ServerValue.TIMESTAMP
        });
        notify('success', 'Torneo creado. Ahora invita equipos desde el centro de gestión.');
        document.getElementById('tournamentCreationModal').style.display = 'none';
        form.reset();
        if (onCreated) onCreated(id);
        openCommandCenter(id);
      } catch (err) {
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
        var nameInput = document.getElementById('tournamentNameInput');
        if (nameInput) setTimeout(function () { nameInput.focus(); }, 80);
      }
    },
    openManage: function (tournamentId) {
      return openCommandCenter(tournamentId);
    },
    refreshCommanderTournaments: refreshCommanderTournamentSelect,
    ensureCommanderTournamentListLoaded: ensureCommanderTournamentListLoaded
  };

  global.openTournamentCreationModal = function () {
    global.SGTournamentOrganizer.openCreate();
  };
  global.openTournamentOrganizerModal = function (id) {
    global.SGTournamentOrganizer.openManage(id);
  };
})(typeof window !== 'undefined' ? window : this);
