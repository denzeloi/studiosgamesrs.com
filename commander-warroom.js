/* commander-warroom.js — Control Universal del Torneo (Commander War Room)
 *
 * Centro de mando en vivo para el Commander y consola de vigilancia para el Sentinela.
 * Carga después de commander-panel.js y se inicializa desde él con SGWarRoom.init().
 *
 * Nodos RTDB usados/escritos por este módulo:
 *   tournaments/{tid}/bracket                 estructura de llaves (misma forma que functions/cs2-nexus/lib/bracket.js)
 *   tournaments/{tid}/scheduleConfig          parámetros del calendario inteligente
 *   tournaments/{tid}/prizes                  bolsa de premios publicada en vivo
 *   tournaments/{tid}/prizePayouts/{puesto}   entregas registradas
 *   tournaments/{tid}/podium                  1.º / 2.º / 3.º confirmados
 *   tournaments/{tid}/teamStates/{teamId}     equipo activo o pausado
 *   tournaments/{tid}/teamSeeds/{teamId}      siembra manual
 *   tournaments/{tid}/commanderNote           aviso público del Commander
 *   tournamentPresence/{tid}/{uid}            espectadores, sentinelas y commanders viendo el torneo
 *   security/sentinels/{uid}                  registro de sentinelas
 *   security/sentinelConfig                   sentinela predeterminado
 *   security/sentinelReports/{id}             reportes de trampa
 */
(function (global) {
  'use strict';

  var db = null;

  var SENTINELS_PATH = 'security/sentinels';
  var SENTINEL_CONFIG_PATH = 'security/sentinelConfig';
  var SENTINEL_REPORTS_PATH = 'security/sentinelReports';
  var PRESENCE_PATH = 'tournamentPresence';
  var AUDIT_PATH = 'security/auditLog';

  // Un espectador se considera presente si dio señal en los últimos 90 s.
  var PRESENCE_TTL_MS = 90 * 1000;
  var PRESENCE_BEAT_MS = 40 * 1000;
  // Sin eventos del servidor de juego durante este tiempo, la partida se marca como sin señal.
  var LIVE_STALE_MS = 90 * 1000;

  var DEFAULT_SCHEDULE = {
    matchMinutes: 45,
    gapMinutes: 10,
    roundGapMinutes: 20,
    serverSlots: 1,
    bestOf: 1,
    defaultMap: 'de_mirage',
    seedMode: 'power'
  };

  var state = {
    ready: false,
    mode: 'commander',        // 'commander' | 'sentinel'
    uid: null,
    nick: 'Commander',
    rango: '',
    sentinelRecord: null,
    tournamentId: null,
    tournament: null,
    tournamentList: {},
    servers: {},              // gameServers completo (flota)
    server: null,             // servidor activo del torneo
    serverId: null,
    live: null,               // partida_en_vivo/{matchId}
    liveMatchId: null,
    teams: {},                // teamId -> equipo
    invites: {},
    presence: {},
    sentinels: {},
    sentinelConfig: {},
    reports: {},
    audit: {},
    autopilot: true,
    rawOpen: false,
    reportFilter: 'open',
    prizeDirty: false,
    scheduleDirty: false
  };

  var slots = {};             // suscripciones RTDB con nombre
  var tickTimer = null;
  var beatTimer = null;
  var presenceRef = null;
  var tabOpened = false;

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (fallback || 0);
  }

  function keys(obj) { return obj && typeof obj === 'object' ? Object.keys(obj) : []; }

  function toast(type, text) {
    if (typeof global.showFloatingMessage === 'function') {
      global.showFloatingMessage(type, text);
      return;
    }
    console.log('[warroom]', type, text);
  }

  function setMsg(text, isError) {
    var el = $('cwrMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'cwr-msg' + (isError ? ' cwr-msg-error' : '');
  }

  function fmtDateTime(ms) {
    var n = Number(ms);
    if (!n || !isFinite(n)) return '—';
    try {
      return new Date(n).toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (err) {
      return new Date(n).toISOString();
    }
  }

  function fmtTime(ms) {
    var n = Number(ms);
    if (!n || !isFinite(n)) return '—';
    try {
      return new Date(n).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      return '—';
    }
  }

  function fmtDuration(seconds) {
    var s = Math.max(0, Math.floor(num(seconds)));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + r + 's';
    return r + 's';
  }

  function fmtAgo(ms) {
    if (!ms) return '—';
    var diff = Math.floor((Date.now() - Number(ms)) / 1000);
    if (diff < 0) diff = 0;
    if (diff < 60) return 'hace ' + diff + ' s';
    if (diff < 3600) return 'hace ' + Math.floor(diff / 60) + ' min';
    if (diff < 86400) return 'hace ' + Math.floor(diff / 3600) + ' h';
    return 'hace ' + Math.floor(diff / 86400) + ' d';
  }

  function fmtCountdown(targetMs) {
    var diff = Number(targetMs) - Date.now();
    var past = diff < 0;
    var s = Math.floor(Math.abs(diff) / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var out;
    if (d > 0) out = d + 'd ' + h + 'h ' + m + 'm';
    else if (h > 0) out = h + 'h ' + m + 'm ' + r + 's';
    else out = m + 'm ' + r + 's';
    return (past ? '+' : '') + out;
  }

  function fmtTokens(value) {
    return num(value).toLocaleString('es-ES');
  }

  function toLocalInputValue(ms) {
    var n = Number(ms);
    if (!n || !isFinite(n)) return '';
    var d = new Date(n - new Date(n).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }

  function fromLocalInputValue(value) {
    if (!value) return 0;
    var ms = new Date(value).getTime();
    return isFinite(ms) ? ms : 0;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('success', 'Copiado: ' + text);
      }).catch(function () { legacyCopy(text); });
      return;
    }
    legacyCopy(text);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('success', 'Copiado: ' + text);
    } catch (err) {
      toast('error', 'No se pudo copiar. Cópialo a mano: ' + text);
    }
    document.body.removeChild(ta);
  }

  function isCommander() { return state.mode === 'commander'; }

  function teamName(teamId) {
    if (!teamId) return 'TBD';
    var t = state.teams[teamId];
    return (t && t.name) ? t.name : teamId;
  }

  function teamEmblem(teamId) {
    var t = state.teams[teamId];
    return (t && t.emblemUrl) ? t.emblemUrl : null;
  }

  // ---------------------------------------------------------------------------
  // Suscripciones RTDB con nombre (se liberan al cambiar de torneo)
  // ---------------------------------------------------------------------------

  function bind(name, ref, cb, event) {
    release(name);
    var evt = event || 'value';
    var handler = ref.on(evt, cb, function (err) {
      console.warn('[warroom] listener ' + name + ':', err && err.message);
    });
    slots[name] = { ref: ref, event: evt, handler: handler };
  }

  function release(name) {
    var s = slots[name];
    if (!s) return;
    try { s.ref.off(s.event, s.handler); } catch (err) { /* noop */ }
    delete slots[name];
  }

  function releasePrefix(prefix) {
    Object.keys(slots).forEach(function (name) {
      if (name.indexOf(prefix) === 0) release(name);
    });
  }

  function audit(action, detail) {
    if (!isCommander() || !db) return Promise.resolve();
    return db.ref(AUDIT_PATH).push({
      at: Date.now(),
      action: 'warroom.' + action,
      actorUid: state.uid,
      actorNick: state.nick,
      tournamentId: state.tournamentId || null,
      detail: detail || null
    }).catch(function (err) {
      console.warn('[warroom] audit:', err && err.message);
    });
  }

  function writeError(err) {
    var msg = (err && err.message) || String(err);
    if (err && err.code === 'PERMISSION_DENIED') {
      msg = 'Permiso denegado por las reglas de la base de datos. Despliega database.rules.json (firebase deploy --only database).';
    }
    setMsg(msg, true);
    toast('error', msg);
  }

  // ---------------------------------------------------------------------------
  // Arranque y permisos
  // ---------------------------------------------------------------------------

  /** Lee el registro de sentinela de un usuario. Se usa desde el guard de acceso. */
  function lookupSentinel(uid) {
    if (!uid) return Promise.resolve(null);
    var database = db || ((typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null);
    if (!database) return Promise.resolve(null);
    return database.ref(SENTINELS_PATH + '/' + uid).once('value').then(function (snap) {
      var rec = snap.val();
      if (!rec || rec.active === false) return null;
      rec.uid = uid;
      return rec;
    }).catch(function () { return null; });
  }

  function init(options) {
    var opts = options || {};
    db = (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
    if (!db) return;
    if (state.ready) return;

    state.mode = opts.mode === 'sentinel' ? 'sentinel' : 'commander';
    state.uid = opts.uid || null;
    state.nick = opts.nick || (state.mode === 'sentinel' ? 'Sentinela' : 'Commander');
    state.rango = opts.rango || '';
    state.sentinelRecord = opts.sentinelRecord || null;
    state.ready = true;

    applyRoleVisibility();
    wireStaticControls();
    subscribeGlobalNodes();
    loadTournamentList();
    startTicker();

    if (tabOpened) refreshAll();
  }

  function onTabOpen() {
    tabOpened = true;
    if (!state.ready) return;
    refreshAll();
    if (state.tournamentId) registerPresence();
  }

  /** Oculta los controles de mando cuando quien mira es un Sentinela. */
  function applyRoleVisibility() {
    var sentinel = !isCommander();
    document.querySelectorAll('[data-cwr-role]').forEach(function (el) {
      var role = el.getAttribute('data-cwr-role');
      var show = (role === 'sentinel') ? sentinel : !sentinel;
      el.style.display = show ? '' : 'none';
    });

    var badge = $('cwrRoleBadge');
    if (badge) {
      badge.textContent = sentinel ? 'Modo Sentinela — solo lectura' : 'Modo Commander — control total';
      badge.className = 'cwr-role-badge' + (sentinel ? ' cwr-role-badge-sentinel' : '');
    }
    var intro = $('cwrRoleIntro');
    if (intro) {
      intro.textContent = sentinel
        ? 'Vigilas el torneo en vivo. Puedes ver servidor, equipos, calendario y premios, y reportar sospechas de trampa. No puedes modificar el torneo.'
        : 'Control universal del torneo: servidor, equipos, calendario inteligente, premios, sentinelas y espectadores en tiempo real.';
    }
  }

  function refreshAll() {
    renderStatusStrip();
    renderServer();
    renderFleet();
    renderTeams();
    renderSchedule();
    renderBracket();
    renderPodium();
    renderPrizes();
    renderSentinels();
    renderSpectators();
    renderReportTeamSelect();
    renderReports();
    renderAudit();
    renderRaw();
  }

  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(function () {
      var section = $('tab-warroom');
      if (!section || section.style.display === 'none') return;
      document.querySelectorAll('[data-cwr-countdown]').forEach(function (el) {
        var target = Number(el.getAttribute('data-cwr-countdown'));
        if (!target) return;
        el.textContent = fmtCountdown(target);
        el.classList.toggle('cwr-countdown-past', target < Date.now());
      });
      document.querySelectorAll('[data-cwr-ago]').forEach(function (el) {
        el.textContent = fmtAgo(Number(el.getAttribute('data-cwr-ago')));
      });
      renderStatusStrip();
      renderLiveHealth();
      renderSpectators();
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Suscripciones globales (no dependen del torneo seleccionado)
  // ---------------------------------------------------------------------------

  function subscribeGlobalNodes() {
    bind('sentinels', db.ref(SENTINELS_PATH), function (snap) {
      state.sentinels = snap.val() || {};
      renderSentinels();
      renderStatusStrip();
    });

    bind('sentinelConfig', db.ref(SENTINEL_CONFIG_PATH), function (snap) {
      state.sentinelConfig = snap.val() || {};
      renderSentinels();
    });

    bind('reports', db.ref(SENTINEL_REPORTS_PATH).orderByChild('createdAt').limitToLast(80), function (snap) {
      state.reports = snap.val() || {};
      renderReports();
      renderStatusStrip();
    });

    // La flota de servidores es de lectura reservada a mando; el Sentinela ve solo el del torneo.
    if (isCommander()) {
      bind('servers', db.ref('gameServers'), function (snap) {
        state.servers = snap.val() || {};
        renderFleet();
        renderServer();
      });

      bind('audit', db.ref(AUDIT_PATH).orderByChild('at').limitToLast(40), function (snap) {
        state.audit = snap.val() || {};
        renderAudit();
      });
    }
  }

  function loadTournamentList() {
    bind('tournaments', db.ref('tournaments').orderByChild('createdAt').limitToLast(40), function (snap) {
      var list = {};
      snap.forEach(function (child) {
        list[child.key] = child.val() || {};
      });
      state.tournamentList = list;
      renderTournamentSelect();
      if (!state.tournamentId) autoSelectTournament();
    });
  }

  function renderTournamentSelect() {
    var select = $('cwrTournamentSelect');
    if (!select) return;
    var ids = keys(state.tournamentList).sort(function (a, b) {
      return num(state.tournamentList[b].createdAt) - num(state.tournamentList[a].createdAt);
    });
    var current = state.tournamentId || '';
    select.innerHTML = '<option value="">— Selecciona un torneo —</option>';
    ids.forEach(function (id) {
      var t = state.tournamentList[id] || {};
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = (t.name || id) + '  ·  ' + statusLabel(t.status) +
        '  ·  ' + keys(t.registeredTeams).length + ' equipos';
      select.appendChild(opt);
    });
    select.value = current;
  }

  /** Prioriza el torneo en vivo; si no hay, el siguiente programado. */
  function autoSelectTournament() {
    var ids = keys(state.tournamentList);
    if (!ids.length) return;
    var live = ids.filter(function (id) { return state.tournamentList[id].status === 'en_vivo'; });
    var pool = live.length ? live : ids.filter(function (id) {
      var st = state.tournamentList[id].status;
      return st !== 'finalizado' && st !== 'cancelado';
    });
    if (!pool.length) pool = ids;
    pool.sort(function (a, b) {
      return num(state.tournamentList[a].schedule || state.tournamentList[a].createdAt) -
             num(state.tournamentList[b].schedule || state.tournamentList[b].createdAt);
    });
    selectTournament(pool[0]);
  }

  function statusLabel(status) {
    switch (String(status || '')) {
      case 'en_vivo': return 'EN VIVO';
      case 'finalizado':
      case 'finished':
      case 'completed': return 'Finalizado';
      case 'cancelado': return 'Cancelado';
      case 'pendiente':
      case 'pending': return 'Pendiente';
      default: return status ? String(status) : 'Pendiente';
    }
  }

  // ---------------------------------------------------------------------------
  // Selección de torneo y suscripciones dependientes
  // ---------------------------------------------------------------------------

  function selectTournament(tid) {
    if (!tid) return;
    if (state.tournamentId === tid) return;

    releasePrefix('t:');
    releasePrefix('team:');
    detachPresence();

    state.tournamentId = tid;
    state.tournament = null;
    state.server = null;
    state.serverId = null;
    state.live = null;
    state.liveMatchId = null;
    state.teams = {};
    state.invites = {};
    state.presence = {};
    state.prizeDirty = false;
    state.scheduleDirty = false;

    var select = $('cwrTournamentSelect');
    if (select) select.value = tid;

    var publicLink = $('cwrPublicLink');
    if (publicLink) publicLink.href = 'tournament-details.html?id=' + encodeURIComponent(tid);

    bind('t:tournament', db.ref('tournaments/' + tid), function (snap) {
      state.tournament = snap.val() || null;
      onTournamentData();
    });

    bind('t:presence', db.ref(PRESENCE_PATH + '/' + tid), function (snap) {
      state.presence = snap.val() || {};
      renderSpectators();
      renderStatusStrip();
    });

    if (isCommander()) {
      bind('t:invites', db.ref('tournaments/' + tid + '/outboundInvites'), function (snap) {
        state.invites = snap.val() || {};
        renderTeams();
      });
    }

    registerPresence();
    setMsg('');
    refreshAll();
  }

  function onTournamentData() {
    var t = state.tournament;
    if (!t) {
      setMsg('El torneo ya no existe (puede haber sido borrado).', true);
      refreshAll();
      return;
    }

    syncTeamSubscriptions(keys(t.registeredTeams));
    syncServerSubscription(t.activeServerId);
    syncLiveSubscription(t.activeMatchId || t.currentMatchId);

    if (!state.scheduleDirty) fillScheduleForm();
    if (!state.prizeDirty) fillPrizeForm();
    fillNoteForm();

    refreshAll();
  }

  function syncTeamSubscriptions(teamIds) {
    var wanted = {};
    (teamIds || []).forEach(function (id) { wanted['team:' + id] = true; });

    Object.keys(slots).forEach(function (name) {
      if (name.indexOf('team:') === 0 && !wanted[name]) {
        release(name);
        delete state.teams[name.slice(5)];
      }
    });

    (teamIds || []).forEach(function (id) {
      if (slots['team:' + id]) return;
      bind('team:' + id, db.ref('teams/' + id), function (snap) {
        var team = snap.val();
        if (team) {
          team.id = id;
          state.teams[id] = team;
        } else {
          state.teams[id] = { id: id, name: id, missing: true };
        }
        renderTeams();
        renderBracket();
        renderSchedule();
        renderPodium();
        renderPrizes();
      });
    });
  }

  function syncServerSubscription(serverId) {
    var sid = serverId ? String(serverId) : null;
    if (state.serverId === sid) return;
    release('t:server');
    state.serverId = sid;
    state.server = null;
    if (!sid) {
      renderServer();
      return;
    }
    bind('t:server', db.ref('gameServers/' + sid), function (snap) {
      state.server = snap.val() || null;
      renderServer();
      renderStatusStrip();
    });
  }

  function syncLiveSubscription(matchId) {
    var mid = matchId ? String(matchId) : null;
    if (state.liveMatchId === mid) return;
    release('t:live');
    state.liveMatchId = mid;
    state.live = null;
    if (!mid) {
      renderServer();
      return;
    }
    bind('t:live', db.ref('partida_en_vivo/' + mid), function (snap) {
      state.live = snap.val() || null;
      renderServer();
      renderStatusStrip();
      renderBracket();
      maybeAutopilot();
    });
  }

  // ---------------------------------------------------------------------------
  // Fase del torneo (¿preparándose o en vivo?)
  // ---------------------------------------------------------------------------

  function computePhase() {
    var t = state.tournament || {};
    var srv = state.server;
    var live = state.live;

    if (t.status === 'finalizado' || t.status === 'finished' || t.status === 'completed') {
      return { key: 'finished', label: 'Finalizado', tone: 'muted' };
    }
    if (t.status === 'cancelado') {
      return { key: 'cancelled', label: 'Cancelado', tone: 'muted' };
    }
    if (live) {
      if (live.status === 'finished') {
        return { key: 'match-end', label: 'Partida terminada — falta resolver', tone: 'warn' };
      }
      if (live.status === 'live') {
        if (live.currentRound == null) {
          return { key: 'warmup', label: 'Calentamiento (warmup)', tone: 'warn' };
        }
        return { key: 'live', label: 'EN VIVO — ronda ' + live.currentRound, tone: 'live' };
      }
      if (live.status === 'starting') {
        return { key: 'starting', label: 'Arrancando partida', tone: 'warn' };
      }
    }
    if (srv) {
      switch (srv.status) {
        case 'provisioning': return { key: 'provisioning', label: 'Creando servidor', tone: 'warn' };
        case 'booting': return { key: 'booting', label: 'Servidor arrancando', tone: 'warn' };
        case 'online': return { key: 'ready', label: 'Servidor listo — preparando', tone: 'ok' };
        case 'udp_blocked': return { key: 'udp', label: 'UDP bloqueado', tone: 'error' };
        case 'rcon_timeout': return { key: 'rcon', label: 'RCON sin respuesta', tone: 'error' };
        case 'error': return { key: 'error', label: 'Error del servidor', tone: 'error' };
        case 'match_complete': return { key: 'complete', label: 'Partida completada', tone: 'muted' };
        default: break;
      }
    }
    return { key: 'preparing', label: 'Preparándose (sin servidor)', tone: 'muted' };
  }

  function activeSpectators() {
    var now = Date.now();
    var out = [];
    keys(state.presence).forEach(function (uid) {
      var p = state.presence[uid] || {};
      var seen = num(p.lastSeen || p.joinedAt);
      if (now - seen > PRESENCE_TTL_MS) return;
      p.uid = uid;
      out.push(p);
    });
    out.sort(function (a, b) {
      var order = { commander: 0, sentinel: 1, player: 2, spectator: 3 };
      var oa = order[a.role] == null ? 4 : order[a.role];
      var ob = order[b.role] == null ? 4 : order[b.role];
      if (oa !== ob) return oa - ob;
      return num(a.joinedAt) - num(b.joinedAt);
    });
    return out;
  }

  function openReportCount() {
    var tid = state.tournamentId;
    return keys(state.reports).filter(function (id) {
      var r = state.reports[id] || {};
      if (r.status && r.status !== 'open') return false;
      return !tid || !r.tournamentId || r.tournamentId === tid;
    }).length;
  }

  function renderStatusStrip() {
    var strip = $('cwrStatusStrip');
    if (!strip) return;
    var t = state.tournament;
    if (!t) {
      strip.innerHTML = '<span class="cwr-chip cwr-chip-muted">Sin torneo seleccionado</span>';
      return;
    }

    var phase = computePhase();
    var srv = state.server || {};
    var teamsCount = keys(t.registeredTeams).length;
    var maxTeams = (t.teams && t.teams.max) || 0;
    var spectators = activeSpectators();
    var sentinelsOn = spectators.filter(function (p) { return p.role === 'sentinel'; }).length;
    var prizes = t.prizes || {};
    var pool = num(prizes.tokenPool, num(t.prizePool));
    var startAt = num((t.scheduleConfig && t.scheduleConfig.startAt) || t.schedule);
    var reports = openReportCount();

    var chips = [];
    chips.push(chip(statusLabel(t.status), t.status === 'en_vivo' ? 'live' : 'muted', 'fa-circle-notch'));
    chips.push(chip(phase.label, phase.tone, 'fa-wave-square'));
    chips.push(chip(
      srv.ip ? srv.ip + ':' + (srv.port || 27015) : 'Sin IP',
      srv.ip ? 'ok' : 'muted', 'fa-network-wired'
    ));
    chips.push(chip(teamsCount + (maxTeams ? '/' + maxTeams : '') + ' equipos', 'info', 'fa-users'));
    chips.push(chip(spectators.length + ' viendo', spectators.length ? 'info' : 'muted', 'fa-eye'));
    chips.push(chip(sentinelsOn + ' sentinela' + (sentinelsOn === 1 ? '' : 's') + ' en línea',
      sentinelsOn ? 'ok' : 'muted', 'fa-user-secret'));
    chips.push(chip(fmtTokens(pool) + ' tokens en juego', pool ? 'gold' : 'muted', 'fa-coins'));
    if (reports) chips.push(chip(reports + ' reporte' + (reports === 1 ? '' : 's') + ' abierto', 'error', 'fa-flag'));
    if (startAt) {
      chips.push('<span class="cwr-chip cwr-chip-info"><i class="fas fa-hourglass-half"></i> ' +
        (startAt > Date.now() ? 'Empieza en ' : 'Empezó hace ') +
        '<b data-cwr-countdown="' + startAt + '">' + fmtCountdown(startAt) + '</b></span>');
    }

    strip.innerHTML = chips.join('');
  }

  function chip(text, tone, icon) {
    return '<span class="cwr-chip cwr-chip-' + (tone || 'muted') + '">' +
      (icon ? '<i class="fas ' + icon + '"></i> ' : '') + esc(text) + '</span>';
  }

  // ---------------------------------------------------------------------------
  // Servidor de juego: toda la información disponible
  // ---------------------------------------------------------------------------

  var SERVER_PIPELINE = [
    { key: 'requested', label: 'VM solicitada', icon: 'fa-cloud-upload-alt' },
    { key: 'booting', label: 'Arrancando SO', icon: 'fa-power-off' },
    { key: 'portReady', label: 'Puerto TCP 27015', icon: 'fa-plug' },
    { key: 'rconReady', label: 'RCON conectado', icon: 'fa-terminal' },
    { key: 'gameUdpOk', label: 'UDP de juego', icon: 'fa-satellite-dish' },
    { key: 'online', label: 'Servidor online', icon: 'fa-check-circle' }
  ];

  function pipelineStepState(step, srv) {
    if (!srv) return 'idle';
    var st = srv.status;
    switch (step) {
      case 'requested':
        return 'done';
      case 'booting':
        return (st === 'provisioning') ? 'active' : 'done';
      case 'portReady':
        if (srv.portReady) return 'done';
        return (st === 'booting' || st === 'provisioning') ? 'active' : (st === 'error' ? 'fail' : 'idle');
      case 'rconReady':
        if (srv.rconReady) return 'done';
        if (st === 'rcon_timeout') return 'fail';
        return srv.portReady ? 'active' : 'idle';
      case 'gameUdpOk':
        if (srv.gameUdpOk) return 'done';
        if (st === 'udp_blocked') return 'fail';
        return srv.rconReady ? 'active' : 'idle';
      case 'online':
        if (st === 'online') return 'done';
        if (st === 'error') return 'fail';
        return 'idle';
      default:
        return 'idle';
    }
  }

  function renderServer() {
    renderConnectPanel();
    renderServerPipeline();
    renderServerGrid();
    renderLiveBlock();
    renderLiveHealth();
    renderRaw();
  }

  function renderConnectPanel() {
    var box = $('cwrConnectPanel');
    if (!box) return;
    var srv = state.server;
    var t = state.tournament || {};
    var ip = (srv && srv.ip) || t.serverIp;
    var port = (srv && srv.port) || t.serverPort || 27015;

    if (!ip) {
      box.innerHTML = '<div class="cwr-connect-empty"><i class="fas fa-plug"></i> Sin servidor asignado. ' +
        (isCommander() ? 'Usa <b>Crear servidor</b> para levantar una VM en la nube.' : 'El Commander aún no ha levantado el servidor.') +
        '</div>';
      return;
    }

    var connect = 'connect ' + ip + ':' + port;
    var gotvPort = num(srv && srv.gotvPort, 27020);
    var gotv = 'connect ' + ip + ':' + gotvPort;

    box.innerHTML =
      '<div class="cwr-connect-row">' +
        '<div class="cwr-connect-label">IP en vivo</div>' +
        '<code class="cwr-connect-code">' + esc(ip + ':' + port) + '</code>' +
        '<button type="button" class="cwr-mini-btn" data-cwr-copy="' + esc(ip + ':' + port) + '">' +
          '<i class="fas fa-copy"></i> IP</button>' +
        '<button type="button" class="cwr-mini-btn" data-cwr-copy="' + esc(connect) + '">' +
          '<i class="fas fa-terminal"></i> Consola CS2</button>' +
      '</div>' +
      '<div class="cwr-connect-row">' +
        '<div class="cwr-connect-label">GOTV (espectar)</div>' +
        '<code class="cwr-connect-code">' + esc(ip + ':' + gotvPort) + '</code>' +
        '<button type="button" class="cwr-mini-btn" data-cwr-copy="' + esc(gotv) + '">' +
          '<i class="fas fa-video"></i> Copiar GOTV</button>' +
      '</div>' +
      '<p class="cwr-hint"><i class="fas fa-info-circle"></i> Pega el comando en la consola de CS2 (tecla <b>~</b>). ' +
      'No lo abras en modo práctica/offline: eso te conecta a tu propio equipo, no al servidor del torneo.</p>';
  }

  function renderServerPipeline() {
    var box = $('cwrServerPipeline');
    if (!box) return;
    var srv = state.server;
    box.innerHTML = SERVER_PIPELINE.map(function (step) {
      var st = pipelineStepState(step.key, srv);
      return '<div class="cwr-step cwr-step-' + st + '">' +
        '<i class="fas ' + step.icon + '"></i>' +
        '<span>' + esc(step.label) + '</span>' +
      '</div>';
    }).join('<div class="cwr-step-sep"></div>');
  }

  var SERVER_FIELD_LABELS = {
    status: 'Estado',
    ip: 'IP pública',
    port: 'Puerto de juego',
    provider: 'Proveedor cloud',
    region: 'Región',
    cloudServerId: 'ID en el proveedor',
    hetznerId: 'ID Hetzner',
    provisionMode: 'Modo de aprovisionamiento',
    tournamentId: 'Torneo asignado',
    matchId: 'Partida asignada',
    lastMatchId: 'Última partida',
    rconReady: 'RCON listo',
    portReady: 'Puerto TCP abierto',
    gameUdpOk: 'UDP de juego OK',
    createdAt: 'Creado',
    updatedAt: 'Última actualización',
    error: 'Último error',
    plan: 'Plan / tamaño',
    os: 'Sistema operativo',
    label: 'Etiqueta',
    hostname: 'Hostname',
    gotvPort: 'Puerto GOTV'
  };

  function renderServerGrid() {
    var box = $('cwrServerGrid');
    if (!box) return;
    var srv = state.server;
    var t = state.tournament || {};

    if (!srv && !t.serverIp) {
      box.innerHTML = '<p class="cwr-empty">Sin datos de servidor todavía.</p>';
      return;
    }

    var rows = [];
    var data = srv || {};

    // Campos conocidos primero, en orden legible.
    Object.keys(SERVER_FIELD_LABELS).forEach(function (key) {
      if (!(key in data)) return;
      rows.push(infoCell(SERVER_FIELD_LABELS[key], formatServerValue(key, data[key])));
    });

    // Cualquier campo nuevo que el backend empiece a publicar aparece igual, sin tocar código.
    Object.keys(data).forEach(function (key) {
      if (SERVER_FIELD_LABELS[key]) return;
      if (data[key] && typeof data[key] === 'object') return;
      rows.push(infoCell(key, formatServerValue(key, data[key])));
    });

    if (data.createdAt) {
      rows.push(infoCell('Tiempo encendido', fmtDuration((Date.now() - num(data.createdAt)) / 1000)));
    }
    rows.push(infoCell('ID interno del servidor', state.serverId || '—'));
    rows.push(infoCell('Mapa activo', t.activeMap || (state.live && state.live.map) || '—'));
    rows.push(infoCell('Partida activa', t.activeMatchId || '—'));
    rows.push(infoCell('Partida en curso (bracket)', t.currentMatchId || '—'));

    box.innerHTML = rows.join('');
  }

  function formatServerValue(key, value) {
    if (value === true) return 'Sí';
    if (value === false) return 'No';
    if (value == null || value === '') return '—';
    if (key === 'createdAt' || key === 'updatedAt') return fmtDateTime(value) + ' (' + fmtAgo(value) + ')';
    if (key === 'status') return statusServerLabel(value);
    return String(value);
  }

  function statusServerLabel(status) {
    switch (String(status)) {
      case 'provisioning': return 'Creando VM';
      case 'booting': return 'Arrancando';
      case 'online': return 'Online';
      case 'udp_blocked': return 'UDP bloqueado';
      case 'rcon_timeout': return 'RCON sin respuesta';
      case 'error': return 'Error';
      case 'match_complete': return 'Partida completada';
      default: return String(status);
    }
  }

  function infoCell(label, value) {
    return '<div class="cwr-info-cell">' +
      '<div class="cwr-info-label">' + esc(label) + '</div>' +
      '<div class="cwr-info-value">' + esc(value) + '</div>' +
    '</div>';
  }

  function renderLiveBlock() {
    var box = $('cwrLiveBlock');
    if (!box) return;
    var live = state.live;
    if (!live) {
      box.innerHTML = '<p class="cwr-empty">No hay partida en vivo. Cuando se lance una, aquí verás marcador, ronda, MVP y bajas en tiempo real.</p>';
      return;
    }

    var match = currentBracketMatch();
    var nameA = match ? teamName(match.teamA && match.teamA.teamId) : 'Equipo 1';
    var nameB = match ? teamName(match.teamB && match.teamB.teamId) : 'Equipo 2';
    var ct = live.scoreCT != null ? live.scoreCT : '—';
    var tt = live.scoreT != null ? live.scoreT : '—';

    var html =
      '<div class="cwr-scoreboard">' +
        '<div class="cwr-score-team">' + esc(nameA) + '<span class="cwr-score-side">CT (team1)</span></div>' +
        '<div class="cwr-score-value">' + esc(ct) + ' <span>:</span> ' + esc(tt) + '</div>' +
        '<div class="cwr-score-team cwr-score-team-right">' + esc(nameB) + '<span class="cwr-score-side">T (team2)</span></div>' +
      '</div>' +
      '<div class="cwr-info-grid">' +
        infoCell('Estado de la partida', live.status || '—') +
        infoCell('Ronda actual', live.currentRound != null ? live.currentRound : 'Calentamiento') +
        infoCell('Mapa', live.map || '—') +
        infoCell('Último evento', live.lastEvent || '—') +
        infoCell('Recibido', live.lastEventAt ? fmtAgo(live.lastEventAt) : '—') +
        infoCell('Duración', live.durationSeconds ? fmtDuration(live.durationSeconds) : '—') +
        infoCell('Duración de ronda', live.roundDuration ? fmtDuration(live.roundDuration) : '—') +
        infoCell('MVP', live.lastMvp || live.mvp || '—') +
        infoCell('RCON al lanzar', live.rconOk === true ? 'OK' : (live.rconOk === false ? 'Falló' : '—')) +
        infoCell('Modo de lanzamiento', live.launchMode || '—') +
        infoCell('MatchZy', live.matchzy === true ? 'Sí' : (live.matchzy === false ? 'No' : '—')) +
        infoCell('Ganador reportado', live.winnerTeamId ? teamName(live.winnerTeamId) : '—') +
      '</div>';

    if (live.matchzyHint) {
      html += '<p class="cwr-hint"><i class="fas fa-lightbulb"></i> ' + esc(live.matchzyHint) + '</p>';
    }

    html += renderKillsBoard(live);
    box.innerHTML = html;
  }

  function renderKillsBoard(live) {
    var kills = live.kills;
    if (!kills || typeof kills !== 'object') return '';
    var rows = Object.keys(kills).map(function (player) {
      return { player: player, kills: num(kills[player]) };
    }).sort(function (a, b) { return b.kills - a.kills; });
    if (!rows.length) return '';

    var max = rows[0].kills || 1;
    return '<div class="cwr-kills">' +
      '<div class="cwr-kills-title">Bajas por jugador</div>' +
      rows.map(function (r) {
        return '<div class="cwr-kill-row">' +
          '<span class="cwr-kill-name">' + esc(r.player) + '</span>' +
          '<span class="cwr-kill-bar"><i style="width:' + Math.round((r.kills / max) * 100) + '%"></i></span>' +
          '<span class="cwr-kill-num">' + r.kills + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function renderLiveHealth() {
    var el = $('cwrLiveHealth');
    if (!el) return;
    var live = state.live;
    if (!live) {
      el.innerHTML = '';
      return;
    }
    var last = num(live.lastEventAt || live.startedAt);
    var stale = last && (Date.now() - last > LIVE_STALE_MS);
    if (live.status === 'finished') {
      el.innerHTML = '<div class="cwr-health cwr-health-muted"><i class="fas fa-flag-checkered"></i> ' +
        'Partida terminada ' + esc(fmtAgo(live.finishedAt || last)) + '.</div>';
      return;
    }
    if (stale) {
      el.innerHTML = '<div class="cwr-health cwr-health-warn"><i class="fas fa-exclamation-triangle"></i> ' +
        'Sin señal del servidor desde ' + esc(fmtAgo(last)) + '. El plugin NexusBridge puede estar caído.</div>';
      return;
    }
    el.innerHTML = '<div class="cwr-health cwr-health-ok"><i class="fas fa-heartbeat"></i> ' +
      'Telemetría viva · último evento ' + esc(fmtAgo(last)) + '.</div>';
  }

  function renderFleet() {
    var box = $('cwrFleetList');
    if (!box) return;
    var ids = keys(state.servers);
    if (!ids.length) {
      box.innerHTML = '<p class="cwr-empty">No hay servidores en la flota. Cada VM apagada deja de facturar.</p>';
      return;
    }
    ids.sort(function (a, b) {
      return num(state.servers[b].createdAt) - num(state.servers[a].createdAt);
    });

    box.innerHTML = ids.map(function (sid) {
      var s = state.servers[sid] || {};
      var tone = s.status === 'online' ? 'ok'
        : (s.status === 'error' || s.status === 'udp_blocked' || s.status === 'rcon_timeout') ? 'error'
        : (s.status === 'match_complete') ? 'muted' : 'warn';
      var tName = s.tournamentId && state.tournamentList[s.tournamentId]
        ? state.tournamentList[s.tournamentId].name : s.tournamentId;
      return '<div class="cwr-fleet-row' + (sid === state.serverId ? ' cwr-fleet-row-active' : '') + '">' +
        '<span class="cwr-fleet-ip">' + esc(s.ip || sid) + ':' + esc(s.port || 27015) + '</span>' +
        '<span class="cwr-chip cwr-chip-' + tone + '">' + esc(statusServerLabel(s.status || 'desconocido')) + '</span>' +
        '<span class="cwr-fleet-meta">' + esc(tName || 'sin torneo') + '</span>' +
        '<span class="cwr-fleet-meta">' + esc(s.provider || '—') + ' · ' + esc(s.region || '—') + '</span>' +
        '<span class="cwr-fleet-meta" data-cwr-ago="' + num(s.createdAt) + '">' + esc(fmtAgo(s.createdAt)) + '</span>' +
        (isCommander()
          ? '<button type="button" class="cwr-mini-btn cwr-mini-btn-danger" data-cwr-shutdown="' + esc(sid) + '">' +
            '<i class="fas fa-power-off"></i> Apagar</button>'
          : '') +
      '</div>';
    }).join('');
  }

  function renderRaw() {
    var box = $('cwrRawDump');
    if (!box) return;
    if (!state.rawOpen) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    var dump = {
      tournamentId: state.tournamentId,
      tournament: state.tournament,
      serverId: state.serverId,
      gameServer: state.server,
      liveMatchId: state.liveMatchId,
      partida_en_vivo: state.live,
      teams: state.teams,
      presenceActiva: activeSpectators()
    };
    var text;
    try {
      text = JSON.stringify(dump, null, 2);
    } catch (err) {
      text = 'No se pudo serializar el estado: ' + err.message;
    }
    box.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Equipos: inscritos, invitados, pausar / eliminar / transferir
  // ---------------------------------------------------------------------------

  function teamStrength(team) {
    if (!team) return { score: 0, wins: 0, verified: false, roster: 0 };
    var stats = team.stats || {};
    var wins = num(stats.wins);
    var tokens = num(stats.tokens);
    var vStatus = String((team.verification && team.verification.status) || '').toLowerCase();
    var verified = vStatus === 'verified' || vStatus === 'active' || vStatus === 'paid';
    var roster = keys(team.roster || team.members).length;
    var score = wins * 100 + (verified ? 40 : 0) + Math.min(roster, 5) * 6 + Math.min(tokens, 1000) / 100;
    return { score: score, wins: wins, verified: verified, roster: roster, tokens: tokens };
  }

  function rankedTeamIds() {
    var t = state.tournament || {};
    var ids = keys(t.registeredTeams).filter(function (id) {
      var st = (t.teamStates && t.teamStates[id]) || {};
      return st.status !== 'paused';
    });
    var mode = (t.scheduleConfig && t.scheduleConfig.seedMode) || DEFAULT_SCHEDULE.seedMode;

    if (mode === 'manual') {
      var seeds = t.teamSeeds || {};
      ids.sort(function (a, b) {
        var sa = num(seeds[a], 9999);
        var sb = num(seeds[b], 9999);
        if (sa !== sb) return sa - sb;
        return teamName(a).localeCompare(teamName(b));
      });
      return ids;
    }
    if (mode === 'random') {
      // Barajado determinista por torneo: la misma siembra se reproduce hasta regenerar.
      var seedBase = num(t.scheduleConfig && t.scheduleConfig.randomSeed, num(t.createdAt) || 1);
      return shuffleDeterministic(ids, seedBase);
    }
    ids.sort(function (a, b) {
      var d = teamStrength(state.teams[b]).score - teamStrength(state.teams[a]).score;
      if (d) return d;
      return teamName(a).localeCompare(teamName(b));
    });
    return ids;
  }

  function shuffleDeterministic(list, seed) {
    var arr = list.slice();
    var s = num(seed, 1) || 1;
    function rnd() {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    }
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function renderTeams() {
    var t = state.tournament;
    var summary = $('cwrTeamsSummary');
    var body = $('cwrTeamsBody');
    var empty = $('cwrTeamsEmpty');
    if (!body) return;

    if (!t) {
      body.innerHTML = '';
      if (empty) { empty.style.display = 'block'; empty.textContent = 'Selecciona un torneo.'; }
      if (summary) summary.innerHTML = '';
      return;
    }

    var ranked = rankedTeamIds();
    var allIds = keys(t.registeredTeams);
    var paused = allIds.filter(function (id) {
      var st = (t.teamStates && t.teamStates[id]) || {};
      return st.status === 'paused';
    });
    var maxTeams = (t.teams && t.teams.max) || 0;
    var verifiedCount = allIds.filter(function (id) { return teamStrength(state.teams[id]).verified; }).length;
    var players = allIds.reduce(function (acc, id) { return acc + teamStrength(state.teams[id]).roster; }, 0);

    if (summary) {
      summary.innerHTML =
        chip(allIds.length + (maxTeams ? ' de ' + maxTeams : '') + ' inscritos', 'info', 'fa-clipboard-check') +
        chip(keys(state.invites).length + ' invitados sin responder', 'muted', 'fa-paper-plane') +
        chip(paused.length + ' pausados', paused.length ? 'warn' : 'muted', 'fa-pause') +
        chip(verifiedCount + ' verificados', 'ok', 'fa-certificate') +
        chip(players + ' jugadores en roster', 'info', 'fa-user-friends');
    }

    var order = ranked.concat(paused);
    if (!order.length) {
      body.innerHTML = '';
      if (empty) {
        empty.style.display = 'block';
        empty.textContent = 'Ningún equipo inscrito todavía. Usa el centro de invitaciones para convocarlos.';
      }
      renderInvites();
      return;
    }
    if (empty) empty.style.display = 'none';

    body.innerHTML = order.map(function (id, idx) {
      var team = state.teams[id] || {};
      var st = teamStrength(team);
      var teamState = (t.teamStates && t.teamStates[id]) || {};
      var isPaused = teamState.status === 'paused';
      var emblem = teamEmblem(id);
      var seedNo = isPaused ? '—' : (idx + 1);

      return '<tr class="' + (isPaused ? 'cwr-row-paused' : '') + '">' +
        '<td class="cwr-seed">' + esc(seedNo) + '</td>' +
        '<td>' +
          '<div class="cwr-team-cell">' +
            (emblem
              ? '<img class="cwr-team-emblem" src="' + esc(emblem) + '" alt="" loading="lazy">'
              : '<span class="cwr-team-emblem cwr-team-emblem-fallback"><i class="fas fa-shield-alt"></i></span>') +
            '<div>' +
              '<div class="cwr-team-name">' + esc(team.name || id) + '</div>' +
              '<div class="cwr-team-sub">' + esc(id) + '</div>' +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td>' + esc(st.roster) + '</td>' +
        '<td>' + esc(st.wins) + '</td>' +
        '<td>' + (st.verified
          ? '<span class="cwr-chip cwr-chip-ok"><i class="fas fa-certificate"></i> Verificado</span>'
          : '<span class="cwr-chip cwr-chip-muted">Sin verificar</span>') + '</td>' +
        '<td><span class="cwr-strength" title="Fuerza calculada: victorias, verificación, roster y tokens">' +
          esc(Math.round(st.score)) + '</span></td>' +
        '<td>' + (isPaused
          ? '<span class="cwr-chip cwr-chip-warn"><i class="fas fa-pause"></i> Pausado</span>'
          : '<span class="cwr-chip cwr-chip-ok"><i class="fas fa-play"></i> Activo</span>') + '</td>' +
        (isCommander() ? '<td class="cwr-actions-cell">' +
          '<button type="button" class="cwr-mini-btn" data-cwr-team-toggle="' + esc(id) + '">' +
            '<i class="fas fa-' + (isPaused ? 'play' : 'pause') + '"></i> ' + (isPaused ? 'Reanudar' : 'Pausar') + '</button>' +
          '<button type="button" class="cwr-mini-btn" data-cwr-team-transfer="' + esc(id) + '">' +
            '<i class="fas fa-exchange-alt"></i> Transferir</button>' +
          '<button type="button" class="cwr-mini-btn cwr-mini-btn-danger" data-cwr-team-remove="' + esc(id) + '">' +
            '<i class="fas fa-trash"></i> Eliminar</button>' +
        '</td>' : '') +
      '</tr>';
    }).join('');

    renderInvites();
  }

  function renderInvites() {
    var box = $('cwrInvitesList');
    if (!box) return;
    var ids = keys(state.invites);
    if (!ids.length) {
      box.innerHTML = '<p class="cwr-empty">Sin invitaciones pendientes.</p>';
      return;
    }
    box.innerHTML = ids.map(function (id) {
      var inv = state.invites[id] || {};
      return '<div class="cwr-invite-row">' +
        '<i class="fas fa-paper-plane"></i>' +
        '<span>' + esc(inv.teamName || teamName(id)) + '</span>' +
        '<span class="cwr-fleet-meta">' + esc(inv.sentAt ? fmtAgo(inv.sentAt) : 'pendiente') + '</span>' +
      '</div>';
    }).join('');
  }

  function toggleTeamPause(teamId) {
    var t = state.tournament;
    if (!t || !teamId) return;
    var current = (t.teamStates && t.teamStates[teamId]) || {};
    var pausing = current.status !== 'paused';
    if (pausing) {
      var reason = window.prompt('Motivo para pausar a "' + teamName(teamId) + '" (queda en el registro):', 'Revisión de sospecha');
      if (reason === null) return;
      db.ref('tournaments/' + state.tournamentId + '/teamStates/' + teamId).set({
        status: 'paused',
        reason: (reason || '').trim() || 'Sin motivo indicado',
        at: Date.now(),
        byUid: state.uid,
        byNick: state.nick
      }).then(function () {
        toast('success', teamName(teamId) + ' pausado. Queda fuera de la siembra hasta reanudarlo.');
        audit('team.pause', { teamId: teamId, reason: reason });
      }).catch(writeError);
    } else {
      db.ref('tournaments/' + state.tournamentId + '/teamStates/' + teamId).remove().then(function () {
        toast('success', teamName(teamId) + ' reanudado.');
        audit('team.resume', { teamId: teamId });
      }).catch(writeError);
    }
  }

  function removeTeam(teamId) {
    if (!state.tournamentId || !teamId) return;
    var name = teamName(teamId);
    if (!window.confirm('¿Eliminar a "' + name + '" del torneo?\n\nSe borra su inscripción y su estado. Si ya hay bracket generado, tendrás que regenerarlo para que los cruces cuadren.')) return;

    var updates = {};
    var base = 'tournaments/' + state.tournamentId;
    updates[base + '/registeredTeams/' + teamId] = null;
    updates[base + '/teamStates/' + teamId] = null;
    updates[base + '/teamSeeds/' + teamId] = null;

    db.ref().update(updates).then(function () {
      toast('success', name + ' eliminado del torneo.');
      audit('team.remove', { teamId: teamId, teamName: name });
      setMsg('Equipo eliminado. Revisa el bracket: puede necesitar regenerarse.');
    }).catch(writeError);
  }

  function transferTeam(teamId) {
    if (!state.tournamentId || !teamId) return;
    var options = keys(state.tournamentList).filter(function (id) {
      if (id === state.tournamentId) return false;
      var st = state.tournamentList[id].status;
      return st !== 'finalizado' && st !== 'cancelado';
    });
    if (!options.length) {
      toast('error', 'No hay otro torneo abierto al que transferir.');
      return;
    }
    var listText = options.map(function (id, i) {
      return (i + 1) + ') ' + (state.tournamentList[id].name || id);
    }).join('\n');
    var choice = window.prompt('Transferir "' + teamName(teamId) + '" a:\n\n' + listText + '\n\nEscribe el número:');
    if (choice === null) return;
    var idx = parseInt(choice, 10) - 1;
    if (!(idx >= 0 && idx < options.length)) {
      toast('error', 'Opción no válida.');
      return;
    }
    var targetId = options[idx];
    var targetName = state.tournamentList[targetId].name || targetId;
    if (!window.confirm('Mover "' + teamName(teamId) + '" de este torneo a "' + targetName + '"?')) return;

    var updates = {};
    updates['tournaments/' + state.tournamentId + '/registeredTeams/' + teamId] = null;
    updates['tournaments/' + state.tournamentId + '/teamStates/' + teamId] = null;
    updates['tournaments/' + targetId + '/registeredTeams/' + teamId] = true;

    db.ref().update(updates).then(function () {
      toast('success', teamName(teamId) + ' transferido a ' + targetName + '.');
      audit('team.transfer', { teamId: teamId, from: state.tournamentId, to: targetId });
    }).catch(writeError);
  }

  // ---------------------------------------------------------------------------
  // Calendario inteligente + bracket de eliminación directa
  //
  // La estructura escrita es idéntica a functions/cs2-nexus/lib/bracket.js, así
  // que el webhook del servidor de juego puede seguir avanzando ganadores solo.
  // Aquí se añaden siembra por fuerza, horarios por ronda, byes y cierre manual.
  // ---------------------------------------------------------------------------

  /** Orden de huecos de un cuadro: 1 contra el último, sin cruces tempranos entre cabezas de serie. */
  function seedSlotOrder(size) {
    var order = [1, 2];
    while (order.length < size) {
      var next = [];
      var pairSum = order.length * 2 + 1;
      for (var i = 0; i < order.length; i++) {
        next.push(order[i]);
        next.push(pairSum - order[i]);
      }
      order = next;
    }
    return order;
  }

  function orderedMatchIds(matches) {
    return keys(matches).sort(function (a, b) {
      var ra = num(matches[a].round), rb = num(matches[b].round);
      if (ra !== rb) return ra - rb;
      return num(a.split('_m')[1]) - num(b.split('_m')[1]);
    });
  }

  function readScheduleForm() {
    var t = state.tournament || {};
    var saved = t.scheduleConfig || {};
    var v = function (id) { var el = $(id); return el ? el.value : ''; };
    return {
      startAt: fromLocalInputValue(v('cwrSchedStartAt')) || num(saved.startAt) || num(t.schedule) || Date.now(),
      matchMinutes: num(v('cwrSchedMatchMin'), num(saved.matchMinutes, DEFAULT_SCHEDULE.matchMinutes)),
      gapMinutes: num(v('cwrSchedGapMin'), num(saved.gapMinutes, DEFAULT_SCHEDULE.gapMinutes)),
      roundGapMinutes: num(v('cwrSchedRoundGapMin'), num(saved.roundGapMinutes, DEFAULT_SCHEDULE.roundGapMinutes)),
      serverSlots: Math.max(1, num(v('cwrSchedSlots'), num(saved.serverSlots, DEFAULT_SCHEDULE.serverSlots))),
      bestOf: num(v('cwrSchedBestOf'), num(saved.bestOf, DEFAULT_SCHEDULE.bestOf)),
      defaultMap: v('cwrSchedMap') || saved.defaultMap || DEFAULT_SCHEDULE.defaultMap,
      seedMode: v('cwrSeedMode') || saved.seedMode || DEFAULT_SCHEDULE.seedMode
    };
  }

  function fillScheduleForm() {
    var t = state.tournament || {};
    var cfg = t.scheduleConfig || {};
    var set = function (id, value) { var el = $(id); if (el) el.value = value; };
    set('cwrSchedStartAt', toLocalInputValue(num(cfg.startAt) || num(t.schedule)));
    set('cwrSchedMatchMin', num(cfg.matchMinutes, DEFAULT_SCHEDULE.matchMinutes));
    set('cwrSchedGapMin', num(cfg.gapMinutes, DEFAULT_SCHEDULE.gapMinutes));
    set('cwrSchedRoundGapMin', num(cfg.roundGapMinutes, DEFAULT_SCHEDULE.roundGapMinutes));
    set('cwrSchedSlots', num(cfg.serverSlots, DEFAULT_SCHEDULE.serverSlots));
    set('cwrSchedBestOf', num(cfg.bestOf, DEFAULT_SCHEDULE.bestOf));
    set('cwrSchedMap', cfg.defaultMap || DEFAULT_SCHEDULE.defaultMap);
    set('cwrSeedMode', cfg.seedMode || DEFAULT_SCHEDULE.seedMode);
  }

  /** Cuadro completo en memoria: huecos sembrados, byes resueltos y horarios repartidos. */
  function buildBracket(teamIds, cfg) {
    var n = teamIds.length;
    if (n < 2) throw new Error('Necesitas al menos 2 equipos activos para generar el cuadro.');

    var rounds = Math.ceil(Math.log2(n));
    var bracketSize = Math.pow(2, rounds);
    var order = seedSlotOrder(bracketSize);
    var slotTeams = order.map(function (seed) {
      return seed <= n ? { teamId: teamIds[seed - 1], seed: seed } : null;
    });

    var matches = {};
    var round1 = [];
    var matchNum = 1;
    for (var i = 0; i < bracketSize; i += 2) {
      var mid = 'r1_m' + matchNum;
      matches[mid] = {
        id: mid,
        round: 1,
        teamA: slotTeams[i] || null,
        teamB: slotTeams[i + 1] || null,
        status: 'pending',
        winnerTeamId: null,
        nextMatchId: null,
        map: cfg.defaultMap,
        bestOf: cfg.bestOf
      };
      round1.push(mid);
      matchNum += 1;
    }

    var prevRound = round1;
    for (var r = 2; r <= rounds; r += 1) {
      var thisRound = [];
      for (var j = 0; j < prevRound.length; j += 2) {
        var nextId = 'r' + r + '_m' + (Math.floor(j / 2) + 1);
        matches[nextId] = {
          id: nextId,
          round: r,
          teamA: null,
          teamB: null,
          status: 'pending',
          winnerTeamId: null,
          nextMatchId: null,
          map: cfg.defaultMap,
          bestOf: cfg.bestOf
        };
        matches[prevRound[j]].nextMatchId = nextId;
        if (prevRound[j + 1]) matches[prevRound[j + 1]].nextMatchId = nextId;
        thisRound.push(nextId);
      }
      prevRound = thisRound;
    }

    resolveByes(matches, rounds);
    applySchedule(matches, rounds, cfg);

    var firstPlayable = orderedMatchIds(matches).filter(function (mid) {
      return matches[mid].status !== 'finished';
    })[0] || round1[0];

    return {
      format: 'SingleElim',
      rounds: rounds,
      matches: matches,
      currentMatchId: firstPlayable,
      teamCount: n,
      bracketSize: bracketSize,
      seedMode: cfg.seedMode,
      seededAt: Date.now(),
      seededBy: state.uid,
      seededByNick: state.nick
    };
  }

  /** Un equipo sin rival en su hueco pasa de ronda automáticamente. */
  function resolveByes(matches, rounds) {
    for (var r = 1; r <= rounds; r += 1) {
      /* eslint-disable no-loop-func */
      orderedMatchIds(matches).forEach(function (mid) {
        var m = matches[mid];
        if (m.round !== r || m.status === 'finished') return;
        var a = m.teamA && m.teamA.teamId;
        var b = m.teamB && m.teamB.teamId;
        if (a && b) { m.status = 'ready'; return; }
        if (!a && !b) { m.status = 'waiting'; return; }

        var winner = a || b;
        m.status = 'finished';
        m.winnerTeamId = winner;
        m.bye = true;
        m.finishedAt = Date.now();
        if (m.nextMatchId) {
          var next = matches[m.nextMatchId];
          var slot = next.teamA ? 'teamB' : 'teamA';
          next[slot] = { teamId: winner, fromMatchId: mid };
          next.status = (next.teamA && next.teamB) ? 'ready' : 'waiting';
        }
      });
      /* eslint-enable no-loop-func */
    }
  }

  /** Reparte horas: tantas partidas en paralelo como servidores haya, con descanso entre rondas. */
  function applySchedule(matches, rounds, cfg) {
    var cursor = num(cfg.startAt, Date.now());
    var matchMs = Math.max(5, num(cfg.matchMinutes, DEFAULT_SCHEDULE.matchMinutes)) * 60000;
    var gapMs = Math.max(0, num(cfg.gapMinutes, DEFAULT_SCHEDULE.gapMinutes)) * 60000;
    var roundGapMs = Math.max(0, num(cfg.roundGapMinutes, DEFAULT_SCHEDULE.roundGapMinutes)) * 60000;
    var slotsCount = Math.max(1, num(cfg.serverSlots, 1));
    var ordered = orderedMatchIds(matches);

    for (var r = 1; r <= rounds; r += 1) {
      var roundStart = cursor;
      var playable = ordered.filter(function (mid) {
        return matches[mid].round === r && !matches[mid].bye;
      });
      ordered.forEach(function (mid) {
        if (matches[mid].round === r && matches[mid].bye) {
          matches[mid].scheduledAt = roundStart;
          matches[mid].estimatedEndAt = roundStart;
        }
      });

      for (var i = 0; i < playable.length; i += slotsCount) {
        var wave = playable.slice(i, i + slotsCount);
        var waveStart = cursor;
        wave.forEach(function (mid) {
          matches[mid].scheduledAt = waveStart;
          matches[mid].estimatedEndAt = waveStart + matchMs;
        });
        cursor += matchMs;
        if (i + slotsCount < playable.length) cursor += gapMs;
      }
      if (r < rounds) cursor += roundGapMs;
    }
  }

  function generateBracket() {
    var t = state.tournament;
    if (!t) return;
    var cfg = readScheduleForm();
    var ranked = rankedTeamIds();

    if (ranked.length < 2) {
      setMsg('Necesitas 2 o más equipos activos. Los equipos pausados no entran en la siembra.', true);
      return;
    }
    if (t.bracket && t.bracket.matches) {
      var played = keys(t.bracket.matches).filter(function (mid) {
        return t.bracket.matches[mid].status === 'finished' && !t.bracket.matches[mid].bye;
      }).length;
      if (played && !window.confirm('Ya hay ' + played + ' partida(s) jugada(s). Regenerar el cuadro borra esos resultados. ¿Continuar?')) return;
    }

    if (cfg.seedMode === 'random') cfg.randomSeed = Date.now();

    var bracket;
    try {
      bracket = buildBracket(ranked, cfg);
    } catch (err) {
      setMsg(err.message, true);
      return;
    }

    cfg.generatedAt = Date.now();
    cfg.generatedBy = state.uid;
    cfg.generatedByNick = state.nick;

    var base = 'tournaments/' + state.tournamentId;
    var updates = {};
    updates[base + '/bracket'] = bracket;
    updates[base + '/scheduleConfig'] = cfg;
    updates[base + '/currentMatchId'] = bracket.currentMatchId;
    updates[base + '/schedule'] = cfg.startAt;
    updates[base + '/podium'] = null;
    updates[base + '/championTeamId'] = null;

    db.ref().update(updates).then(function () {
      state.scheduleDirty = false;
      var byes = keys(bracket.matches).filter(function (m) { return bracket.matches[m].bye; }).length;
      setMsg('Cuadro generado: ' + ranked.length + ' equipos, ' + bracket.rounds + ' rondas' +
        (byes ? ', ' + byes + ' pase(s) directo(s)' : '') + '. Horarios publicados en vivo.');
      toast('success', 'Cuadro y calendario publicados.');
      audit('bracket.generate', { teams: ranked.length, rounds: bracket.rounds, seedMode: cfg.seedMode });
    }).catch(writeError);
  }

  /** Recalcula solo las horas: conserva cruces y resultados ya jugados. */
  function rescheduleOnly() {
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches) {
      setMsg('Genera primero el cuadro.', true);
      return;
    }
    var cfg = readScheduleForm();
    var matches = JSON.parse(JSON.stringify(t.bracket.matches));
    applySchedule(matches, num(t.bracket.rounds, 1), cfg);

    var mBase = 'tournaments/' + state.tournamentId + '/bracket/matches/';
    var updates = {};
    keys(matches).forEach(function (mid) {
      updates[mBase + mid + '/scheduledAt'] = num(matches[mid].scheduledAt) || null;
      updates[mBase + mid + '/estimatedEndAt'] = num(matches[mid].estimatedEndAt) || null;
    });
    cfg.generatedAt = num(t.scheduleConfig && t.scheduleConfig.generatedAt, Date.now());
    updates['tournaments/' + state.tournamentId + '/scheduleConfig'] = cfg;
    updates['tournaments/' + state.tournamentId + '/schedule'] = cfg.startAt;

    db.ref().update(updates).then(function () {
      state.scheduleDirty = false;
      setMsg('Horarios recalculados y publicados.');
      toast('success', 'Calendario actualizado.');
      audit('bracket.reschedule', { startAt: cfg.startAt });
    }).catch(writeError);
  }

  function resetBracket() {
    if (!state.tournamentId) return;
    if (!window.confirm('¿Borrar el cuadro completo (cruces, resultados, campeón y podio)? La hora de inicio se conserva.')) return;
    var base = 'tournaments/' + state.tournamentId;
    var updates = {};
    updates[base + '/bracket'] = null;
    updates[base + '/currentMatchId'] = null;
    updates[base + '/championTeamId'] = null;
    updates[base + '/podium'] = null;
    db.ref().update(updates).then(function () {
      setMsg('Cuadro borrado. Puedes volver a sembrar.');
      audit('bracket.reset', {});
    }).catch(writeError);
  }

  function currentBracketMatch() {
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches) return null;
    var mid = t.activeMatchId || t.currentMatchId;
    return mid ? (t.bracket.matches[mid] || null) : null;
  }

  /**
   * Cierra un cruce y empuja al ganador a la siguiente ronda.
   * Réplica de advanceWinner() del backend, en una sola escritura atómica.
   */
  function advanceWinner(matchId, winnerTeamId, score) {
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches || !t.bracket.matches[matchId]) {
      setMsg('Esa partida no existe en el cuadro.', true);
      return Promise.resolve();
    }
    var m = t.bracket.matches[matchId];
    var a = m.teamA && m.teamA.teamId;
    var b = m.teamB && m.teamB.teamId;
    if (winnerTeamId !== a && winnerTeamId !== b) {
      setMsg('El ganador tiene que ser uno de los dos equipos del cruce.', true);
      return Promise.resolve();
    }
    var loser = (winnerTeamId === a) ? b : a;

    var base = 'tournaments/' + state.tournamentId;
    var mBase = base + '/bracket/matches/';
    var updates = {};
    updates[mBase + matchId + '/status'] = 'finished';
    updates[mBase + matchId + '/winnerTeamId'] = winnerTeamId;
    updates[mBase + matchId + '/loserTeamId'] = loser || null;
    updates[mBase + matchId + '/score'] = score || {};
    updates[mBase + matchId + '/finishedAt'] = Date.now();
    updates[mBase + matchId + '/closedByNick'] = state.nick;

    if (!m.nextMatchId) {
      updates[base + '/status'] = 'finalizado';
      updates[base + '/championTeamId'] = winnerTeamId;
      updates[base + '/finishedAt'] = Date.now();
      updates[base + '/podium/first'] = { teamId: winnerTeamId, teamName: teamName(winnerTeamId) };
      if (loser) updates[base + '/podium/second'] = { teamId: loser, teamName: teamName(loser) };
      var third = suggestThirdPlace(t.bracket, matchId, winnerTeamId, loser);
      if (third) updates[base + '/podium/third'] = { teamId: third, teamName: teamName(third), suggested: true };
    } else {
      var next = t.bracket.matches[m.nextMatchId];
      var slot = (!next.teamA || !next.teamA.teamId) ? 'teamA' : 'teamB';
      updates[mBase + m.nextMatchId + '/' + slot] = { teamId: winnerTeamId, fromMatchId: matchId };
      updates[mBase + m.nextMatchId + '/status'] = (next.teamA || next.teamB) ? 'ready' : 'waiting';
      updates[base + '/currentMatchId'] = m.nextMatchId;
      updates[base + '/bracket/currentMatchId'] = m.nextMatchId;
      updates[base + '/status'] = 'en_vivo';
    }

    return db.ref().update(updates).then(function () {
      if (!m.nextMatchId) {
        setMsg('¡' + teamName(winnerTeamId) + ' es campeón! Revisa el podio propuesto y registra los premios.');
        toast('success', 'Torneo cerrado. Campeón: ' + teamName(winnerTeamId));
      } else {
        setMsg(teamName(winnerTeamId) + ' pasa a ' + m.nextMatchId + '.');
        toast('success', teamName(winnerTeamId) + ' avanza de ronda.');
      }
      audit('match.close', { matchId: matchId, winnerTeamId: winnerTeamId, score: score || null });
    }).catch(writeError);
  }

  /** En eliminación directa el 3.º sale de semifinales: propone al perdedor con mejor recorrido. */
  function suggestThirdPlace(bracket, finalId, championId, runnerUpId) {
    var losers = [];
    keys(bracket.matches).forEach(function (mid) {
      var m = bracket.matches[mid];
      if (m.nextMatchId !== finalId) return;
      var loser = m.loserTeamId ||
        ((m.winnerTeamId && m.teamA && m.teamA.teamId === m.winnerTeamId)
          ? (m.teamB && m.teamB.teamId)
          : (m.teamA && m.teamA.teamId));
      if (loser && loser !== championId && loser !== runnerUpId) losers.push(loser);
    });
    if (!losers.length) return null;
    losers.sort(function (x, y) {
      return teamStrength(state.teams[y]).score - teamStrength(state.teams[x]).score;
    });
    return losers[0];
  }

  function reopenMatch(matchId) {
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches[matchId]) return;
    if (!window.confirm('¿Reabrir ' + matchId + '? Se borra su resultado y, si el ganador ya había pasado, se libera su hueco en la ronda siguiente.')) return;

    var m = t.bracket.matches[matchId];
    var base = 'tournaments/' + state.tournamentId;
    var mBase = base + '/bracket/matches/';
    var updates = {};
    updates[mBase + matchId + '/status'] = (m.teamA && m.teamB) ? 'ready' : 'waiting';
    updates[mBase + matchId + '/winnerTeamId'] = null;
    updates[mBase + matchId + '/loserTeamId'] = null;
    updates[mBase + matchId + '/score'] = null;
    updates[mBase + matchId + '/finishedAt'] = null;
    updates[mBase + matchId + '/bye'] = null;

    if (m.nextMatchId && m.winnerTeamId) {
      var next = t.bracket.matches[m.nextMatchId] || {};
      ['teamA', 'teamB'].forEach(function (slot) {
        if (next[slot] && next[slot].teamId === m.winnerTeamId) {
          updates[mBase + m.nextMatchId + '/' + slot] = null;
          updates[mBase + m.nextMatchId + '/status'] = 'waiting';
        }
      });
    } else if (!m.nextMatchId) {
      updates[base + '/status'] = 'en_vivo';
      updates[base + '/championTeamId'] = null;
      updates[base + '/podium'] = null;
    }
    updates[base + '/currentMatchId'] = matchId;

    db.ref().update(updates).then(function () {
      setMsg(matchId + ' reabierta.');
      audit('match.reopen', { matchId: matchId });
    }).catch(writeError);
  }

  function setMatchAsCurrent(matchId) {
    if (!state.tournamentId) return;
    var updates = {};
    updates['tournaments/' + state.tournamentId + '/currentMatchId'] = matchId;
    updates['tournaments/' + state.tournamentId + '/bracket/currentMatchId'] = matchId;
    db.ref().update(updates).then(function () {
      setMsg(matchId + ' marcada como partida en curso. Ya puedes lanzarla en el servidor.');
      audit('match.setCurrent', { matchId: matchId });
    }).catch(writeError);
  }

  function editMatchTime(matchId) {
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches[matchId]) return;
    var m = t.bracket.matches[matchId];
    var value = window.prompt('Nueva hora para ' + matchId + ' (AAAA-MM-DD HH:MM):',
      m.scheduledAt ? toLocalInputValue(m.scheduledAt).replace('T', ' ') : '');
    if (value === null) return;
    var ms = fromLocalInputValue(String(value).trim().replace(' ', 'T'));
    if (!ms) {
      toast('error', 'Fecha no válida.');
      return;
    }
    var cfg = t.scheduleConfig || {};
    db.ref('tournaments/' + state.tournamentId + '/bracket/matches/' + matchId).update({
      scheduledAt: ms,
      estimatedEndAt: ms + Math.max(5, num(cfg.matchMinutes, DEFAULT_SCHEDULE.matchMinutes)) * 60000
    }).then(function () {
      setMsg(matchId + ' reprogramada para ' + fmtDateTime(ms) + '.');
      audit('match.retime', { matchId: matchId, scheduledAt: ms });
    }).catch(writeError);
  }

  function editMatchMap(matchId) {
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches[matchId]) return;
    var m = t.bracket.matches[matchId];
    var value = window.prompt('Mapa para ' + matchId + ':', m.map || DEFAULT_SCHEDULE.defaultMap);
    if (value === null) return;
    db.ref('tournaments/' + state.tournamentId + '/bracket/matches/' + matchId + '/map')
      .set(String(value).trim() || DEFAULT_SCHEDULE.defaultMap)
      .then(function () { audit('match.map', { matchId: matchId, map: value }); })
      .catch(writeError);
  }

  /** Pide el ganador mostrando el marcador en vivo como referencia. */
  function promptCloseMatch(matchId) {
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches[matchId]) return;
    var m = t.bracket.matches[matchId];
    var a = m.teamA && m.teamA.teamId;
    var b = m.teamB && m.teamB.teamId;
    if (!a || !b) {
      toast('error', 'Ese cruce todavía no tiene los dos equipos.');
      return;
    }
    var live = (state.liveMatchId === matchId) ? state.live : null;
    var hint = (live && live.scoreCT != null)
      ? '\n\nMarcador en vivo: CT ' + live.scoreCT + ' — T ' + live.scoreT +
        '\nEn MatchZy team1 = ' + teamName(a) + ', pero tras el cuchillo los bandos pueden cambiar.'
      : '';
    var choice = window.prompt('¿Quién ganó ' + matchId + '?' + hint +
      '\n\n1) ' + teamName(a) + '\n2) ' + teamName(b) + '\n\nEscribe 1 o 2:');
    if (choice === null) return;
    var pick = String(choice).trim();
    var winner = pick === '1' ? a : (pick === '2' ? b : null);
    if (!winner) {
      toast('error', 'Escribe 1 o 2.');
      return;
    }
    var scoreText = window.prompt('Marcador final ' + teamName(a) + ' - ' + teamName(b) + ' (ej. 13-9). Opcional:', '');
    var score = {};
    if (scoreText) {
      var parts = String(scoreText).split(/[^0-9]+/).filter(Boolean);
      if (parts.length >= 2) {
        score.a = num(parts[0]);
        score.b = num(parts[1]);
      }
    }
    if (live) {
      if (live.scoreCT != null) score.scoreCT = live.scoreCT;
      if (live.scoreT != null) score.scoreT = live.scoreT;
    }
    advanceWinner(matchId, winner, score);
  }

  /** Piloto automático: si el servidor reporta ganador, el cuadro avanza sin intervención. */
  function maybeAutopilot() {
    if (!isCommander() || !state.autopilot) return;
    var live = state.live;
    var t = state.tournament;
    if (!live || !live.winnerTeamId || !t || !t.bracket || !t.bracket.matches) return;
    var mid = state.liveMatchId;
    var m = t.bracket.matches[mid];
    if (!m || m.status === 'finished') return;
    var a = m.teamA && m.teamA.teamId;
    var b = m.teamB && m.teamB.teamId;
    if (live.winnerTeamId !== a && live.winnerTeamId !== b) return;

    advanceWinner(mid, live.winnerTeamId, { scoreCT: live.scoreCT, scoreT: live.scoreT, auto: true });
    toast('success', 'Piloto automático: ' + teamName(live.winnerTeamId) + ' avanza de ronda.');
  }

  // --- Render del calendario, cuadro y podio --------------------------------

  function seedModeLabel(mode) {
    switch (mode) {
      case 'random': return 'Aleatoria';
      case 'manual': return 'Manual';
      default: return 'Por fuerza (ranking)';
    }
  }

  function roundLabel(round, totalRounds) {
    var fromEnd = num(totalRounds) - num(round);
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinal';
    if (fromEnd === 2) return 'Cuartos';
    if (fromEnd === 3) return 'Octavos';
    return 'Ronda ' + round;
  }

  function matchStatusChip(m, t) {
    var current = (t.activeMatchId || t.currentMatchId) === m.id;
    if (m.bye) return '<span class="cwr-chip cwr-chip-muted">Pase directo</span>';
    if (m.status === 'finished') {
      var sc = (m.score && m.score.a != null) ? ' ' + m.score.a + '-' + m.score.b : '';
      return '<span class="cwr-chip cwr-chip-ok"><i class="fas fa-check"></i> ' +
        esc(teamName(m.winnerTeamId)) + esc(sc) + '</span>';
    }
    if (current && state.live && state.live.status === 'live') {
      return '<span class="cwr-chip cwr-chip-live"><i class="fas fa-circle"></i> EN VIVO</span>';
    }
    if (current) return '<span class="cwr-chip cwr-chip-warn">En curso</span>';
    if (m.status === 'ready') return '<span class="cwr-chip cwr-chip-info">Listo</span>';
    return '<span class="cwr-chip cwr-chip-muted">Esperando equipos</span>';
  }

  function renderSchedule() {
    var box = $('cwrScheduleTimeline');
    if (!box) return;
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches) {
      box.innerHTML = '<p class="cwr-empty">Todavía no hay calendario. ' +
        (isCommander()
          ? 'Ajusta los parámetros de arriba y pulsa <b>Generar cuadro inteligente</b>.'
          : 'El Commander aún no ha sembrado el cuadro.') + '</p>';
      return;
    }

    var cfg = t.scheduleConfig || {};
    var matches = t.bracket.matches;
    var ids = orderedMatchIds(matches).filter(function (mid) { return !matches[mid].bye; });
    var startAt = num(cfg.startAt) || num(t.schedule);
    var lastEnd = ids.reduce(function (acc, mid) {
      return Math.max(acc, num(matches[mid].estimatedEndAt));
    }, 0);

    var head = '<div class="cwr-info-grid cwr-info-grid-tight">' +
      infoCell('Arranque del torneo', startAt ? fmtDateTime(startAt) : 'Sin fecha') +
      infoCell('Fin estimado', lastEnd ? fmtDateTime(lastEnd) : '—') +
      infoCell('Duración estimada', (startAt && lastEnd) ? fmtDuration((lastEnd - startAt) / 1000) : '—') +
      infoCell('Partidas programadas', ids.length) +
      infoCell('Rondas', t.bracket.rounds || '—') +
      infoCell('Siembra usada', seedModeLabel(t.bracket.seedMode || cfg.seedMode)) +
      infoCell('Servidores en paralelo', num(cfg.serverSlots, 1)) +
      infoCell('Formato', 'Bo' + num(cfg.bestOf, 1) + ' · eliminación directa') +
    '</div>';

    var rows = ids.map(function (mid) {
      var m = matches[mid];
      var tone = m.status === 'finished' ? 'muted'
        : (mid === (t.activeMatchId || t.currentMatchId) ? 'live' : 'info');
      var when = num(m.scheduledAt);
      var aWin = m.winnerTeamId && m.winnerTeamId === (m.teamA && m.teamA.teamId);
      var bWin = m.winnerTeamId && m.winnerTeamId === (m.teamB && m.teamB.teamId);
      return '<div class="cwr-sched-row cwr-sched-row-' + tone + '">' +
        '<div class="cwr-sched-time">' +
          '<b>' + esc(when ? fmtTime(when) : '—') + '</b>' +
          '<span>' + esc(when ? fmtDateTime(when).split(',')[0] : '') + '</span>' +
        '</div>' +
        '<div class="cwr-sched-round">' + esc(roundLabel(m.round, t.bracket.rounds)) + '</div>' +
        '<div class="cwr-sched-teams">' +
          '<span' + (aWin ? ' class="cwr-winner"' : '') + '>' + esc(teamName(m.teamA && m.teamA.teamId)) + '</span>' +
          '<i>vs</i>' +
          '<span' + (bWin ? ' class="cwr-winner"' : '') + '>' + esc(teamName(m.teamB && m.teamB.teamId)) + '</span>' +
        '</div>' +
        '<div class="cwr-sched-status">' + matchStatusChip(m, t) + '</div>' +
        '<div class="cwr-sched-count">' +
          ((m.status === 'finished' || !when) ? '' :
            '<span data-cwr-countdown="' + when + '">' + esc(fmtCountdown(when)) + '</span>') +
        '</div>' +
      '</div>';
    }).join('');

    box.innerHTML = head + '<div class="cwr-sched-list">' + rows + '</div>';
  }

  function renderBracket() {
    var box = $('cwrBracketCanvas');
    if (!box) return;
    var t = state.tournament;
    if (!t || !t.bracket || !t.bracket.matches) {
      box.innerHTML = '<p class="cwr-empty">Sin cuadro generado.</p>';
      return;
    }
    var matches = t.bracket.matches;
    var rounds = num(t.bracket.rounds, 1);
    var ordered = orderedMatchIds(matches);
    var cols = [];

    for (var r = 1; r <= rounds; r += 1) {
      /* eslint-disable no-loop-func */
      var ids = ordered.filter(function (mid) { return matches[mid].round === r; });
      /* eslint-enable no-loop-func */
      cols.push(
        '<div class="cwr-bracket-col">' +
          '<div class="cwr-bracket-col-title">' + esc(roundLabel(r, rounds)) + '</div>' +
          ids.map(function (mid) { return bracketCard(matches[mid], t); }).join('') +
        '</div>'
      );
    }

    var champId = t.championTeamId;
    cols.push(
      '<div class="cwr-bracket-col cwr-bracket-col-champ">' +
        '<div class="cwr-bracket-col-title">Campeón</div>' +
        '<div class="cwr-champ-card' + (champId ? ' cwr-champ-card-set' : '') + '">' +
          '<i class="fas fa-crown"></i>' +
          '<div class="cwr-champ-name">' + esc(champId ? teamName(champId) : 'Por decidir') + '</div>' +
        '</div>' +
      '</div>'
    );

    box.innerHTML = '<div class="cwr-bracket">' + cols.join('') + '</div>';
  }

  function bracketCard(m, t) {
    var current = (t.activeMatchId || t.currentMatchId) === m.id;
    var cls = 'cwr-match';
    if (current) cls += ' cwr-match-current';
    if (m.status === 'finished') cls += ' cwr-match-done';
    if (m.bye) cls += ' cwr-match-bye';

    function side(slot) {
      var teamId = m[slot] && m[slot].teamId;
      var win = m.winnerTeamId && m.winnerTeamId === teamId;
      var seed = m[slot] && m[slot].seed;
      var emblem = teamEmblem(teamId);
      var scoreVal = m.score ? (slot === 'teamA' ? m.score.a : m.score.b) : null;
      return '<div class="cwr-match-side' + (win ? ' cwr-match-side-win' : '') + '">' +
        '<span class="cwr-match-seed">' + esc(seed || '·') + '</span>' +
        (emblem ? '<img src="' + esc(emblem) + '" alt="" class="cwr-match-emblem" loading="lazy">' : '') +
        '<span class="cwr-match-team">' + esc(teamId ? teamName(teamId) : 'TBD') + '</span>' +
        '<span class="cwr-match-score">' + esc(scoreVal != null ? scoreVal : '') + '</span>' +
      '</div>';
    }

    var actions = '';
    if (isCommander() && !m.bye) {
      actions = '<div class="cwr-match-actions">' +
        (m.status === 'finished'
          ? '<button type="button" class="cwr-mini-btn" data-cwr-reopen="' + esc(m.id) + '" title="Reabrir"><i class="fas fa-undo"></i></button>'
          : '<button type="button" class="cwr-mini-btn" data-cwr-close="' + esc(m.id) + '"><i class="fas fa-flag-checkered"></i> Ganador</button>') +
        ((!current && m.status !== 'finished')
          ? '<button type="button" class="cwr-mini-btn" data-cwr-setcurrent="' + esc(m.id) + '" title="Marcar en curso"><i class="fas fa-crosshairs"></i></button>'
          : '') +
        '<button type="button" class="cwr-mini-btn" data-cwr-retime="' + esc(m.id) + '" title="Cambiar hora"><i class="fas fa-clock"></i></button>' +
        '<button type="button" class="cwr-mini-btn" data-cwr-map="' + esc(m.id) + '" title="Cambiar mapa"><i class="fas fa-map"></i></button>' +
      '</div>';
    }

    return '<div class="' + cls + '">' +
      '<div class="cwr-match-head">' +
        '<span>' + esc(m.id) + '</span>' +
        '<span>' + esc(m.map || '—') + '</span>' +
        '<span>' + esc(m.scheduledAt ? fmtTime(m.scheduledAt) : '—') + '</span>' +
      '</div>' +
      side('teamA') +
      side('teamB') +
      (m.bye ? '<div class="cwr-match-note">Pase directo</div>' : '') +
      actions +
    '</div>';
  }

  var PODIUM_PLACES = [
    { key: 'first', label: '1.er puesto', icon: 'fa-trophy', tone: 'gold' },
    { key: 'second', label: '2.º puesto', icon: 'fa-medal', tone: 'silver' },
    { key: 'third', label: '3.er puesto', icon: 'fa-award', tone: 'bronze' }
  ];

  function renderPodium() {
    var box = $('cwrPodiumBox');
    if (!box) return;
    var t = state.tournament;
    if (!t) { box.innerHTML = ''; return; }
    var podium = t.podium || {};

    box.innerHTML = PODIUM_PLACES.map(function (p) {
      var entry = podium[p.key] || {};
      var name = entry.teamId ? teamName(entry.teamId) : (entry.teamName || 'Por decidir');
      var prize = prizeForPlace(p.key);
      return '<div class="cwr-podium-card cwr-podium-' + p.tone + '">' +
        '<i class="fas ' + p.icon + '"></i>' +
        '<div class="cwr-podium-label">' + esc(p.label) + '</div>' +
        '<div class="cwr-podium-team">' + esc(name) + '</div>' +
        '<div class="cwr-podium-prize">' + esc(fmtTokens(prize.tokens)) + ' tokens' +
          (prize.cash ? ' · ' + esc(prize.cash + ' ' + prize.currency) : '') + '</div>' +
        (entry.suggested ? '<div class="cwr-podium-note">propuesto — confirma</div>' : '') +
        (isCommander()
          ? '<div class="cwr-podium-actions">' +
            '<button type="button" class="cwr-mini-btn" data-cwr-podium="' + p.key + '"><i class="fas fa-pen"></i> Asignar</button>' +
            '<button type="button" class="cwr-mini-btn" data-cwr-payout="' + p.key + '"><i class="fas fa-hand-holding-usd"></i> Entregar</button>' +
            '</div>'
          : '') +
      '</div>';
    }).join('');
  }

  function setPodiumPlace(place) {
    var t = state.tournament;
    if (!t) return;
    var ids = keys(t.registeredTeams);
    if (!ids.length) {
      toast('error', 'No hay equipos inscritos.');
      return;
    }
    var listText = ids.map(function (id, i) { return (i + 1) + ') ' + teamName(id); }).join('\n');
    var choice = window.prompt('Equipo para ese puesto:\n\n' + listText + '\n\nEscribe el número (0 para vaciar):');
    if (choice === null) return;
    var idx = parseInt(choice, 10);
    var ref = db.ref('tournaments/' + state.tournamentId + '/podium/' + place);
    if (idx === 0) {
      ref.remove().then(function () { audit('podium.clear', { place: place }); }).catch(writeError);
      return;
    }
    var teamId = ids[idx - 1];
    if (!teamId) {
      toast('error', 'Número fuera de rango.');
      return;
    }
    ref.set({ teamId: teamId, teamName: teamName(teamId), confirmedByNick: state.nick, at: Date.now() })
      .then(function () {
        toast('success', 'Podio actualizado.');
        audit('podium.set', { place: place, teamId: teamId });
      }).catch(writeError);
  }

  // ---------------------------------------------------------------------------
  // Premios: pozo, reparto y entregas (publicado en vivo para todos)
  // ---------------------------------------------------------------------------

  function prizeForPlace(place) {
    var t = state.tournament || {};
    var p = t.prizes || {};
    var entry = (p.places && p.places[place]) || {};
    return {
      tokens: num(entry.tokens),
      cash: num(entry.cash),
      currency: p.cashCurrency || 'USD'
    };
  }

  function fillPrizeForm() {
    var t = state.tournament || {};
    var p = t.prizes || {};
    var places = p.places || {};
    var set = function (id, value) { var el = $(id); if (el) el.value = value; };
    set('cwrPrizeTokenPool', num(p.tokenPool, num(t.prizePool)));
    set('cwrPrizeCashPool', num(p.cashPool));
    set('cwrPrizeCashCurrency', p.cashCurrency || 'USD');
    set('cwrPrizeEntryFee', num(p.entryFee, num(t.entryFee)));
    set('cwrPrizeHouseCut', num(p.houseCutPct));
    set('cwrPrize1Tokens', num(places.first && places.first.tokens));
    set('cwrPrize1Cash', num(places.first && places.first.cash));
    set('cwrPrize2Tokens', num(places.second && places.second.tokens));
    set('cwrPrize2Cash', num(places.second && places.second.cash));
    set('cwrPrize3Tokens', num(places.third && places.third.tokens));
    set('cwrPrize3Cash', num(places.third && places.third.cash));
    set('cwrPrizeMvpTokens', num(p.mvpTokens));
    set('cwrPrizeNotes', p.notes || '');
  }

  function readPrizeForm() {
    var v = function (id) { var el = $(id); return el ? el.value : ''; };
    return {
      tokenPool: num(v('cwrPrizeTokenPool')),
      cashPool: num(v('cwrPrizeCashPool')),
      cashCurrency: String(v('cwrPrizeCashCurrency') || 'USD').toUpperCase().slice(0, 6),
      entryFee: num(v('cwrPrizeEntryFee')),
      houseCutPct: Math.min(100, Math.max(0, num(v('cwrPrizeHouseCut')))),
      places: {
        first: { tokens: num(v('cwrPrize1Tokens')), cash: num(v('cwrPrize1Cash')) },
        second: { tokens: num(v('cwrPrize2Tokens')), cash: num(v('cwrPrize2Cash')) },
        third: { tokens: num(v('cwrPrize3Tokens')), cash: num(v('cwrPrize3Cash')) }
      },
      mvpTokens: num(v('cwrPrizeMvpTokens')),
      notes: String(v('cwrPrizeNotes') || '').slice(0, 400)
    };
  }

  /** Reparto estándar de la casa sobre el neto: 50 / 30 / 20. */
  function autoSplitPrizes() {
    var form = readPrizeForm();
    var factor = 1 - form.houseCutPct / 100;
    var netTokens = form.tokenPool * factor;
    var netCash = form.cashPool * factor;
    var set = function (id, value) { var el = $(id); if (el) el.value = value; };
    set('cwrPrize1Tokens', Math.round(netTokens * 0.50));
    set('cwrPrize2Tokens', Math.round(netTokens * 0.30));
    set('cwrPrize3Tokens', Math.round(netTokens * 0.20));
    set('cwrPrize1Cash', Math.round(netCash * 0.50 * 100) / 100);
    set('cwrPrize2Cash', Math.round(netCash * 0.30 * 100) / 100);
    set('cwrPrize3Cash', Math.round(netCash * 0.20 * 100) / 100);
    state.prizeDirty = true;
    renderPrizeSummary(readPrizeForm());
    setMsg('Reparto 50/30/20 propuesto sobre el neto. Revísalo y pulsa Publicar.');
  }

  function savePrizes() {
    if (!state.tournamentId) return;
    var form = readPrizeForm();
    var t = state.tournament || {};
    var collected = form.entryFee * keys(t.registeredTeams).length;

    var payload = {
      tokenPool: form.tokenPool,
      cashPool: form.cashPool,
      cashCurrency: form.cashCurrency,
      entryFee: form.entryFee,
      houseCutPct: form.houseCutPct,
      collectedTokens: collected,
      places: form.places,
      mvpTokens: form.mvpTokens,
      notes: form.notes,
      published: true,
      updatedAt: Date.now(),
      updatedBy: state.uid,
      updatedByNick: state.nick
    };

    var base = 'tournaments/' + state.tournamentId;
    var updates = {};
    updates[base + '/prizes'] = payload;
    // Se mantienen sincronizados los campos que ya leen Competition Hub y Tournament Details.
    updates[base + '/prizePool'] = form.tokenPool;
    updates[base + '/entryFee'] = form.entryFee;

    db.ref().update(updates).then(function () {
      state.prizeDirty = false;
      setMsg('Premios publicados. Todos los que estén viendo el torneo los ven al instante.');
      toast('success', 'Premios actualizados en vivo.');
      audit('prizes.publish', {
        tokenPool: form.tokenPool,
        cashPool: form.cashPool,
        first: form.places.first,
        second: form.places.second,
        third: form.places.third
      });
    }).catch(writeError);
  }

  /** Registra la entrega de un puesto. El abono de tokens se hace en la pestaña Tokens. */
  function registerPayout(place) {
    var t = state.tournament;
    if (!t) return;
    var entry = (t.podium && t.podium[place]) || {};
    if (!entry.teamId) {
      toast('error', 'Asigna primero el equipo de ese puesto en el podio.');
      return;
    }
    var prize = prizeForPlace(place);
    var existing = (t.prizePayouts && t.prizePayouts[place]) || null;
    if (existing && !window.confirm('Ese puesto ya está marcado como entregado (' + fmtDateTime(existing.paidAt) + '). ¿Sobrescribir?')) return;

    var label = PODIUM_PLACES.filter(function (p) { return p.key === place; })[0];
    if (!window.confirm('Registrar entrega del ' + (label ? label.label : place) + ' a "' + teamName(entry.teamId) + '":\n\n' +
      fmtTokens(prize.tokens) + ' tokens' + (prize.cash ? ' + ' + prize.cash + ' ' + prize.currency : '') +
      '\n\nEsto deja constancia pública. El abono de tokens a cada jugador se hace en la pestaña Tokens.')) return;

    db.ref('tournaments/' + state.tournamentId + '/prizePayouts/' + place).set({
      place: place,
      teamId: entry.teamId,
      teamName: teamName(entry.teamId),
      tokens: prize.tokens,
      cash: prize.cash,
      cashCurrency: prize.currency,
      paidAt: Date.now(),
      paidBy: state.uid,
      paidByNick: state.nick
    }).then(function () {
      toast('success', 'Entrega registrada.');
      audit('prizes.payout', { place: place, teamId: entry.teamId, tokens: prize.tokens, cash: prize.cash });
    }).catch(writeError);
  }

  function renderPrizes() {
    renderPrizeSummary(null);
    renderPayouts();
    renderPodium();
  }

  function renderPrizeSummary(formOverride) {
    var box = $('cwrPrizeSummary');
    if (!box) return;
    var t = state.tournament;
    if (!t) { box.innerHTML = ''; return; }

    var p = t.prizes || {};
    var form = formOverride || {
      tokenPool: num(p.tokenPool, num(t.prizePool)),
      cashPool: num(p.cashPool),
      cashCurrency: p.cashCurrency || 'USD',
      entryFee: num(p.entryFee, num(t.entryFee)),
      houseCutPct: num(p.houseCutPct),
      places: p.places || {},
      mvpTokens: num(p.mvpTokens)
    };

    var teamsCount = keys(t.registeredTeams).length;
    var collected = form.entryFee * teamsCount;
    var assignedTokens = ['first', 'second', 'third'].reduce(function (acc, k) {
      return acc + num(form.places[k] && form.places[k].tokens);
    }, 0) + num(form.mvpTokens);
    var assignedCash = ['first', 'second', 'third'].reduce(function (acc, k) {
      return acc + num(form.places[k] && form.places[k].cash);
    }, 0);
    var houseTokens = Math.round(form.tokenPool * form.houseCutPct / 100);
    var remaining = form.tokenPool - houseTokens - assignedTokens;

    var paid = t.prizePayouts || {};
    var deliveredTokens = keys(paid).reduce(function (acc, k) { return acc + num(paid[k].tokens); }, 0);
    var deliveredCash = keys(paid).reduce(function (acc, k) { return acc + num(paid[k].cash); }, 0);

    box.innerHTML = '<div class="cwr-info-grid cwr-info-grid-tight">' +
      infoCell('Pozo en tokens (se compite)', fmtTokens(form.tokenPool)) +
      infoCell('Dinero en juego', form.cashPool ? form.cashPool + ' ' + form.cashCurrency : '—') +
      infoCell('Inscripción por equipo', form.entryFee ? fmtTokens(form.entryFee) + ' tokens' : 'Gratis') +
      infoCell('Recaudado por inscripciones', fmtTokens(collected) + ' tokens (' + teamsCount + ' equipos)') +
      infoCell('Comisión de la casa', form.houseCutPct + '% · ' + fmtTokens(houseTokens) + ' tokens') +
      infoCell('Asignado a premios', fmtTokens(assignedTokens) + ' tokens' + (assignedCash ? ' + ' + assignedCash + ' ' + form.cashCurrency : '')) +
      infoCell('Sin asignar del pozo',
        (remaining === 0 ? 'Cuadra exacto' : (remaining > 0 ? 'Quedan ' + fmtTokens(remaining) : 'Excedido en ' + fmtTokens(-remaining))) + ' tokens') +
      infoCell('Ya entregado', fmtTokens(deliveredTokens) + ' tokens' + (deliveredCash ? ' + ' + deliveredCash + ' ' + form.cashCurrency : '')) +
      infoCell('Última actualización', p.updatedAt ? fmtDateTime(p.updatedAt) + ' · ' + (p.updatedByNick || '') : 'Sin publicar') +
    '</div>' +
    (remaining < 0
      ? '<p class="cwr-alert cwr-alert-warn"><i class="fas fa-exclamation-triangle"></i> Estás repartiendo más de lo que hay en el pozo.</p>'
      : '') +
    (p.notes ? '<p class="cwr-hint"><i class="fas fa-sticky-note"></i> ' + esc(p.notes) + '</p>' : '');
  }

  function renderPayouts() {
    var box = $('cwrPrizePayouts');
    if (!box) return;
    var t = state.tournament;
    var paid = (t && t.prizePayouts) || {};
    var ids = keys(paid);
    if (!ids.length) {
      box.innerHTML = '<p class="cwr-empty">Sin entregas registradas todavía.</p>';
      return;
    }
    box.innerHTML = ids.map(function (place) {
      var r = paid[place] || {};
      var label = PODIUM_PLACES.filter(function (p) { return p.key === place; })[0];
      return '<div class="cwr-payout-row">' +
        '<span class="cwr-chip cwr-chip-gold">' + esc(label ? label.label : place) + '</span>' +
        '<span class="cwr-payout-team">' + esc(r.teamName || teamName(r.teamId)) + '</span>' +
        '<span class="cwr-payout-amount">' + esc(fmtTokens(r.tokens)) + ' tokens' +
          (num(r.cash) ? ' + ' + esc(r.cash + ' ' + (r.cashCurrency || '')) : '') + '</span>' +
        '<span class="cwr-fleet-meta">' + esc(fmtDateTime(r.paidAt)) + ' · ' + esc(r.paidByNick || '') + '</span>' +
      '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Sentinelas: nombramiento, predeterminado y reportes de trampa
  // ---------------------------------------------------------------------------

  function renderSentinels() {
    var defaultBox = $('cwrSentinelDefault');
    var list = $('cwrSentinelList');
    var cfg = state.sentinelConfig || {};

    if (defaultBox) {
      var defUid = cfg.defaultUid;
      var defRec = defUid ? state.sentinels[defUid] : null;
      var online = defUid && activeSpectators().some(function (p) { return p.uid === defUid; });
      defaultBox.innerHTML = defUid
        ? '<div class="cwr-default-sentinel">' +
            '<i class="fas fa-user-shield"></i>' +
            '<div>' +
              '<div class="cwr-default-name">' + esc((defRec && defRec.nick) || cfg.defaultNick || defUid) + '</div>' +
              '<div class="cwr-default-sub">Sentinela predeterminado' +
                (cfg.updatedAt ? ' · asignado ' + esc(fmtAgo(cfg.updatedAt)) : '') + '</div>' +
            '</div>' +
            '<span class="cwr-chip cwr-chip-' + (online ? 'live' : 'muted') + '">' +
              (online ? 'Vigilando ahora' : 'Fuera de línea') + '</span>' +
          '</div>'
        : '<p class="cwr-empty">No hay sentinela predeterminado. Asigna uno para que vigile por defecto todos los torneos.</p>';
    }

    if (!list) return;
    var uids = keys(state.sentinels);
    if (!uids.length) {
      list.innerHTML = '<p class="cwr-empty">Sin sentinelas nombrados. Busca un usuario abajo y dale el permiso.</p>';
      return;
    }
    var watching = activeSpectators();

    list.innerHTML = uids.map(function (uid) {
      var s = state.sentinels[uid] || {};
      var online = watching.some(function (p) { return p.uid === uid; });
      var isDefault = cfg.defaultUid === uid;
      var reportCount = keys(state.reports).filter(function (id) {
        return state.reports[id] && state.reports[id].byUid === uid;
      }).length;

      return '<div class="cwr-sentinel-row' + (s.active === false ? ' cwr-row-paused' : '') + '">' +
        (s.photoURL
          ? '<img class="cwr-avatar" src="' + esc(s.photoURL) + '" alt="" loading="lazy">'
          : '<span class="cwr-avatar cwr-avatar-fallback"><i class="fas fa-user-secret"></i></span>') +
        '<div class="cwr-sentinel-main">' +
          '<div class="cwr-sentinel-name">' + esc(s.nick || uid) +
            (isDefault ? ' <span class="cwr-chip cwr-chip-gold">Predeterminado</span>' : '') +
            (s.active === false ? ' <span class="cwr-chip cwr-chip-muted">Suspendido</span>' : '') +
          '</div>' +
          '<div class="cwr-sentinel-sub">' +
            esc(s.scope && s.scope !== 'all' ? 'Solo torneo ' + s.scope : 'Todos los torneos') +
            ' · ' + reportCount + ' reporte(s)' +
            (s.assignedByNick ? ' · nombrado por ' + esc(s.assignedByNick) : '') +
          '</div>' +
        '</div>' +
        '<span class="cwr-chip cwr-chip-' + (online ? 'live' : 'muted') + '">' +
          (online ? 'En línea' : 'Ausente') + '</span>' +
        (isCommander() ? '<div class="cwr-sentinel-actions">' +
          (isDefault ? '' : '<button type="button" class="cwr-mini-btn" data-cwr-sentinel-default="' + esc(uid) + '">' +
            '<i class="fas fa-star"></i> Predeterminado</button>') +
          '<button type="button" class="cwr-mini-btn" data-cwr-sentinel-toggle="' + esc(uid) + '">' +
            '<i class="fas fa-' + (s.active === false ? 'play' : 'pause') + '"></i> ' +
            (s.active === false ? 'Reactivar' : 'Suspender') + '</button>' +
          '<button type="button" class="cwr-mini-btn" data-cwr-sentinel-scope="' + esc(uid) + '">' +
            '<i class="fas fa-crosshairs"></i> Alcance</button>' +
          '<button type="button" class="cwr-mini-btn cwr-mini-btn-danger" data-cwr-sentinel-revoke="' + esc(uid) + '">' +
            '<i class="fas fa-user-slash"></i> Quitar</button>' +
        '</div>' : '') +
      '</div>';
    }).join('');
  }

  function searchUsersForSentinel(query) {
    var box = $('cwrSentinelSearchResults');
    if (!box) return;
    var q = String(query || '').trim().toLowerCase();
    if (q.length < 2) {
      box.innerHTML = '';
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.innerHTML = '<div class="cwr-search-item cwr-search-item-muted">Buscando…</div>';

    db.ref('users').orderByChild('nick_lowercase').startAt(q).endAt(q + '\uf8ff').limitToFirst(12).once('value')
      .then(function (snap) {
        var found = [];
        snap.forEach(function (child) {
          var d = child.val() || {};
          found.push({ uid: child.key, nick: d.nick || d.displayName || child.key, photoURL: d.photoURL || null, rango: d.rango || '' });
        });
        if (!found.length) {
          box.innerHTML = '<div class="cwr-search-item cwr-search-item-muted">Sin resultados para "' + esc(q) + '".</div>';
          return;
        }
        box.innerHTML = found.map(function (u) {
          var already = !!state.sentinels[u.uid];
          return '<div class="cwr-search-item" data-cwr-assign-uid="' + esc(u.uid) + '" data-cwr-assign-nick="' + esc(u.nick) + '"' +
            ' data-cwr-assign-photo="' + esc(u.photoURL || '') + '">' +
            '<span>' + esc(u.nick) + '</span>' +
            '<span class="cwr-search-meta">' + esc(u.rango || 'usuario') +
              (already ? ' · ya es sentinela' : '') + '</span>' +
          '</div>';
        }).join('');
      }).catch(function (err) {
        box.innerHTML = '<div class="cwr-search-item cwr-search-item-muted">Error al buscar: ' + esc(err.message) + '</div>';
      });
  }

  function assignSentinel(uid, nick, photoURL) {
    if (!uid) return;
    var scopeEl = $('cwrSentinelScopeSelect');
    var scope = (scopeEl && scopeEl.value === 'current' && state.tournamentId) ? state.tournamentId : 'all';
    if (!window.confirm('Nombrar sentinela a "' + nick + '"?\n\n' +
      'Podrá entrar al Commander Panel solo al Control Universal, en modo lectura, y reportar sospechas de trampa. ' +
      'Alcance: ' + (scope === 'all' ? 'todos los torneos' : 'este torneo') + '.')) return;

    db.ref(SENTINELS_PATH + '/' + uid).set({
      uid: uid,
      nick: nick,
      photoURL: photoURL || null,
      active: true,
      scope: scope,
      assignedAt: Date.now(),
      assignedBy: state.uid,
      assignedByNick: state.nick
    }).then(function () {
      toast('success', nick + ' ya es Sentinela.');
      audit('sentinel.assign', { uid: uid, nick: nick, scope: scope });
      var input = $('cwrSentinelSearchInput');
      var box = $('cwrSentinelSearchResults');
      if (input) input.value = '';
      if (box) { box.innerHTML = ''; box.style.display = 'none'; }
      if (!state.sentinelConfig || !state.sentinelConfig.defaultUid) setDefaultSentinel(uid, nick, true);
    }).catch(writeError);
  }

  function setDefaultSentinel(uid, nick, silent) {
    db.ref(SENTINEL_CONFIG_PATH).set({
      defaultUid: uid,
      defaultNick: nick || (state.sentinels[uid] && state.sentinels[uid].nick) || uid,
      updatedAt: Date.now(),
      updatedBy: state.uid,
      updatedByNick: state.nick
    }).then(function () {
      if (!silent) toast('success', (nick || 'Sentinela') + ' es ahora el predeterminado.');
      audit('sentinel.default', { uid: uid });
    }).catch(writeError);
  }

  function toggleSentinel(uid) {
    var s = state.sentinels[uid] || {};
    var next = s.active === false;
    db.ref(SENTINELS_PATH + '/' + uid + '/active').set(next).then(function () {
      toast('success', (s.nick || uid) + (next ? ' reactivado.' : ' suspendido.'));
      audit('sentinel.toggle', { uid: uid, active: next });
    }).catch(writeError);
  }

  function editSentinelScope(uid) {
    var s = state.sentinels[uid] || {};
    var current = s.scope === 'all' || !s.scope ? 'todos' : s.scope;
    var answer = window.prompt('Alcance del sentinela "' + (s.nick || uid) + '".\n\n' +
      'Escribe "todos" para todos los torneos, o el ID de un torneo concreto:', current);
    if (answer === null) return;
    var value = String(answer).trim();
    var scope = (!value || value.toLowerCase() === 'todos' || value.toLowerCase() === 'all') ? 'all' : value;
    db.ref(SENTINELS_PATH + '/' + uid + '/scope').set(scope).then(function () {
      toast('success', 'Alcance actualizado.');
      audit('sentinel.scope', { uid: uid, scope: scope });
    }).catch(writeError);
  }

  function revokeSentinel(uid) {
    var s = state.sentinels[uid] || {};
    if (!window.confirm('¿Quitar el permiso de sentinela a "' + (s.nick || uid) + '"? Perderá el acceso al panel.')) return;
    var updates = {};
    updates[SENTINELS_PATH + '/' + uid] = null;
    if (state.sentinelConfig && state.sentinelConfig.defaultUid === uid) {
      updates[SENTINEL_CONFIG_PATH + '/defaultUid'] = null;
      updates[SENTINEL_CONFIG_PATH + '/defaultNick'] = null;
    }
    db.ref().update(updates).then(function () {
      toast('success', 'Permiso retirado.');
      audit('sentinel.revoke', { uid: uid });
    }).catch(writeError);
  }

  // --- Reportes de trampa ----------------------------------------------------

  function submitReport() {
    if (!state.tournamentId) {
      toast('error', 'Selecciona el torneo que estás vigilando.');
      return;
    }
    var v = function (id) { var el = $(id); return el ? String(el.value || '').trim() : ''; };
    var notes = v('cwrReportNotes');
    if (notes.length < 10) {
      toast('error', 'Describe lo que viste con algo más de detalle (mínimo 10 caracteres).');
      return;
    }
    var teamId = v('cwrReportTeam');
    var payload = {
      tournamentId: state.tournamentId,
      tournamentName: (state.tournament && state.tournament.name) || null,
      matchId: state.liveMatchId || (state.tournament && state.tournament.currentMatchId) || null,
      teamId: teamId || null,
      teamName: teamId ? teamName(teamId) : null,
      suspectNick: v('cwrReportSuspect') || null,
      category: v('cwrReportCategory') || 'otro',
      severity: v('cwrReportSeverity') || 'media',
      notes: notes.slice(0, 1000),
      evidenceUrl: v('cwrReportEvidence') || null,
      createdAt: Date.now(),
      byUid: state.uid,
      byNick: state.nick,
      byRole: state.mode,
      status: 'open'
    };

    db.ref(SENTINEL_REPORTS_PATH).push(payload).then(function () {
      toast('success', 'Reporte enviado al Commander.');
      setMsg('Reporte registrado. El Commander lo verá en su bitácora al instante.');
      ['cwrReportSuspect', 'cwrReportNotes', 'cwrReportEvidence'].forEach(function (id) {
        var el = $(id);
        if (el) el.value = '';
      });
    }).catch(writeError);
  }

  function renderReports() {
    var box = $('cwrReportsList');
    if (!box) return;
    var ids = keys(state.reports).sort(function (a, b) {
      return num(state.reports[b].createdAt) - num(state.reports[a].createdAt);
    }).filter(function (id) {
      var r = state.reports[id] || {};
      if (state.reportFilter === 'open') return !r.status || r.status === 'open';
      if (state.reportFilter === 'mine') return r.byUid === state.uid;
      if (state.reportFilter === 'tournament') return r.tournamentId === state.tournamentId;
      return true;
    });

    if (!ids.length) {
      box.innerHTML = '<p class="cwr-empty">Sin reportes en este filtro. Buena señal.</p>';
      return;
    }

    box.innerHTML = ids.map(function (id) {
      var r = state.reports[id] || {};
      var sev = String(r.severity || 'media');
      var tone = sev === 'critica' ? 'error' : (sev === 'alta' ? 'warn' : 'info');
      var closed = r.status && r.status !== 'open';
      return '<div class="cwr-report' + (closed ? ' cwr-report-closed' : '') + '">' +
        '<div class="cwr-report-head">' +
          '<span class="cwr-chip cwr-chip-' + tone + '">' + esc(sev.toUpperCase()) + '</span>' +
          '<span class="cwr-chip cwr-chip-muted">' + esc(r.category || 'otro') + '</span>' +
          '<span class="cwr-report-meta">' + esc(r.byNick || 'sentinela') + ' · ' +
            esc(fmtDateTime(r.createdAt)) + '</span>' +
          (closed ? '<span class="cwr-chip cwr-chip-ok">' + esc(r.status) + '</span>' : '') +
        '</div>' +
        '<div class="cwr-report-body">' + esc(r.notes || '') + '</div>' +
        '<div class="cwr-report-foot">' +
          (r.suspectNick ? '<span><i class="fas fa-user"></i> ' + esc(r.suspectNick) + '</span>' : '') +
          (r.teamName ? '<span><i class="fas fa-shield-alt"></i> ' + esc(r.teamName) + '</span>' : '') +
          (r.tournamentName ? '<span><i class="fas fa-trophy"></i> ' + esc(r.tournamentName) + '</span>' : '') +
          (r.matchId ? '<span><i class="fas fa-gamepad"></i> ' + esc(r.matchId) + '</span>' : '') +
          (r.evidenceUrl ? '<a href="' + esc(r.evidenceUrl) + '" target="_blank" rel="noopener">' +
            '<i class="fas fa-link"></i> Prueba</a>' : '') +
          (r.resolutionNote ? '<span><i class="fas fa-gavel"></i> ' + esc(r.resolutionNote) + '</span>' : '') +
        '</div>' +
        (isCommander() && !closed
          ? '<div class="cwr-report-actions">' +
            '<button type="button" class="cwr-mini-btn" data-cwr-report-resolve="' + esc(id) + '">' +
              '<i class="fas fa-gavel"></i> Confirmado</button>' +
            '<button type="button" class="cwr-mini-btn" data-cwr-report-dismiss="' + esc(id) + '">' +
              '<i class="fas fa-times"></i> Descartar</button>' +
            (r.teamId ? '<button type="button" class="cwr-mini-btn cwr-mini-btn-danger" data-cwr-team-toggle="' + esc(r.teamId) + '">' +
              '<i class="fas fa-pause"></i> Pausar equipo</button>' : '') +
            '</div>'
          : '') +
      '</div>';
    }).join('');
  }

  function resolveReport(id, status) {
    var note = window.prompt(status === 'confirmed'
      ? 'Resolución (qué medida tomaste):'
      : 'Motivo para descartar el reporte:', '');
    if (note === null) return;
    db.ref(SENTINEL_REPORTS_PATH + '/' + id).update({
      status: status,
      resolutionNote: String(note).slice(0, 400),
      resolvedAt: Date.now(),
      resolvedBy: state.uid,
      resolvedByNick: state.nick
    }).then(function () {
      toast('success', 'Reporte cerrado.');
      audit('report.' + status, { reportId: id });
    }).catch(writeError);
  }

  // ---------------------------------------------------------------------------
  // Espectadores en vivo (presencia por torneo)
  // ---------------------------------------------------------------------------

  function registerPresence() {
    if (!db || !state.uid || !state.tournamentId) return;
    detachPresence();
    presenceRef = db.ref(PRESENCE_PATH + '/' + state.tournamentId + '/' + state.uid);
    var payload = {
      nick: state.nick,
      role: isCommander() ? 'commander' : 'sentinel',
      page: 'commander-panel',
      joinedAt: Date.now(),
      lastSeen: Date.now()
    };
    presenceRef.onDisconnect().remove();
    presenceRef.set(payload).catch(function (err) {
      console.warn('[warroom] presencia:', err && err.message);
    });

    if (beatTimer) clearInterval(beatTimer);
    beatTimer = setInterval(function () {
      if (!presenceRef) return;
      presenceRef.update({ lastSeen: Date.now() }).catch(function () { /* noop */ });
    }, PRESENCE_BEAT_MS);
  }

  function detachPresence() {
    if (beatTimer) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
    if (presenceRef) {
      try {
        presenceRef.onDisconnect().cancel();
        presenceRef.remove();
      } catch (err) { /* noop */ }
      presenceRef = null;
    }
  }

  var ROLE_LABELS = {
    commander: { label: 'Commander', icon: 'fa-user-shield', tone: 'gold' },
    sentinel: { label: 'Sentinela', icon: 'fa-user-secret', tone: 'ok' },
    player: { label: 'Jugador', icon: 'fa-gamepad', tone: 'info' },
    spectator: { label: 'Espectador', icon: 'fa-eye', tone: 'muted' }
  };

  function renderSpectators() {
    var countEl = $('cwrSpectatorCount');
    var list = $('cwrSpectatorList');
    var watching = activeSpectators();

    if (countEl) {
      var byRole = {};
      watching.forEach(function (p) {
        var r = p.role || 'spectator';
        byRole[r] = (byRole[r] || 0) + 1;
      });
      countEl.innerHTML = chip(watching.length + ' viendo ahora', watching.length ? 'live' : 'muted', 'fa-eye') +
        Object.keys(ROLE_LABELS).map(function (r) {
          var meta = ROLE_LABELS[r];
          return chip((byRole[r] || 0) + ' ' + meta.label.toLowerCase(), byRole[r] ? meta.tone : 'muted', meta.icon);
        }).join('');
    }

    if (!list) return;
    if (!watching.length) {
      list.innerHTML = '<p class="cwr-empty">Nadie viendo este torneo ahora mismo. ' +
        'La presencia se registra al abrir la página del torneo o este panel.</p>';
      return;
    }
    list.innerHTML = watching.map(function (p) {
      var meta = ROLE_LABELS[p.role] || ROLE_LABELS.spectator;
      return '<div class="cwr-spectator-row">' +
        (p.photoURL
          ? '<img class="cwr-avatar" src="' + esc(p.photoURL) + '" alt="" loading="lazy">'
          : '<span class="cwr-avatar cwr-avatar-fallback"><i class="fas ' + meta.icon + '"></i></span>') +
        '<span class="cwr-spectator-name">' + esc(p.nick || p.uid) + '</span>' +
        '<span class="cwr-chip cwr-chip-' + meta.tone + '"><i class="fas ' + meta.icon + '"></i> ' + esc(meta.label) + '</span>' +
        '<span class="cwr-fleet-meta">' + esc(p.page || '—') + '</span>' +
        '<span class="cwr-fleet-meta">desde ' + esc(fmtAgo(p.joinedAt)) + '</span>' +
      '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Aviso público del Commander y bitácora
  // ---------------------------------------------------------------------------

  function fillNoteForm() {
    var el = $('cwrNoteInput');
    if (!el) return;
    var t = state.tournament || {};
    if (document.activeElement !== el) el.value = (t.commanderNote && t.commanderNote.text) || '';
  }

  function saveNote() {
    if (!state.tournamentId) return;
    var el = $('cwrNoteInput');
    var text = el ? String(el.value || '').trim().slice(0, 300) : '';
    var ref = db.ref('tournaments/' + state.tournamentId + '/commanderNote');
    var op = text
      ? ref.set({ text: text, at: Date.now(), byNick: state.nick })
      : ref.remove();
    op.then(function () {
      toast('success', text ? 'Aviso publicado para todos los espectadores.' : 'Aviso retirado.');
      audit('note.publish', { text: text || null });
    }).catch(writeError);
  }

  function renderAudit() {
    var box = $('cwrAuditList');
    if (!box) return;
    var ids = keys(state.audit).sort(function (a, b) {
      return num(state.audit[b].at) - num(state.audit[a].at);
    });
    if (!ids.length) {
      box.innerHTML = '<p class="cwr-empty">Sin movimientos registrados.</p>';
      return;
    }
    box.innerHTML = ids.map(function (id) {
      var a = state.audit[id] || {};
      var detail = '';
      if (a.detail && typeof a.detail === 'object') {
        detail = Object.keys(a.detail).map(function (k) {
          var v = a.detail[k];
          if (v && typeof v === 'object') return k;
          return k + '=' + v;
        }).join(' · ');
      }
      return '<div class="cwr-audit-row">' +
        '<span class="cwr-audit-time">' + esc(fmtDateTime(a.at)) + '</span>' +
        '<span class="cwr-audit-action">' + esc(a.action || '') + '</span>' +
        '<span class="cwr-audit-actor">' + esc(a.actorNick || '') + '</span>' +
        '<span class="cwr-audit-detail">' + esc(detail) + '</span>' +
      '</div>';
    }).join('');
  }

  function renderReportTeamSelect() {
    var select = $('cwrReportTeam');
    if (!select) return;
    var t = state.tournament || {};
    var ids = keys(t.registeredTeams);
    var previous = select.value;
    select.innerHTML = '<option value="">— Equipo (opcional) —</option>';
    ids.forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = teamName(id);
      select.appendChild(opt);
    });
    if (previous && ids.indexOf(previous) !== -1) select.value = previous;
  }

  // ---------------------------------------------------------------------------
  // Acciones sobre el servidor de juego (usan TournamentSystem / cs2NexusApi)
  // ---------------------------------------------------------------------------

  function hasTournamentSystem() {
    if (typeof global.TournamentSystem === 'undefined') {
      setMsg('tournament-system.js no está cargado: no puedo hablar con el backend de servidores.', true);
      return false;
    }
    return true;
  }

  function provisionServer() {
    if (!state.tournamentId || !hasTournamentSystem()) return;
    var matchId = (state.tournament && (state.tournament.currentMatchId || 'r1_m1')) || 'r1_m1';
    setMsg('Creando servidor en la nube para ' + matchId + '…');
    global.TournamentSystem.provisionServer(state.tournamentId, matchId, 0).then(function (res) {
      setMsg('Servidor solicitado: ' + res.serverId + '. Sigue el progreso en la tubería de arranque.');
      toast('success', 'Servidor en creación.');
      audit('server.provision', { serverId: String(res.serverId), matchId: matchId });
    }).catch(function (err) {
      setMsg(err.message || String(err), true);
    });
  }

  function launchMatch() {
    if (!state.tournamentId || !hasTournamentSystem()) return;
    var t = state.tournament || {};
    var matchId = t.currentMatchId || 'r1_m1';
    var match = (t.bracket && t.bracket.matches && t.bracket.matches[matchId]) || null;
    var mapEl = $('cwrLaunchMap');
    var map = (mapEl && mapEl.value) || (match && match.map) || DEFAULT_SCHEDULE.defaultMap;

    var teamIds;
    if (match && match.teamA && match.teamA.teamId && match.teamB && match.teamB.teamId) {
      teamIds = [match.teamA.teamId, match.teamB.teamId];
    } else {
      teamIds = rankedTeamIds();
      if (teamIds.length < 2) {
        setMsg('Genera el cuadro o inscribe al menos 2 equipos antes de lanzar.', true);
        return;
      }
      teamIds = teamIds.slice(0, 2);
    }

    var serverId = state.serverId || t.activeServerId;
    if (!serverId) {
      setMsg('No hay servidor asignado. Crea uno primero.', true);
      return;
    }

    setMsg('Lanzando ' + matchId + ' (' + map + ') con ' + teamName(teamIds[0]) + ' vs ' + teamName(teamIds[1]) + '…');
    global.TournamentSystem.launchMatch(state.tournamentId, matchId, map, serverId, teamIds).then(function (res) {
      setMsg('Partida en marcha. Conexión: connect ' + res.serverIp + ':' + (res.port || 27015));
      toast('success', 'Partida lanzada.');
      audit('server.launch', { matchId: matchId, map: map, teamIds: teamIds.join(',') });
    }).catch(function (err) {
      setMsg(err.message || String(err), true);
    });
  }

  function checkServer() {
    if (!state.tournamentId || !hasTournamentSystem()) return;
    var serverId = state.serverId || (state.tournament && state.tournament.activeServerId);
    if (!serverId) {
      setMsg('No hay servidor que comprobar.', true);
      return;
    }
    if (typeof global.TournamentSystem.checkServer !== 'function') {
      setMsg('La comprobación manual no está disponible en esta versión del bridge.', true);
      return;
    }
    setMsg('Comprobando servidor ' + serverId + '…');
    global.TournamentSystem.checkServer(serverId, state.tournamentId).then(function () {
      setMsg('Comprobación lanzada. Los indicadores se actualizan solos.');
    }).catch(function (err) {
      setMsg(err.message || String(err), true);
    });
  }

  function shutdownServer(serverId) {
    if (!hasTournamentSystem()) return;
    var sid = serverId || state.serverId || (state.tournament && state.tournament.activeServerId);
    if (!sid) {
      setMsg('No hay servidor activo que apagar.', true);
      return;
    }
    if (!window.confirm('¿Apagar el servidor ' + sid + '? Se corta la facturación de esa VM y la partida en curso se pierde.')) return;
    var tid = (state.servers[sid] && state.servers[sid].tournamentId) || state.tournamentId || null;
    setMsg('Apagando servidor ' + sid + '…');
    global.TournamentSystem.shutdownServer(sid, tid).then(function () {
      setMsg('Servidor apagado. La facturación de esa VM se detiene.');
      toast('success', 'Servidor apagado.');
      audit('server.shutdown', { serverId: String(sid) });
    }).catch(function (err) {
      setMsg(err.message || String(err), true);
    });
  }

  // ---------------------------------------------------------------------------
  // Enlazado de controles
  // ---------------------------------------------------------------------------

  function on(id, event, handler) {
    var el = $(id);
    if (el) el.addEventListener(event, handler);
  }

  function markScheduleDirty() { state.scheduleDirty = true; }
  function markPrizeDirty() {
    state.prizeDirty = true;
    renderPrizeSummary(readPrizeForm());
  }

  function wireStaticControls() {
    on('cwrTournamentSelect', 'change', function (e) {
      selectTournament(e.target.value);
    });

    on('cwrRefreshBtn', 'click', function () {
      if (state.tournamentId) {
        var tid = state.tournamentId;
        state.tournamentId = null;
        selectTournament(tid);
      }
      refreshAll();
      setMsg('Datos recargados.');
    });

    on('cwrRawToggle', 'click', function () {
      state.rawOpen = !state.rawOpen;
      var btn = $('cwrRawToggle');
      if (btn) {
        btn.innerHTML = state.rawOpen
          ? '<i class="fas fa-eye-slash"></i> Ocultar JSON crudo'
          : '<i class="fas fa-code"></i> Ver JSON crudo del servidor';
      }
      renderRaw();
    });

    on('cwrAutopilotToggle', 'change', function (e) {
      state.autopilot = !!e.target.checked;
      setMsg(state.autopilot
        ? 'Piloto automático activo: los ganadores que reporte el servidor avanzan solos.'
        : 'Piloto automático apagado: tendrás que cerrar cada partida a mano.');
      if (state.autopilot) maybeAutopilot();
    });

    // Servidor
    on('cwrBtnProvision', 'click', provisionServer);
    on('cwrBtnLaunch', 'click', launchMatch);
    on('cwrBtnCheck', 'click', checkServer);
    on('cwrBtnShutdown', 'click', function () { shutdownServer(null); });

    // Calendario y cuadro
    on('cwrBtnGenerate', 'click', generateBracket);
    on('cwrBtnReschedule', 'click', rescheduleOnly);
    on('cwrBtnResetBracket', 'click', resetBracket);
    ['cwrSchedStartAt', 'cwrSchedMatchMin', 'cwrSchedGapMin', 'cwrSchedRoundGapMin',
      'cwrSchedSlots', 'cwrSchedBestOf', 'cwrSchedMap', 'cwrSeedMode'].forEach(function (id) {
      on(id, 'input', markScheduleDirty);
      on(id, 'change', markScheduleDirty);
    });

    // Premios
    on('cwrPrizeSaveBtn', 'click', savePrizes);
    on('cwrPrizeAutoSplitBtn', 'click', autoSplitPrizes);
    ['cwrPrizeTokenPool', 'cwrPrizeCashPool', 'cwrPrizeCashCurrency', 'cwrPrizeEntryFee',
      'cwrPrizeHouseCut', 'cwrPrize1Tokens', 'cwrPrize1Cash', 'cwrPrize2Tokens', 'cwrPrize2Cash',
      'cwrPrize3Tokens', 'cwrPrize3Cash', 'cwrPrizeMvpTokens', 'cwrPrizeNotes'].forEach(function (id) {
      on(id, 'input', markPrizeDirty);
    });

    // Aviso público
    on('cwrNoteSaveBtn', 'click', saveNote);

    // Sentinelas
    var searchTimer = null;
    on('cwrSentinelSearchInput', 'input', function (e) {
      var value = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { searchUsersForSentinel(value); }, 250);
    });

    // Reportes
    on('cwrReportSubmit', 'click', submitReport);
    on('cwrReportsFilter', 'change', function (e) {
      state.reportFilter = e.target.value;
      renderReports();
    });

    wireDelegatedClicks();
  }

  /** Un solo listener para todos los botones que se re-renderizan. */
  function wireDelegatedClicks() {
    var root = $('tab-warroom');
    if (!root || root.dataset.cwrBound === '1') return;
    root.dataset.cwrBound = '1';

    root.addEventListener('click', function (event) {
      var target = event.target.closest('[data-cwr-copy],[data-cwr-shutdown],[data-cwr-team-toggle],' +
        '[data-cwr-team-remove],[data-cwr-team-transfer],[data-cwr-close],[data-cwr-reopen],' +
        '[data-cwr-setcurrent],[data-cwr-retime],[data-cwr-map],[data-cwr-podium],[data-cwr-payout],' +
        '[data-cwr-sentinel-default],[data-cwr-sentinel-toggle],[data-cwr-sentinel-scope],' +
        '[data-cwr-sentinel-revoke],[data-cwr-assign-uid],[data-cwr-report-resolve],[data-cwr-report-dismiss]');
      if (!target || !root.contains(target)) return;

      var get = function (attr) { return target.getAttribute(attr); };

      if (get('data-cwr-copy')) { copyText(get('data-cwr-copy')); return; }
      if (get('data-cwr-assign-uid')) {
        assignSentinel(get('data-cwr-assign-uid'), get('data-cwr-assign-nick'), get('data-cwr-assign-photo'));
        return;
      }

      // El resto son acciones de mando: el Sentinela nunca las tiene renderizadas.
      if (!isCommander()) return;

      if (get('data-cwr-shutdown')) { shutdownServer(get('data-cwr-shutdown')); return; }
      if (get('data-cwr-team-toggle')) { toggleTeamPause(get('data-cwr-team-toggle')); return; }
      if (get('data-cwr-team-remove')) { removeTeam(get('data-cwr-team-remove')); return; }
      if (get('data-cwr-team-transfer')) { transferTeam(get('data-cwr-team-transfer')); return; }
      if (get('data-cwr-close')) { promptCloseMatch(get('data-cwr-close')); return; }
      if (get('data-cwr-reopen')) { reopenMatch(get('data-cwr-reopen')); return; }
      if (get('data-cwr-setcurrent')) { setMatchAsCurrent(get('data-cwr-setcurrent')); return; }
      if (get('data-cwr-retime')) { editMatchTime(get('data-cwr-retime')); return; }
      if (get('data-cwr-map')) { editMatchMap(get('data-cwr-map')); return; }
      if (get('data-cwr-podium')) { setPodiumPlace(get('data-cwr-podium')); return; }
      if (get('data-cwr-payout')) { registerPayout(get('data-cwr-payout')); return; }
      if (get('data-cwr-sentinel-default')) {
        var duid = get('data-cwr-sentinel-default');
        setDefaultSentinel(duid, (state.sentinels[duid] || {}).nick, false);
        return;
      }
      if (get('data-cwr-sentinel-toggle')) { toggleSentinel(get('data-cwr-sentinel-toggle')); return; }
      if (get('data-cwr-sentinel-scope')) { editSentinelScope(get('data-cwr-sentinel-scope')); return; }
      if (get('data-cwr-sentinel-revoke')) { revokeSentinel(get('data-cwr-sentinel-revoke')); return; }
      if (get('data-cwr-report-resolve')) { resolveReport(get('data-cwr-report-resolve'), 'confirmed'); return; }
      if (get('data-cwr-report-dismiss')) { resolveReport(get('data-cwr-report-dismiss'), 'dismissed'); }
    });
  }

  global.addEventListener('beforeunload', detachPresence);


  global.SGWarRoom = {
    init: init,
    onTabOpen: onTabOpen,
    lookupSentinel: lookupSentinel
  };
})(window);
