(function() {
  'use strict';

  // Firebase: sg-firebase-init.js (SEC-022)
  if (typeof sgInitFirebaseApp === 'function') {
    sgInitFirebaseApp();
  } else if (typeof firebase !== 'undefined' && window.SG_FIREBASE_CONFIG && !firebase.apps.length) {
    firebase.initializeApp(window.SG_FIREBASE_CONFIG);
  }

  var db = (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
  var storage = (typeof firebase !== 'undefined' && firebase.storage) ? firebase.storage() : null;
  var telemetryRealtimeAttached = false;
  var lastUsersSource = 'recent'; // 'recent' | 'search'
  var lastSearchQuery = '';
  var commanderUiAttached = false;
  // Identidad del commander logueado (para dejar constancia en auditoría/reparaciones).
  var currentCommanderUid = null;
  var currentCommanderNick = 'Commander';
  var currentCommanderRango = '';
  var onTokensTabOpen = null;
  var bossOfTheStateUid = null;

  var RANGO_BOSS = 'boss_of_the_state';

  function normalizeRango(r) {
    return String(r || '').toLowerCase().replace(/\s+/g, '_');
  }

  function isBossOfTheStateRango(rango) {
    return normalizeRango(rango) === RANGO_BOSS;
  }

  function canAccessCommanderPanel(rango) {
    var r = normalizeRango(rango);
    return r === 'commander' || r === 'divisional_commander' || isBossOfTheStateRango(r);
  }

  function waitForDbReady() {
    if (typeof sgWaitForDbReady === 'function') return sgWaitForDbReady();
    return Promise.resolve();
  }

  function syncNexusXpBossUi() {
    var boss = isBossOfTheStateRango(currentCommanderRango);
    var fields = document.getElementById('tokNexusXpBossFields');
    var grantBtn = document.getElementById('tokNexusXpGrantBtn');
    var intro = document.getElementById('tokNexusXpIntro');
    if (fields) fields.style.display = boss ? 'grid' : 'none';
    if (grantBtn) grantBtn.style.display = boss ? 'inline-flex' : 'none';
    if (intro) {
      intro.textContent = boss
        ? 'Otorga XP a un jugador (máx. 5 000 por entrega, 15 000/día) o boost x2 a otros.'
        : 'Puedes otorgar boost x2 a jugadores seleccionados. Dar XP Nexus solo Boss of the State.';
    }
  }

  // Toast local para cuando la página se usa sin dashboard (sin showFloatingMessage global)
  function showFloatingMessage(type, text) {
    if (typeof window.showFloatingMessage === 'function' && window.showFloatingMessage !== showFloatingMessage) {
      window.showFloatingMessage(type, text);
      return;
    }
    var msg = document.createElement('div');
    msg.className = 'commander-toast commander-toast-' + (type || 'info');
    msg.textContent = text;
    msg.setAttribute('role', 'alert');
    document.body.appendChild(msg);
    requestAnimationFrame(function() { msg.classList.add('commander-toast-visible'); });
    setTimeout(function() {
      msg.classList.remove('commander-toast-visible');
      setTimeout(function() { if (msg.parentNode) msg.parentNode.removeChild(msg); }, 300);
    }, 3500);
  }

  // -------------------------------------------------
  // UI: Tabs del Commander Control Center
  // -------------------------------------------------
  function initCommanderTabs() {
    var tabs = document.querySelectorAll('.commander-tab');
    var sections = document.querySelectorAll('.commander-panel-section');
    if (!tabs.length || !sections.length) return;

    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        var target = tab.getAttribute('data-tab');
        tabs.forEach(function(t) { t.classList.remove('active'); });
        sections.forEach(function(sec) {
          sec.style.display = (sec.id === 'tab-' + target) ? '' : 'none';
        });
        tab.classList.add('active');
        if (target === 'tokens' && typeof onTokensTabOpen === 'function') onTokensTabOpen();
        if (target === 'creators' && typeof onCreatorsTabOpen === 'function') onCreatorsTabOpen();
        if (target === 'tournaments' && window.SGTournamentOrganizer && SGTournamentOrganizer.ensureCommanderTournamentListLoaded) {
          SGTournamentOrganizer.ensureCommanderTournamentListLoaded();
        }
      });
    });
  }

  // -------------------------------------------------
  // Telemetría: canvas de carga de servidores (barras CPU/RAM)
  // -------------------------------------------------
  function drawServerLoadChart() {
    var canvas = document.getElementById('telemetryServerLoadChart');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var parent = canvas.parentElement;
    var w = (parent && parent.offsetWidth) || 200;
    canvas.width = w;
    canvas.height = 60;
    var h = 60;
    ctx.clearRect(0, 0, w, h);
    var cpu = 25 + Math.random() * 45;
    var ram = 30 + Math.random() * 50;
    var barH = 8;
    var gap = 6;
    var maxW = w - 40;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(8, 10, maxW, barH);
    ctx.fillRect(8, 10 + barH + gap, maxW, barH);
    ctx.fillStyle = 'rgba(229, 57, 53, 0.7)';
    ctx.fillRect(8, 10, (cpu / 100) * maxW, barH);
    ctx.fillStyle = 'rgba(255, 179, 71, 0.7)';
    ctx.fillRect(8, 10 + barH + gap, (ram / 100) * maxW, barH);
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px sans-serif';
    ctx.fillText('CPU ' + Math.round(cpu) + '%', 8, 8);
    ctx.fillText('RAM ' + Math.round(ram) + '%', 8, 10 + barH + gap + barH + 10);
  }

  // -------------------------------------------------
  // Telemetría: latencia (ping a Firebase)
  // -------------------------------------------------
  function measureFirebaseLatency(callback) {
    if (!db) { callback(null); return; }
    var start = Date.now();
    db.ref('.info/serverTimeOffset').once('value', function() {
      var ms = Math.round(Date.now() - start);
      callback(ms);
    }).catch(function() { callback(null); });
  }

  function updateLatencyDisplay() {
    var el = document.getElementById('telemetryAvgPing');
    if (!el) return;
    measureFirebaseLatency(function(ms) {
      if (ms !== null) el.textContent = ms + ' ms';
      else el.textContent = '— ms';
    });
  }

  // -------------------------------------------------
  // Telemetría: retención (N/A sin datos de sesiones; opcional: % registros última semana)
  // -------------------------------------------------
  function updateRetentionDisplay() {
    var el = document.getElementById('telemetryRetention');
    if (!el) return;
    if (!db) { el.textContent = 'N/A'; return; }
    db.ref('users').orderByChild('registro').limitToLast(200).once('value').then(function(snap) {
      if (!snap.exists() || snap.numChildren() < 1) {
        el.textContent = 'N/A';
        return;
      }
      var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      var total = 0;
      var withRecent = 0;
      snap.forEach(function(c) {
        total++;
        var r = c.val().registro;
        if (r) {
          var t = typeof r === 'number' ? r : new Date(r).getTime();
          if (!isNaN(t) && t >= weekAgo) withRecent++;
        }
      });
      var pct = total > 0 ? Math.round((withRecent / total) * 100) : 0;
      el.textContent = pct + ' %';
    }).catch(function() { el.textContent = 'N/A'; });
  }

  // -------------------------------------------------
  // UI: Placeholders + iniciar telemetría visual (canvas, latencia, retención, servidores)
  // -------------------------------------------------
  function initTelemetryPlaceholders() {
    var serversEl = document.getElementById('telemetryServers');
    var activityEl = document.getElementById('telemetryActivityFeed');
    var newUsersEl = document.getElementById('telemetryNewUsers');

    if (serversEl && !serversEl.children.length) {
      ['EU-1', 'NA-1', 'SA-1'].forEach(function(id) {
        var row = document.createElement('div');
        row.className = 'telemetry-server-row';
        row.setAttribute('data-srv', id);
        row.innerHTML =
          '<span class="srv-name">' + id + '</span>' +
          '<span class="srv-status srv-online">ONLINE</span>' +
          '<span class="srv-meta">0/24</span>';
        serversEl.appendChild(row);
      });
      var updated = document.createElement('div');
      updated.className = 'telemetry-feed-item';
      updated.id = 'telemetryServersUpdated';
      updated.style.fontSize = '0.75rem';
      updated.style.color = '#6e7681';
      updated.textContent = 'Actualizado hace 0 s';
      serversEl.appendChild(updated);
    }

    var canvas = document.getElementById('telemetryServerLoadChart');
    if (canvas) {
      drawServerLoadChart();
      setInterval(drawServerLoadChart, 4000);
    }
    updateLatencyDisplay();
    setInterval(updateLatencyDisplay, 30000);
    updateRetentionDisplay();
    setInterval(updateRetentionDisplay, 60000);

    if (serversEl && serversEl.querySelector('[data-srv]')) {
      setInterval(function() {
        var rows = serversEl.querySelectorAll('.telemetry-server-row[data-srv]');
        var t = Math.floor(Date.now() / 1000) % 60;
        rows.forEach(function(r, i) {
          var meta = r.querySelector('.srv-meta');
          if (meta) meta.textContent = ((t + i * 7) % 24) + '/24';
        });
      }, 5000);
    }
    var serversUpdatedEl = document.getElementById('telemetryServersUpdated');
    if (serversUpdatedEl) {
      var serversTick = 0;
      setInterval(function() {
        serversTick++;
        if (serversTick >= 60) serversTick = 0;
        serversUpdatedEl.textContent = 'Actualizado hace ' + serversTick + ' s';
      }, 1000);
    }

    if (activityEl && !activityEl.dataset.initialized) {
      activityEl.dataset.initialized = '1';
      activityEl.innerHTML = '';
      var line = document.createElement('div');
      line.className = 'telemetry-feed-item';
      line.textContent = 'Conectando al stream de actividad...';
      activityEl.appendChild(line);
    }

    if (newUsersEl && !newUsersEl.dataset.initialized) {
      newUsersEl.dataset.initialized = '1';
      newUsersEl.innerHTML = '';
      var line2 = document.createElement('div');
      line2.className = 'telemetry-feed-item';
      line2.textContent = 'Esperando nuevos registros...';
      newUsersEl.appendChild(line2);
    }
  }

  // -------------------------------------------------
  // Telemetría real: usuarios en línea, actividad global, monitor de registros
  // -------------------------------------------------
  function initTelemetryRealtime() {
    if (!db || telemetryRealtimeAttached) return;
    telemetryRealtimeAttached = true;

    var onlineEl = document.getElementById('telemetryOnlineUsers');
    var onlineSubEl = document.getElementById('telemetryOnlineUsersSub');
    var newUsersEl = document.getElementById('telemetryNewUsers');
    var activityEl = document.getElementById('telemetryActivityFeed');
    if (newUsersEl) newUsersEl.innerHTML = '';
    if (activityEl) activityEl.innerHTML = '';

    var dwellEl = document.getElementById('telemetryDwell');
    var loginsEl = document.getElementById('telemetryLoginsToday');
    var loginsSubEl = document.getElementById('telemetryLoginsTodaySub');
    var visitsEl = document.getElementById('telemetryVisitsToday');
    var visitsHomeSubEl = document.getElementById('telemetryVisitsHomeSub');

    function formatDuration(ms) {
      if (!ms || ms < 0) return '0s';
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + sec + 's';
      return sec + 's';
    }

    // 1) Usuarios en línea + permanencia media (a partir de presence/{uid}.since)
    var presenceSnapshot = {};
    function renderPresence() {
      var uids = Object.keys(presenceSnapshot);
      if (onlineEl) onlineEl.textContent = String(uids.length);
      if (dwellEl) {
        if (!uids.length) { dwellEl.textContent = '—'; return; }
        var now = Date.now();
        var sum = 0, n = 0;
        uids.forEach(function(uid) {
          var p = presenceSnapshot[uid] || {};
          var since = typeof p.since === 'number' ? p.since : null;
          if (since && now - since >= 0) { sum += (now - since); n++; }
        });
        dwellEl.textContent = n ? formatDuration(sum / n) : '—';
      }
    }
    db.ref('presence').on('value', function(snap) {
      presenceSnapshot = snap.exists() ? (snap.val() || {}) : {};
      renderPresence();
    });
    // Refresca la permanencia cada 15s aunque no cambie la presencia (el tiempo avanza).
    setInterval(renderPresence, 15000);

    // 1c) Iniciaron sesión / activos hoy = usuarios únicos en visits/daily/{hoy}
    var todayKey = (function() {
      var d = new Date();
      function p2(n) { return (n < 10 ? '0' : '') + n; }
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    })();
    db.ref('visits/daily/' + todayKey).on('value', function(snap) {
      if (!loginsEl) return;
      var unique = snap.exists() ? snap.numChildren() : 0;
      loginsEl.textContent = String(unique);
      if (loginsSubEl) {
        var totalVisits = 0;
        if (snap.exists()) snap.forEach(function(c) { var v = c.val() || {}; totalVisits += (v.count || 0); });
        loginsSubEl.textContent = totalVisits + ' entradas de usuarios hoy';
      }
    });

    // 1d) Visitas hoy a todas las páginas (incluye home) = suma de visits/pages/{hoy}
    db.ref('visits/pages/' + todayKey).on('value', function(snap) {
      if (!visitsEl) return;
      var total = 0, home = 0;
      if (snap.exists()) snap.forEach(function(c) {
        var n = c.val();
        if (typeof n === 'number') total += n;
        if (c.key === 'home') home = (typeof n === 'number') ? n : 0;
      });
      visitsEl.textContent = String(total);
      if (visitsHomeSubEl) visitsHomeSubEl.textContent = 'Home: ' + home + ' visitas';
    });

    // 1b) Total registrados (solo para el subtítulo; una lectura inicial y luego cada minuto)
    function updateRegisteredCount() {
      if (!onlineSubEl) return;
      db.ref('users').once('value').then(function(snap) {
        var total = snap.exists() ? snap.numChildren() : 0;
        onlineSubEl.textContent = total + ' registrados en total';
      }).catch(function() { onlineSubEl.textContent = ''; });
    }
    updateRegisteredCount();
    setInterval(updateRegisteredCount, 60000);

    // 2) Nuevos registros + actividad global (mismo stream: últimos registros y eventos)
    var feedItems = [];
    var activityItems = [];
    var MAX_ITEMS = 20;
    var usersByRegistro = db.ref('users').orderByChild('registro').limitToLast(50);
    usersByRegistro.on('child_added', function(child) {
      var val = child.val() || {};
      var uid = child.key;
      var nick = val.nick || val.displayName || '(sin nick)';
      var ts = val.registro || null;
      var item = { uid: uid, nick: nick, ts: ts };
      feedItems.push(item);
      if (feedItems.length > MAX_ITEMS) feedItems.shift();
      activityItems.push({ type: 'registro', text: nick + ' se registró', ts: ts });
      if (activityItems.length > MAX_ITEMS) activityItems.shift();

      function renderFeed(el, items, label) {
        if (!el) return;
        el.innerHTML = '';
        items.slice().reverse().forEach(function(entry) {
          var row = document.createElement('div');
          row.className = 'telemetry-feed-item';
          if (label === 'registro') {
            row.textContent = entry.nick + ' (' + entry.uid + ') se registró ' + formatRegistro(entry.ts);
          } else {
            row.textContent = entry.text + ' ' + formatRegistro(entry.ts);
          }
          el.appendChild(row);
        });
        if (items.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'telemetry-feed-item';
          empty.textContent = 'Esperando actividad...';
          el.appendChild(empty);
        }
      }
      renderFeed(newUsersEl, feedItems, 'registro');
      renderFeed(activityEl, activityItems, 'activity');
    });
  }

  // Convierte el campo 'registro' (timestamp o fecha) a texto legible.
  function formatRegistro(raw) {
    if (!raw) return 'hace un momento';
    var d;
    if (typeof raw === 'number') {
      d = new Date(raw);
    } else {
      var parsed = Date.parse(raw);
      d = isNaN(parsed) ? null : new Date(parsed);
    }
    if (!d || isNaN(d.getTime())) return 'hace un momento';

    var now = Date.now();
    var diffMs = now - d.getTime();
    var diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'hace unos segundos';
    if (diffSec < 3600) return 'hace ' + Math.floor(diffSec / 60) + ' min';
    if (diffSec < 86400) return 'hace ' + Math.floor(diffSec / 3600) + ' h';

    var day = String(d.getDate()).padStart(2, '0');
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var year = d.getFullYear();
    return 'el ' + day + '/' + month + '/' + year;
  }

  function showStatus(msg, type) {
    var el = document.getElementById('commanderAccessStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'error' ? '#ff6b6b' : (type === 'success' ? '#58f658' : '#ffb347');
  }

  function viewUserDashboard(uid) {
    if (!uid) return;
    window.location.href = '/dashboard?uid=' + encodeURIComponent(uid);
  }

  function selectUserInList(uid, label) {
    if (!db || !uid) return Promise.resolve();
    return db.ref('users/' + uid).once('value').then(function(snap) {
      if (!snap.exists()) {
        showFloatingMessage('error', 'Usuario no encontrado.');
        return;
      }
      var input = document.getElementById('userSearchInput');
      if (input && label) input.value = label;
      lastUsersSource = 'search';
      lastSearchQuery = label || uid;
      var map = {};
      map[uid] = snap.val();
      renderUsersList(map);
    }).catch(function(err) {
      console.error('selectUserInList', err);
      showFloatingMessage('error', 'No se pudo cargar el usuario.');
    });
  }

  function renderUserItem(uid, data) {
    var container = document.createElement('div');
    container.className = 'commander-user-row';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'space-between';
    container.style.padding = '10px 16px';
    container.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
    container.style.fontSize = '0.9rem';

    var left = document.createElement('div');
    left.className = 'commander-user-main';
    left.style.display = 'flex';
    left.style.flexDirection = 'column';
    left.style.gap = '2px';
    left.style.cursor = 'pointer';
    left.title = 'Ver perfil de este jugador';
    left.addEventListener('click', function() {
      viewUserDashboard(uid);
    });

    var nick = data && (data.nick || data.displayName || data.email) || '(sin nick)';
    var rango = (data && data.rango) || 'tribal_warrior';
    var blocked = !!(data && data.blocked);
    var shadowbanned = !!(data && data.shadowbanned);
    var internalTag = data && data.internalTag || '';
    var createdAt = data && data.registro || null;

    var title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = nick + ' ';

    var uidSpan = document.createElement('span');
    uidSpan.style.color = '#888';
    uidSpan.style.fontSize = '0.8rem';
    uidSpan.textContent = uid;

    var meta = document.createElement('div');
    meta.style.color = '#aaa';
    meta.style.fontSize = '0.8rem';
    var rangoNorm = normalizeRango(rango);
    var rangoLabel = isBossOfTheStateRango(rangoNorm) ? 'Boss of the State' :
                     rangoNorm === 'commander' ? 'Commander' :
                     rangoNorm === 'divisional_commander' ? 'Divisional Commander' :
                     rangoNorm === 'tribal_warrior' ? 'Tribal Warrior' : rango;
    var parts = ['Rango: ' + rangoLabel];
    if (createdAt) parts.push('Registro: ' + formatRegistro(createdAt));
    if (blocked) parts.push('BLOQUEADO');
    if (shadowbanned) parts.push('SHADOWBAN');
    if (internalTag) parts.push('Tag: ' + internalTag);
    meta.textContent = parts.join(' • ');

    left.appendChild(title);
    left.appendChild(uidSpan);
    left.appendChild(meta);

    var right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';

    var viewBtn = document.createElement('button');
    viewBtn.className = 'nexus-main-btn';
    viewBtn.type = 'button';
    viewBtn.style.fontSize = '0.8rem';
    viewBtn.innerHTML = '<i class="fas fa-eye"></i>';
    viewBtn.title = 'Ver dashboard de este usuario';
    viewBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      viewUserDashboard(uid);
    });

    var blockBtn = document.createElement('button');
    blockBtn.type = 'button';
    blockBtn.style.fontSize = '0.8rem';
    blockBtn.style.padding = '6px 10px';
    blockBtn.style.borderRadius = '8px';
    blockBtn.style.border = '1px solid rgba(255,255,255,0.18)';
    blockBtn.style.background = blocked ? 'rgba(229,57,53,0.25)' : 'rgba(0,0,0,0.35)';
    blockBtn.style.color = blocked ? '#ffb3b3' : '#ffb347';
    blockBtn.innerHTML = blocked ? '<i class="fas fa-lock-open"></i>' : '<i class="fas fa-lock"></i>';
    blockBtn.title = blocked ? 'Unblock user' : 'Block user (revoke access)';
    blockBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleBlockUser(uid, !blocked);
    });

    var shadowBtn = document.createElement('button');
    shadowBtn.type = 'button';
    shadowBtn.style.fontSize = '0.8rem';
    shadowBtn.style.padding = '6px 10px';
    shadowBtn.style.borderRadius = '8px';
    shadowBtn.style.border = '1px solid rgba(255,255,255,0.18)';
    shadowBtn.style.background = shadowbanned ? 'rgba(111,66,193,0.35)' : 'rgba(0,0,0,0.35)';
    shadowBtn.style.color = shadowbanned ? '#e0bbff' : '#c792ea';
    shadowBtn.innerHTML = '<i class="fas fa-user-secret"></i>';
    shadowBtn.title = shadowbanned ? 'Remove shadowban' : 'Shadowban (user sees site normal; only Commanders see status)';
    shadowBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleShadowbanUser(uid, !shadowbanned);
    });

    var tagBtn = document.createElement('button');
    tagBtn.type = 'button';
    tagBtn.style.fontSize = '0.8rem';
    tagBtn.style.padding = '6px 10px';
    tagBtn.style.borderRadius = '8px';
    tagBtn.style.border = '1px solid rgba(255,255,255,0.18)';
    tagBtn.style.background = internalTag ? 'rgba(0,150,136,0.35)' : 'rgba(0,0,0,0.35)';
    tagBtn.style.color = internalTag ? '#b2dfdb' : '#80cbc4';
    tagBtn.innerHTML = '<i class="fas fa-tag"></i>';
    tagBtn.title = internalTag ? ('Tag: ' + internalTag) : 'Añadir etiqueta interna';
    tagBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      setUserInternalTag(uid, internalTag || '');
    });

    var tribunalBtn = document.createElement('button');
    tribunalBtn.type = 'button';
    tribunalBtn.style.fontSize = '0.8rem';
    tribunalBtn.style.padding = '6px 10px';
    tribunalBtn.style.borderRadius = '8px';
    tribunalBtn.style.border = '1px solid rgba(255,255,255,0.18)';
    tribunalBtn.style.background = 'rgba(0,0,0,0.35)';
    tribunalBtn.style.color = '#f0b429';
    tribunalBtn.innerHTML = '<i class="fas fa-gavel"></i>';
    tribunalBtn.title = 'Tribunal of Appeals – Open official chat with this user';
    tribunalBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      openTribunal(uid, nick);
    });

    right.appendChild(viewBtn);
    right.appendChild(blockBtn);
    right.appendChild(shadowBtn);
    right.appendChild(tagBtn);
    right.appendChild(tribunalBtn);

    container.appendChild(left);
    container.appendChild(right);

    return container;
  }

  function renderUsersList(usersMap, emptyMessage) {
    var list = document.getElementById('usersList');
    var empty = document.getElementById('usersListEmpty');
    if (!list || !empty) return;

    list.innerHTML = '';
    var entries = Object.keys(usersMap || {});
    if (!entries.length) {
      empty.style.display = 'block';
      empty.textContent = emptyMessage || 'No se encontraron usuarios.';
      return;
    }
    empty.style.display = 'none';
    if (list) list.style.display = 'block';

    entries.forEach(function(uid) {
      var row = renderUserItem(uid, usersMap[uid]);
      list.appendChild(row);
    });
  }

  function toggleBlockUser(uid, shouldBlock) {
    if (!db || !uid) return;
    var me = typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser;
    if (me && me.uid === uid && shouldBlock) {
      showFloatingMessage('error', 'You cannot block yourself.');
      return;
    }
    var confirmMsg = shouldBlock
      ? 'Block this user? They may lose access to login, chat, and other features (site rules apply).'
      : 'Unblock this user?';
    if (!window.confirm(confirmMsg)) return;

    db.ref('users/' + uid + '/blocked').set(shouldBlock ? true : null).then(function() {
      showFloatingMessage('success', shouldBlock ? 'Usuario bloqueado.' : 'Usuario desbloqueado.');
      refreshUsersListAfterAction();
    }).catch(function(err) {
      console.error('Error al cambiar estado de bloqueo:', err);
      showFloatingMessage('error', 'No se pudo actualizar el estado de bloqueo.');
    });
  }

  function refreshUsersListAfterAction() {
    if (lastUsersSource === 'search' && lastSearchQuery) {
      var input = document.getElementById('userSearchInput');
      if (input) input.value = lastSearchQuery;
      searchUsers();
    } else {
      loadRecentUsers();
    }
  }

  // ---------- Tribunal of Appeals (chat Commander ↔ user) ----------
  var tribunalTargetUid = null;
  var tribunalMessagesRef = null;
  var tribunalUnsubscribe = null;

  function openTribunal(uid, nick) {
    if (!db || !uid) return;
    if (tribunalUnsubscribe) tribunalUnsubscribe();
    tribunalTargetUid = uid;
    var modal = document.getElementById('tribunalModal');
    var titleNick = document.getElementById('tribunalTargetNick');
    var titleUid = document.getElementById('tribunalTargetUid');
    var messagesEl = document.getElementById('tribunalMessages');
    var inputEl = document.getElementById('tribunalInput');
    if (titleNick) titleNick.textContent = nick || uid;
    if (titleUid) titleUid.textContent = uid;
    if (messagesEl) messagesEl.innerHTML = '';
    if (inputEl) inputEl.value = '';

    var ref = db.ref('tribunalAppeals/' + uid);
    ref.child('active').set(true);
    ref.child('lastOpenedByCommander').set(Date.now());

    tribunalMessagesRef = ref.child('messages');
    tribunalMessagesRef.on('value', function(snap) {
      if (!messagesEl || !snap.exists()) {
        if (messagesEl) messagesEl.innerHTML = '<div class="tribunal-msg-empty">No messages yet. Write below.</div>';
        return;
      }
      messagesEl.innerHTML = '';
      var arr = [];
      snap.forEach(function(c) {
        var v = c.val();
        arr.push({ id: c.key, from: v.from, text: v.text || '', ts: v.ts || 0 });
      });
      arr.sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
      arr.forEach(function(m) {
        var div = document.createElement('div');
        div.className = 'tribunal-msg-line ' + (m.from === 'commander' ? 'tribunal-msg-commander' : 'tribunal-msg-user');
        var who = m.from === 'commander' ? 'Commander' : 'User';
        var time = m.ts ? new Date(m.ts).toLocaleString() : '';
        div.innerHTML = '<span class="tribunal-msg-who">' + who + '</span> <span class="tribunal-msg-time">' + time + '</span><br><span class="tribunal-msg-text">' + escapeHtml(m.text) + '</span>';
        messagesEl.appendChild(div);
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
    tribunalUnsubscribe = function() {
      if (tribunalMessagesRef) tribunalMessagesRef.off('value');
    };

    if (modal) {
      modal.style.display = '';
      requestAnimationFrame(function() { modal.classList.add('tribunal-modal-visible'); });
      if (inputEl) inputEl.focus();
    }
  }

  function escapeHtml(s) {
    if (!s) return '';
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function escAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  function initTribunalModal() {
    var modal = document.getElementById('tribunalModal');
    var closeBtn = document.getElementById('tribunalCloseBtn');
    var backdrop = modal && modal.querySelector('.tribunal-modal-backdrop');
    var sendBtn = document.getElementById('tribunalSendBtn');
    var inputEl = document.getElementById('tribunalInput');

    function closeTribunal() {
      if (tribunalUnsubscribe) tribunalUnsubscribe();
      tribunalTargetUid = null;
      tribunalMessagesRef = null;
      if (modal) {
        modal.classList.remove('tribunal-modal-visible');
        setTimeout(function() { modal.style.display = 'none'; }, 200);
      }
    }

    if (closeBtn) closeBtn.addEventListener('click', closeTribunal);
    if (backdrop) backdrop.addEventListener('click', closeTribunal);

    var ban1h = document.getElementById('tribunalBan1h');
    var ban6h = document.getElementById('tribunalBan6h');
    var ban24h = document.getElementById('tribunalBan24h');
    var ban3d = document.getElementById('tribunalBan3d');
    var ban7d = document.getElementById('tribunalBan7d');
    var banRemove = document.getElementById('tribunalBanRemove');
    function applyTemporalBan(hours) {
      if (!db || !tribunalTargetUid) return;
      var until = Date.now() + (hours * 60 * 60 * 1000);
      db.ref('tribunalAppeals/' + tribunalTargetUid).update({
        banUntil: until,
        banAppliedAt: Date.now(),
        active: true
      }).then(function() {
        showFloatingMessage('success', 'Ban temporal aplicado: overlay forzado ' + hours + 'h.');
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'Error al aplicar ban temporal.');
      });
    }
    function removeTemporalBan() {
      if (!db || !tribunalTargetUid) return;
      db.ref('tribunalAppeals/' + tribunalTargetUid).update({
        banUntil: null,
        banAppliedAt: null,
        active: false
      }).then(function() {
        showFloatingMessage('success', 'Ban temporal quitado. Overlay cerrado para el usuario.');
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'Error al quitar ban temporal.');
      });
    }
    if (ban1h) ban1h.addEventListener('click', function() { applyTemporalBan(1); });
    if (ban6h) ban6h.addEventListener('click', function() { applyTemporalBan(6); });
    if (ban24h) ban24h.addEventListener('click', function() { applyTemporalBan(24); });
    if (ban3d) ban3d.addEventListener('click', function() { applyTemporalBan(72); });
    if (ban7d) ban7d.addEventListener('click', function() { applyTemporalBan(168); });
    if (banRemove) banRemove.addEventListener('click', removeTemporalBan);

    if (sendBtn && inputEl) {
      function sendMessage() {
        var text = (inputEl.value || '').trim();
        if (!text || !db || !tribunalTargetUid) return;
        tribunalMessagesRef = db.ref('tribunalAppeals/' + tribunalTargetUid + '/messages');
        tribunalMessagesRef.push({ from: 'commander', text: text, ts: Date.now() }).then(function() {
          inputEl.value = '';
        }).catch(function(err) {
          console.error('Tribunal send error:', err);
          showFloatingMessage('error', 'Failed to send message.');
        });
      }
      sendBtn.addEventListener('click', sendMessage);
      inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendMessage();
        }
      });
    }
  }

  function toggleShadowbanUser(uid, shouldShadowban) {
    if (!db || !uid) return;
    var me = typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser;
    if (me && me.uid === uid && shouldShadowban) {
      showFloatingMessage('error', 'You cannot shadowban yourself.');
      return;
    }
    var confirmMsg = shouldShadowban
      ? 'Apply SHADOWBAN? The user will see the site as normal; only Commanders will see they are sanctioned. Use for discreet moderation.'
      : 'Remove SHADOWBAN from this user?';
    if (!window.confirm(confirmMsg)) return;

    db.ref('users/' + uid + '/shadowbanned').set(shouldShadowban ? true : null).then(function() {
      showFloatingMessage('success', shouldShadowban ? 'Shadowban aplicado.' : 'Shadowban retirado.');
      refreshUsersListAfterAction();
    }).catch(function(err) {
      console.error('Error al cambiar shadowban:', err);
      showFloatingMessage('error', 'No se pudo actualizar el shadowban.');
    });
  }

  function setUserInternalTag(uid, currentTag) {
    if (!db || !uid) return;
    var val = window.prompt('Etiqueta interna (visible solo para Commanders):', currentTag || '');
    if (val === null) return;
    val = (val || '').trim();
    var ref = db.ref('users/' + uid + '/internalTag');
    var op = val ? ref.set(val) : ref.set(null);
    op.then(function() {
      showFloatingMessage('success', 'Etiqueta actualizada.');
      refreshUsersListAfterAction();
    }).catch(function(err) {
      console.error('Error al actualizar etiqueta interna:', err);
      showFloatingMessage('error', 'No se pudo actualizar la etiqueta.');
    });
  }

  function searchUsers() {
    if (!db) return;
    var input = document.getElementById('userSearchInput');
    var searchBtn = document.getElementById('userSearchBtn');
    if (!input) return;
    var q = (input.value || '').trim();
    var empty = document.getElementById('usersListEmpty');
    var list = document.getElementById('usersList');
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'Buscando usuarios...';
    }
    if (list) list.innerHTML = '';
    if (searchBtn) searchBtn.disabled = true;

    function enableSearch() {
      if (searchBtn) searchBtn.disabled = false;
    }

    if (!q) {
      if (empty) empty.textContent = 'Escribe un nick o UID para buscar.';
      enableSearch();
      return;
    }

    var usersRef = db.ref('users');
    var results = {};

    if (q.length >= 6) {
      usersRef.child(q).once('value').then(function(snap) {
        if (snap.exists()) results[q] = snap.val();
        lastUsersSource = 'search';
        lastSearchQuery = q;
        renderUsersList(results, 'No se encontraron usuarios con ese UID.');
        enableSearch();
      }).catch(function(err) {
        console.error('Error en búsqueda por UID:', err);
        renderUsersList({}, 'Error al buscar usuarios.');
        enableSearch();
      });
      return;
    }

    var qNorm = normalizeText(q);

    // Combina el índice (rápido) con un escaneo amplio (para usuarios sin nick_lowercase).
    // Así el buscador encuentra al jugador aunque falte el índice o tenga acentos.
    function runIndexedQuery() {
      return usersRef.orderByChild('nick_lowercase').startAt(qNorm).endAt(qNorm + '\uf8ff').limitToFirst(60).once('value')
        .then(function(snap) {
          if (snap.exists()) snap.forEach(function(child) { results[child.key] = child.val(); });
        })
        .catch(function(err) {
          console.warn('Índice nick_lowercase no disponible:', err && (err.message || err));
        });
    }

    function runBroadScan() {
      return usersRef.orderByChild('registro').limitToLast(1500).once('value').then(function(snap) {
        if (!snap.exists()) return;
        snap.forEach(function(child) {
          if (results[child.key]) return;
          var d = child.val() || {};
          if (userMatchesQuery(d, child.key, qNorm)) results[child.key] = d;
        });
      }).catch(function(err) {
        console.warn('Escaneo amplio falló:', err && (err.message || err));
      });
    }

    runIndexedQuery()
      .then(runBroadScan)
      .then(function() {
        lastUsersSource = 'search';
        lastSearchQuery = q;
        var ordered = sortUsersByRelevance(results, qNorm);
        renderUsersList(ordered, 'No se encontraron usuarios con "' + q + '".');
        enableSearch();
      })
      .catch(function(err) {
        console.error('Error en búsqueda de usuarios:', err);
        renderUsersList({}, 'Error al buscar usuarios.');
        enableSearch();
      });
  }

  // Normaliza texto: minúsculas y sin acentos/diacríticos, para comparar de forma tolerante.
  function normalizeText(s) {
    s = (s == null ? '' : String(s)).toLowerCase().trim();
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return s;
  }

  // ¿Coincide el usuario con la consulta? Compara nick, displayName, email y UID (prefijo o substring).
  function userMatchesQuery(d, uid, qNorm) {
    if (!qNorm) return false;
    var fields = [d && d.nick, d && d.displayName, d && d.email, d && d.nick_lowercase, uid];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] == null) continue;
      if (normalizeText(fields[i]).indexOf(qNorm) !== -1) return true;
    }
    return false;
  }

  // Ordena resultados: primero los que empiezan por la consulta, luego alfabético.
  function sortUsersByRelevance(map, qNorm) {
    var keys = Object.keys(map);
    keys.sort(function(a, b) {
      var da = map[a] || {}, dbb = map[b] || {};
      var na = normalizeText(da.nick || da.displayName || da.email || a);
      var nb = normalizeText(dbb.nick || dbb.displayName || dbb.email || b);
      var aStart = na.indexOf(qNorm) === 0 ? 0 : 1;
      var bStart = nb.indexOf(qNorm) === 0 ? 0 : 1;
      if (aStart !== bStart) return aStart - bStart;
      return na.localeCompare(nb);
    });
    var out = {};
    keys.forEach(function(k) { out[k] = map[k]; });
    return out;
  }

  function loadRecentUsers() {
    if (!db) return;
    var empty = document.getElementById('usersListEmpty');
    var list = document.getElementById('usersList');
    var recentBtn = document.getElementById('loadRecentUsersBtn');
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'Cargando últimos usuarios registrados...';
    }
    if (list) list.innerHTML = '';
    if (recentBtn) recentBtn.disabled = true;

    db.ref('users').orderByChild('registro').limitToLast(50).once('value').then(function(snap) {
      var results = {};
      if (snap.exists()) {
        snap.forEach(function(child) {
          results[child.key] = child.val();
        });
      }
      lastUsersSource = 'recent';
      lastSearchQuery = '';
      renderUsersList(results, 'No se encontraron usuarios recientes.');
    }).catch(function(err) {
      console.error('Error al cargar usuarios recientes:', err);
      renderUsersList({}, 'Error al cargar usuarios recientes.');
    }).finally(function() {
      if (recentBtn) recentBtn.disabled = false;
    });
  }

  function initCommanderCLI() {
    var output = document.getElementById('cliOutput');
    var input = document.getElementById('cliInput');
    if (!output || !input) return;

    var commandHistory = [];
    var historyIndex = -1;
    var CLI_VERSION = '1.0';

    function appendLine(text, className) {
      var line = document.createElement('div');
      line.className = 'cli-output-line ' + (className || '');
      line.textContent = text;
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    }

    function runCommand(rawCmd) {
      var cmd = (rawCmd || '').trim();
      if (!cmd) return;
      appendLine('> ' + cmd, 'cli-command');
      if (commandHistory[commandHistory.length - 1] !== cmd) {
        commandHistory.push(cmd);
        if (commandHistory.length > 50) commandHistory.shift();
      }
      historyIndex = commandHistory.length;

      var parts = cmd.split(/\s+/);
      var c = parts[0].toLowerCase();

      if (c === 'clear') {
        output.innerHTML = '';
        appendLine('Consola limpiada. Escribe "help" para ver comandos.', 'cli-system');
        input.focus();
        return;
      }
      if (c === 'help') {
        appendLine('--- Commander CLI v' + CLI_VERSION + ' ---', 'cli-system');
        appendLine('  help       Muestra esta ayuda.', 'cli-system');
        appendLine('  clear      Limpia la consola.', 'cli-system');
        appendLine('  status     Estado del panel y Firebase.', 'cli-system');
        appendLine('  users      Total de usuarios registrados.', 'cli-system');
        appendLine('  ping       Latencia a Firebase (ms).', 'cli-system');
        appendLine('  time       Fecha y hora actual.', 'cli-system');
        appendLine('  version    Versión de la CLI.', 'cli-system');
        appendLine('----------------------------------------', 'cli-system');
        input.focus();
        return;
      }
      if (c === 'status') {
        appendLine('Panel: activo | Firebase: ' + (db ? 'conectado' : 'no'), 'cli-success');
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
          var u = firebase.auth().currentUser;
          appendLine('Usuario: ' + (u.email || u.uid), 'cli-system');
        }
        input.focus();
        return;
      }
      if (c === 'users' || c === 'count') {
        if (!db) {
          appendLine('Firebase no disponible.', 'cli-error');
          input.focus();
          return;
        }
        db.ref('users').once('value').then(function(snap) {
          var n = snap.exists() ? snap.numChildren() : 0;
          appendLine('Usuarios registrados: ' + n, 'cli-success');
          input.focus();
        }).catch(function(err) {
          appendLine('Error: ' + (err.message || 'desconocido'), 'cli-error');
          input.focus();
        });
        return;
      }
      if (c === 'ping') {
        if (!db) {
          appendLine('Firebase no disponible.', 'cli-error');
          input.focus();
          return;
        }
        var start = Date.now();
        db.ref('.info/serverTimeOffset').once('value').then(function() {
          var ms = Date.now() - start;
          appendLine('Ping Firebase: ' + ms + ' ms', 'cli-success');
          input.focus();
        }).catch(function(err) {
          appendLine('Error: ' + (err.message || 'timeout'), 'cli-error');
          input.focus();
        });
        return;
      }
      if (c === 'time' || c === 'date') {
        var now = new Date();
        appendLine(now.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'medium' }), 'cli-success');
        appendLine('UTC: ' + now.toISOString(), 'cli-system');
        input.focus();
        return;
      }
      if (c === 'version') {
        appendLine('Commander CLI v' + CLI_VERSION, 'cli-success');
        input.focus();
        return;
      }
      appendLine('Comando no reconocido: "' + c + '". Escribe "help" para ver comandos.', 'cli-error');
      input.focus();
    }

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runCommand(input.value);
        input.value = '';
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commandHistory.length === 0) return;
        if (historyIndex > 0) historyIndex--;
        input.value = commandHistory[historyIndex];
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (commandHistory.length === 0) return;
        if (historyIndex < commandHistory.length - 1) {
          historyIndex++;
          input.value = commandHistory[historyIndex];
        } else {
          historyIndex = commandHistory.length;
          input.value = '';
        }
        return;
      }
    });

    output.addEventListener('click', function() { input.focus(); });
    input.focus();
  }

  function initSearchAutocomplete() {
    var input = document.getElementById('userSearchInput');
    var list = document.getElementById('userSearchAutocomplete');
    if (!input || !list) return;

    var debounceTimer = null;
    var DEBOUNCE_MS = 220;
    var MIN_CHARS = 2;

    function hideAutocomplete() {
      list.innerHTML = '';
      list.setAttribute('aria-hidden', 'true');
      list.classList.remove('commander-autocomplete-visible');
    }

    function showSuggestions(suggestions) {
      list.innerHTML = '';
      if (!suggestions.length) {
        hideAutocomplete();
        return;
      }
      suggestions.slice(0, 12).forEach(function(item) {
        var div = document.createElement('div');
        div.className = 'commander-autocomplete-item';
        div.textContent = item.nick + ' (' + item.uid + ')';
        div.dataset.uid = item.uid;
        div.dataset.nick = item.nick;
        div.addEventListener('mousedown', function(e) {
          e.preventDefault();
        });
        div.addEventListener('click', function() {
          input.value = item.nick;
          hideAutocomplete();
          selectUserInList(item.uid, item.nick);
        });
        list.appendChild(div);
      });
      list.setAttribute('aria-hidden', 'false');
      list.classList.add('commander-autocomplete-visible');
    }

    function fetchSuggestions(q) {
      var qNorm = normalizeText(q);
      if (qNorm.length < MIN_CHARS) {
        hideAutocomplete();
        return;
      }
      var usersRef = db.ref('users');
      var found = {};

      function collectFrom(snap, requireMatch) {
        if (!snap || !snap.exists()) return;
        snap.forEach(function(c) {
          if (found[c.key]) return;
          var d = c.val() || {};
          if (requireMatch && !userMatchesQuery(d, c.key, qNorm)) return;
          found[c.key] = { uid: c.key, nick: (d.nick || d.displayName || d.email || c.key) };
        });
      }

      function finish() {
        var out = Object.keys(found).map(function(k) { return found[k]; });
        out.sort(function(a, b) {
          var aa = normalizeText(a.nick), bb = normalizeText(b.nick);
          var aStart = aa.indexOf(qNorm) === 0 ? 0 : 1;
          var bStart = bb.indexOf(qNorm) === 0 ? 0 : 1;
          if (aStart !== bStart) return aStart - bStart;
          return aa.localeCompare(bb);
        });
        showSuggestions(out);
      }

      usersRef.orderByChild('nick_lowercase').startAt(qNorm).endAt(qNorm + '\uf8ff').limitToFirst(20).once('value')
        .then(function(snap) { collectFrom(snap, false); })
        .catch(function() {})
        .then(function() {
          return usersRef.orderByChild('registro').limitToLast(1200).once('value')
            .then(function(snap) { collectFrom(snap, true); })
            .catch(function() {});
        })
        .then(finish)
        .catch(function() { hideAutocomplete(); });
    }

    input.addEventListener('input', function() {
      clearTimeout(debounceTimer);
      var q = (input.value || '').trim();
      if (q.length >= 6 && /^[a-zA-Z0-9_-]+$/.test(q)) {
        hideAutocomplete();
        return;
      }
      debounceTimer = setTimeout(function() { fetchSuggestions(q); }, DEBOUNCE_MS);
    });
    input.addEventListener('focus', function() {
      var q = (input.value || '').trim();
      if (q.length >= MIN_CHARS) fetchSuggestions(q);
    });
    input.addEventListener('blur', function() {
      setTimeout(hideAutocomplete, 200);
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') hideAutocomplete();
    });
  }

  function initCommanderHeaderSearch() {
    var input = document.getElementById('commanderHeaderSearchInput');
    var resultsEl = document.getElementById('commanderHeaderSearchResults');
    if (!input || !resultsEl || input.dataset.bound === '1') return;
    input.dataset.bound = '1';

    var debounceTimer = null;

    function hideResults() {
      resultsEl.innerHTML = '';
      resultsEl.style.display = 'none';
      resultsEl.classList.remove('open');
    }

    function openUsersTab() {
      var usersTab = document.querySelector('.commander-tab[data-tab="users"]');
      if (usersTab) usersTab.click();
    }

    function showResults(items) {
      if (!items.length) {
        hideResults();
        return;
      }
      resultsEl.innerHTML = items.slice(0, 10).map(function(item) {
        return '<button type="button" class="search-result-item commander-header-search-item" data-uid="' + escAttr(item.uid) + '" data-nick="' + escAttr(item.nick) + '">' +
          '<div class="search-result-info"><div class="search-result-nick">' + escapeHtml(item.nick) + '</div>' +
          '<div class="search-result-rank">' + escapeHtml(item.uid) + '</div></div></button>';
      }).join('');
      resultsEl.style.display = 'block';
      resultsEl.classList.add('open');
      resultsEl.querySelectorAll('.commander-header-search-item').forEach(function(btn) {
        btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        btn.addEventListener('click', function() {
          var uid = btn.getAttribute('data-uid');
          var nick = btn.getAttribute('data-nick');
          input.value = nick || uid;
          hideResults();
          openUsersTab();
          var target = document.getElementById('userSearchInput');
          if (target) target.value = nick || uid;
          selectUserInList(uid, nick || uid);
        });
      });
    }

    function fetchHeaderSuggestions(q) {
      if (!db) return;
      var qNorm = normalizeText(q);
      if (qNorm.length < 2) {
        hideResults();
        return;
      }
      var found = {};
      var usersRef = db.ref('users');

      function collectFrom(snap, requireMatch) {
        if (!snap || !snap.exists()) return;
        snap.forEach(function(c) {
          if (found[c.key]) return;
          var d = c.val() || {};
          if (requireMatch && !userMatchesQuery(d, c.key, qNorm)) return;
          found[c.key] = { uid: c.key, nick: (d.nick || d.displayName || d.email || c.key) };
        });
      }

      usersRef.orderByChild('nick_lowercase').startAt(qNorm).endAt(qNorm + '\uf8ff').limitToFirst(12).once('value')
        .then(function(snap) { collectFrom(snap, false); })
        .catch(function() {})
        .then(function() {
          return usersRef.orderByChild('registro').limitToLast(800).once('value')
            .then(function(snap) { collectFrom(snap, true); })
            .catch(function() {});
        })
        .then(function() {
          var out = Object.keys(found).map(function(k) { return found[k]; });
          out.sort(function(a, b) {
            var aa = normalizeText(a.nick), bb = normalizeText(b.nick);
            var aStart = aa.indexOf(qNorm) === 0 ? 0 : 1;
            var bStart = bb.indexOf(qNorm) === 0 ? 0 : 1;
            if (aStart !== bStart) return aStart - bStart;
            return aa.localeCompare(bb);
          });
          showResults(out);
        })
        .catch(function() { hideResults(); });
    }

    input.addEventListener('input', function() {
      clearTimeout(debounceTimer);
      var q = (input.value || '').trim();
      debounceTimer = setTimeout(function() { fetchHeaderSuggestions(q); }, 220);
    });
    input.addEventListener('focus', function() {
      var q = (input.value || '').trim();
      if (q.length >= 2) fetchHeaderSuggestions(q);
    });
    input.addEventListener('blur', function() {
      setTimeout(hideResults, 200);
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') hideResults();
    });
  }

  function attachCommanderUI() {
    if (commanderUiAttached) return;
    commanderUiAttached = true;
    var searchBtn = document.getElementById('userSearchBtn');
    var recentBtn = document.getElementById('loadRecentUsersBtn');
    var input = document.getElementById('userSearchInput');

    if (searchBtn) searchBtn.addEventListener('click', searchUsers);
    if (recentBtn) recentBtn.addEventListener('click', loadRecentUsers);
    if (input) {
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          searchUsers();
        }
      });
    }

    // Buscador del header: atajo que lleva a la pestaña Usuarios y ejecuta la búsqueda inteligente.
    var headerInput = document.getElementById('commanderHeaderSearchInput');
    if (headerInput) {
      headerInput.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var q = (headerInput.value || '').trim();
        var usersTab = document.querySelector('.commander-tab[data-tab="users"]');
        if (usersTab) usersTab.click();
        var target = document.getElementById('userSearchInput');
        if (target) { target.value = q; target.focus(); }
        searchUsers();
      });
    }

    initSearchAutocomplete();
    initCommanderHeaderSearch();
    initTribunalModal();
    initCustomizationManager();
    initSiteEngagementHub();
    initTokensHub();
    initCreatorMarketHub();
    initTournamentsHub();
    initSecurityHub();
  }

  // -------------------------------------------------
  // TOKENS: estadísticas, ajustes manuales, entregas premium, auditoría
  // Datos: users/{uid}/tokens, users/{uid}/tokenLedger, security/tokenAuditLog
  // -------------------------------------------------
  function initTokensHub() {
    if (!db) return;
    var tokFunctions = (typeof firebase !== 'undefined' && firebase.functions) ? firebase.functions() : null;
    var secRoot = db.ref('security');
    var selectedTokenUser = null;
    var tokenAuditCache = {};
    var tokenAuditFilter = 'all';
    var usersTokenCache = [];

    function isBossActor() {
      return isBossOfTheStateRango(currentCommanderRango);
    }

    // ---- Bolsa de premios Play Zone (PZ-002) ----
    function setPzBudgetText(id, value) {
      var el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function loadPzBudget() {
      if (!tokFunctions) {
        setPzBudgetText('tokPzBudgetRemaining', 'N/D');
        return;
      }
      setPzBudgetText('tokPzBudgetRemaining', '…');
      tokFunctions.httpsCallable('getPlayzoneRewardBudget')({}).then(function(res) {
        var b = (res && res.data) || {};
        setPzBudgetText('tokPzBudgetRemaining', String(b.remaining != null ? b.remaining : '—'));
        setPzBudgetText('tokPzBudgetGranted', String(b.totalGranted || 0));
        setPzBudgetText('tokPzBudgetCap', String(b.dailyCapPerPlayer || '—'));
        setPzBudgetText('tokPzBudgetLast', b.lastRefillAt ? fmtDate(b.lastRefillAt) : '—');
        setPzBudgetText('tokPzBudgetLastBy', b.lastRefillByNick ? ('Por ' + b.lastRefillByNick) : 'Sin registros');
      }).catch(function(err) {
        console.error('[tokens] bolsa Play Zone', err);
        setPzBudgetText('tokPzBudgetRemaining', 'Error');
      });
    }

    function applyPzBudgetChange() {
      if (!tokFunctions) {
        showFloatingMessage('error', 'Cloud Functions no disponibles.');
        return;
      }
      var amountEl = document.getElementById('tokPzBudgetAmount');
      var reasonEl = document.getElementById('tokPzBudgetReason');
      var amount = parseInt(amountEl && amountEl.value, 10);
      var reason = String((reasonEl && reasonEl.value) || '').trim();

      if (!amount) {
        showFloatingMessage('error', 'Indica una cantidad distinta de cero.');
        return;
      }
      if (!reason) {
        showFloatingMessage('error', 'El motivo es obligatorio para auditoría.');
        return;
      }
      var verb = amount > 0 ? 'añadir' : 'retirar';
      if (!confirm('¿Confirmas ' + verb + ' ' + Math.abs(amount) + ' tokens de la bolsa de Play Zone?\n\nMotivo: ' + reason)) return;

      var btn = document.getElementById('tokPzBudgetRefillBtn');
      var orig = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Aplicando…'; }

      tokFunctions.httpsCallable('refillPlayzoneRewardBudget')({ amount: amount, reason: reason }).then(function(res) {
        var remaining = (res && res.data && res.data.remaining) || 0;
        showFloatingMessage('success', 'Bolsa actualizada. Saldo: ' + remaining + ' tokens.');
        if (amountEl) amountEl.value = '';
        if (reasonEl) reasonEl.value = '';
        loadPzBudget();
      }).catch(function(err) {
        console.error('[tokens] recarga bolsa', err);
        showFloatingMessage('error', (err && err.message) || 'No se pudo actualizar la bolsa.');
      }).finally(function() {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
      });
    }

    var pzBudgetRefillBtn = document.getElementById('tokPzBudgetRefillBtn');
    if (pzBudgetRefillBtn) pzBudgetRefillBtn.addEventListener('click', applyPzBudgetChange);
    var pzBudgetRefreshBtn = document.getElementById('tokPzBudgetRefreshBtn');
    if (pzBudgetRefreshBtn) pzBudgetRefreshBtn.addEventListener('click', loadPzBudget);
    loadPzBudget();

    function isProtectedRank(data) {
      if (!data) return false;
      var r = normalizeRango(data.rango);
      return r === 'commander' || r === 'divisional_commander' || r === RANGO_BOSS;
    }

    function canModifyTargetTokens(uid, data) {
      if (isBossActor()) return true;
      if (isProtectedRank(data)) return false;
      return true;
    }

    function updateTokenAdjustUI() {
      var addBtn = document.getElementById('tokAddBtn');
      var removeBtn = document.getElementById('tokRemoveBtn');
      var warnEl = document.getElementById('tokProtectedWarn');
      var deliverBtn = document.getElementById('tokRewardDeliverBtn');
      if (!selectedTokenUser) {
        if (warnEl) warnEl.style.display = 'none';
        return;
      }
      var allowed = canModifyTargetTokens(selectedTokenUser.uid, selectedTokenUser.data);
      if (addBtn) addBtn.disabled = !allowed;
      if (removeBtn) removeBtn.disabled = !allowed;
      if (deliverBtn) deliverBtn.disabled = !allowed;
      if (warnEl) {
        warnEl.style.display = (!allowed && isProtectedRank(selectedTokenUser.data)) ? 'block' : 'none';
      }
    }

    function updateBossUI() {
      var badge = document.getElementById('tokBossBadge');
      var claimBtn = document.getElementById('tokClaimBossBtn');
      var hint = document.getElementById('tokBossHint');
      if (badge) badge.style.display = isBossActor() ? 'inline-flex' : 'none';
      if (claimBtn) {
        claimBtn.style.display = (!bossOfTheStateUid && (currentCommanderRango === 'commander' || isBossActor())) ? 'inline-flex' : 'none';
      }
      if (hint) {
        if (isBossActor()) {
          hint.textContent = '👑 Boss of the State — autoridad absoluta. Puedes tocar tokens de cualquiera, incluidos Commanders.';
        } else if (bossOfTheStateUid) {
          hint.textContent = 'Los Commanders y el Boss están protegidos. Solo Boss of the State puede modificar sus tokens.';
        } else {
          hint.textContent = 'El rango Boss of the State aún no está reclamado. Solo puede existir UNO en todo StudiosGamesRS.';
        }
      }
      renderBossRewardAlerts();
    }

    function loadBossStateConfig() {
      return secRoot.child('bossOfTheState').once('value').then(function(snap) {
        var cfg = snap.val() || {};
        bossOfTheStateUid = cfg.uid || null;
        updateBossUI();
      }).catch(function() { updateBossUI(); });
    }

    function claimBossOfTheState() {
      if (!currentCommanderUid) return;
      if (bossOfTheStateUid && bossOfTheStateUid !== currentCommanderUid) {
        showFloatingMessage('error', 'Ya existe un Boss of the State. Solo hay uno.');
        return;
      }
      if (!confirm('¿Reclamar el rango BOSS OF THE STATE?\n\nSerás el único. Autoridad total sobre tokens, Commanders y todo el panel.')) return;
      if (!tokFunctions) {
        showFloatingMessage('error', 'Cloud Functions no disponibles.');
        return;
      }
      tokFunctions.httpsCallable('claimBossOfTheState')({ nick: currentCommanderNick }).then(function(res) {
        var payload = (res && res.data) || {};
        bossOfTheStateUid = payload.uid || currentCommanderUid;
        currentCommanderRango = RANGO_BOSS;
        if (typeof window.__sgUpdateBossAuditVisibility === 'function') window.__sgUpdateBossAuditVisibility();
        updateBossUI();
        updateTokenAdjustUI();
        logTokenAudit({ action: 'boss_claimed', detail: 'Rango Boss of the State reclamado por ' + currentCommanderNick });
        showFloatingMessage('success', payload.alreadyBoss ? 'Ya eres Boss of the State.' : '👑 Boss of the State activado. Tú mandas aquí.');
      }).catch(function(err) {
        console.error(err);
        var msg = (err && err.message) ? err.message : 'No se pudo reclamar el rango Boss.';
        if (err && err.code === 'functions/already-exists') {
          msg = 'Ya existe un Boss of the State. Solo hay uno.';
        }
        showFloatingMessage('error', msg);
      });
    }

    function renderTopTokenHolders(forceRefresh) {
      var panel = document.getElementById('tokTopHoldersPanel');
      if (!panel) return;
      if (forceRefresh) usersTokenCache = [];
      panel.innerHTML = '<div class="sec-empty"><i class="fas fa-spinner fa-spin"></i> Calculando ranking…</div>';

      function paint(list) {
        if (!list.length) {
          panel.innerHTML = '<div class="sec-empty">No hay jugadores con tokens.</div>';
          return;
        }
        panel.innerHTML = list.slice(0, 25).map(function(u, i) {
          var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
          var r = normalizeRango(u.rango);
          var rankTag = isBossOfTheStateRango(r) ? '<span class="tok-boss-tag">BOSS</span>' :
            (r === 'commander' || r === 'divisional_commander') ? '<span class="tok-cmd-tag">CMD</span>' : '';
          var canTouch = canModifyTargetTokens(u.uid, u.raw || { rango: u.rango });
          var actions = '<span class="tok-top-actions">' +
            '<button type="button" class="tok-top-action-btn" data-action="select" data-uid="' + esc(u.uid) + '" title="Gestionar"><i class="fas fa-edit"></i></button>' +
            (canTouch ? '<button type="button" class="tok-top-action-btn tok-top-deduct-btn" data-action="deduct" data-uid="' + esc(u.uid) + '" title="Descontar tokens"><i class="fas fa-minus-circle"></i></button>' : '') +
            '</span>';
          return '<div class="tok-top-row-wrap">' +
            '<button type="button" class="tok-top-row" data-uid="' + esc(u.uid) + '">' +
            '<span class="tok-top-pos">' + medal + '</span>' +
            '<span class="tok-top-name">' + esc(u.nick) + rankTag + '</span>' +
            '<span class="tok-top-tokens">' + u.tokens.toLocaleString() + ' <small>tokens</small></span>' +
            '</button>' + actions + '</div>';
        }).join('');

        panel.querySelectorAll('.tok-top-row').forEach(function(el) {
          el.addEventListener('click', function() {
            var uid = el.getAttribute('data-uid');
            var found = list.find(function(u) { return u.uid === uid; });
            if (found) selectTokenUser(uid, found.raw || { nick: found.nick, tokens: found.tokens, rango: found.rango });
          });
        });
        panel.querySelectorAll('.tok-top-action-btn').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var uid = btn.getAttribute('data-uid');
            var found = list.find(function(u) { return u.uid === uid; });
            if (!found) return;
            var data = found.raw || { nick: found.nick, tokens: found.tokens, rango: found.rango };
            if (btn.getAttribute('data-action') === 'deduct') quickDeductTokens(uid, data);
            else selectTokenUser(uid, data);
          });
        });
      }

      if (usersTokenCache.length && !forceRefresh) {
        paint(usersTokenCache);
        return;
      }

      db.ref('users').once('value').then(function(snap) {
        var list = [];
        snap.forEach(function(child) {
          var d = child.val() || {};
          list.push({ uid: child.key, nick: d.nick || d.displayName || d.email || child.key, tokens: Number(d.tokens) || 0, rango: d.rango, raw: d });
        });
        list.sort(function(a, b) { return b.tokens - a.tokens; });
        usersTokenCache = list;
        paint(list);
      }).catch(function() {
        panel.innerHTML = '<div class="sec-empty">Error al cargar el ranking.</div>';
      });
    }

    function quickDeductTokens(uid, data) {
      if (!canModifyTargetTokens(uid, data)) {
        showFloatingMessage('error', 'Rango protegido. Solo Boss of the State puede descontar aquí.');
        return;
      }
      var nick = (data && (data.nick || data.displayName)) || uid;
      var amountStr = window.prompt('¿Cuántos tokens descontar a ' + nick + '?', '10');
      if (amountStr == null) return;
      var amount = Math.abs(Number(amountStr) || 0);
      if (!amount) { showFloatingMessage('error', 'Cantidad inválida.'); return; }
      var reason = window.prompt('Motivo del descuento (auditoría):', 'Ajuste Boss of the State');
      if (reason == null || !String(reason).trim()) { showFloatingMessage('error', 'Motivo obligatorio.'); return; }

      selectedTokenUser = { uid: uid, data: data };
      db.ref('users/' + uid + '/tokens').transaction(function(current) {
        var bal = Number(current) || 0;
        var next = bal - amount;
        if (next < 0) return;
        return next;
      }).then(function(result) {
        if (!result.committed) {
          showFloatingMessage('error', 'Saldo insuficiente o error.');
          return;
        }
        var after = Number(result.snapshot.val());
        var before = after + amount;
        var ledgerType = isBossActor() ? 'boss_debit' : 'commander_debit';
        return Promise.all([
          writeUserLedger(uid, { type: ledgerType, amount: -amount, balanceBefore: before, balanceAfter: after, reason: String(reason).trim() }),
          logTokenAudit({ action: 'token_remove', targetUid: uid, targetNick: nick, amount: -amount, balanceBefore: before, balanceAfter: after, reason: String(reason).trim() })
        ]).then(function() {
          if (data) data.tokens = after;
          usersTokenCache = [];
          renderTopTokenHolders(true);
          if (selectedTokenUser && selectedTokenUser.uid === uid) {
            var balEl = document.getElementById('tokSelectedBalance');
            if (balEl) balEl.textContent = after.toLocaleString();
            loadUserTokenHistory(uid);
          }
          refreshGlobalStats();
          showFloatingMessage('success', '−' + amount + ' tokens a ' + nick);
        });
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'Error al descontar.');
      });
    }

    function nowTs() { return firebase.database.ServerValue.TIMESTAMP; }
    function fmtDate(ms) {
      if (!ms || typeof ms !== 'number') return '—';
      return new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function logTokenAudit(payload) {
      var entry = {
        action: payload.action || 'unknown',
        targetUid: payload.targetUid || null,
        targetNick: payload.targetNick || null,
        amount: payload.amount != null ? Number(payload.amount) : null,
        balanceBefore: payload.balanceBefore != null ? Number(payload.balanceBefore) : null,
        balanceAfter: payload.balanceAfter != null ? Number(payload.balanceAfter) : null,
        rewardType: payload.rewardType || null,
        rewardDetail: payload.rewardDetail || null,
        reason: payload.reason || payload.detail || '',
        detail: payload.detail || payload.reason || '',
        byUid: currentCommanderUid || 'unknown',
        byNick: currentCommanderNick || 'Commander',
        at: nowTs()
      };
      return secRoot.child('tokenAuditLog').push(entry);
    }

    function writeUserLedger(uid, data) {
      if (!tokFunctions) {
        return Promise.reject(new Error('Cloud Functions no disponibles para tokenLedger.'));
      }
      return tokFunctions.httpsCallable('appendTokenLedgerEntry')({
        targetUid: uid,
        type: data.type,
        amount: data.amount,
        balanceBefore: data.balanceBefore,
        balanceAfter: data.balanceAfter,
        reason: data.reason || '',
        source: 'commander_panel',
        rewardType: data.rewardType || null,
        rewardValue: data.rewardValue != null ? data.rewardValue : null,
        byNick: currentCommanderNick || 'Commander'
      }).then(function(res) { return res.data; });
    }

    function refreshGlobalStats() {
      var circulationEl = document.getElementById('tokStatCirculation');
      var deliveredEl = document.getElementById('tokStatDelivered');
      var usersEl = document.getElementById('tokStatUsers');
      var pendingEl = document.getElementById('tokStatPending');
      var metaEl = document.getElementById('tokStatsMeta');
      var refreshBtn = document.getElementById('tokStatsRefreshBtn');
      if (refreshBtn) refreshBtn.disabled = true;

      var circulation = 0;
      var usersWithTokens = 0;
      var userCount = 0;
      var signupBonusEst = 0;

      db.ref('users').once('value').then(function(usersSnap) {
        usersTokenCache = [];
        usersSnap.forEach(function(child) {
          userCount++;
          var d = child.val() || {};
          var t = Number(d.tokens);
          if (isNaN(t)) t = 0;
          usersTokenCache.push({
            uid: child.key,
            nick: d.nick || d.displayName || d.email || child.key,
            tokens: t,
            rango: d.rango,
            raw: d
          });
          if (t > 0) {
            circulation += t;
            usersWithTokens++;
          }
        });
        usersTokenCache.sort(function(a, b) { return b.tokens - a.tokens; });
        signupBonusEst = userCount * 10;
        if (circulationEl) circulationEl.textContent = circulation.toLocaleString();
        if (usersEl) usersEl.textContent = usersWithTokens.toLocaleString() + ' / ' + userCount.toLocaleString();

        return db.ref('missions').orderByChild('createdAt').limitToLast(800).once('value');
      }).then(function(missionsSnap) {
        var delivered = 0;
        if (missionsSnap && missionsSnap.exists()) {
          missionsSnap.forEach(function(child) {
            var m = child.val() || {};
            if (!m.tokensAwarded) return;
            if (m.awardedAmount != null) {
              delivered += Number(m.awardedAmount) || 0;
            } else if (m.awardedPayouts && typeof m.awardedPayouts === 'object') {
              Object.keys(m.awardedPayouts).forEach(function(uid) {
                var p = m.awardedPayouts[uid];
                delivered += Number(p && p.amount) || Number(m.rewardPerPlayer) || 5;
              });
            } else if (m.participants) {
              var n = Object.keys(m.participants).length;
              delivered += n * (Number(m.rewardPerPlayer) || 5);
            }
          });
        }
        if (deliveredEl) deliveredEl.textContent = delivered.toLocaleString();

        return db.ref('tokenTransferRequests').once('value');
      }).then(function(reqSnap) {
        var pending = 0;
        if (reqSnap && reqSnap.exists()) {
          reqSnap.forEach(function(child) {
            var r = child.val() || {};
            if ((r.status || 'pending') === 'pending') pending += Number(r.amount) || 0;
          });
        }
        if (pendingEl) pendingEl.textContent = pending.toLocaleString();

        var statsPayload = {
          circulation: circulation,
          usersWithTokens: usersWithTokens,
          totalUsers: userCount,
          signupBonusEstimate: signupBonusEst,
          updatedAt: nowTs(),
          updatedByUid: currentCommanderUid,
          updatedByNick: currentCommanderNick
        };
        return secRoot.child('tokenStats/global').set(statsPayload);
      }).then(function() {
        if (metaEl) metaEl.textContent = 'Última actualización: ' + fmtDate(Date.now());
      }).catch(function(err) {
        console.error('Token stats:', err);
        showFloatingMessage('error', 'No se pudieron calcular todas las estadísticas.');
      }).finally(function() {
        if (refreshBtn) refreshBtn.disabled = false;
      });
    }

    function renderTokenAudit() {
      var listEl = document.getElementById('tokAuditList');
      var countEl = document.getElementById('tokAuditCount');
      if (!listEl) return;
      var ids = Object.keys(tokenAuditCache);
      if (countEl) countEl.textContent = ids.length + ' entradas';

      var filtered = ids.filter(function(id) {
        if (tokenAuditFilter === 'all') return true;
        return tokenAuditCache[id].action === tokenAuditFilter;
      });

      filtered.sort(function(a, b) {
        return (tokenAuditCache[b].at || 0) - (tokenAuditCache[a].at || 0);
      });

      if (!filtered.length) {
        listEl.innerHTML = '<div class="sec-empty">Sin entradas para este filtro.</div>';
        return;
      }

      listEl.innerHTML = filtered.slice(0, 80).map(function(id) {
        var e = tokenAuditCache[id];
        var actionLabel = {
          token_add: '➕ Agregó tokens',
          token_remove: '➖ Descontó tokens',
          premium_grant: '💎 Entrega premium',
          nexus_xp_grant: '⚡ XP Nexus otorgada',
          tokens_tab_open: '👁 Acceso pestaña',
          user_viewed: '🔍 Consultó usuario',
          super_commander_registered: '⭐ Cuenta maestra registrada',
          boss_claimed: '👑 Boss of the State reclamado'
        }[e.action] || e.action;
        var amountStr = e.amount != null ? (' · ' + (e.amount > 0 ? '+' : '') + e.amount + ' tokens') : '';
        var balStr = e.balanceAfter != null ? (' · Saldo: ' + e.balanceAfter) : '';
        var targetStr = e.targetNick ? (' → ' + esc(e.targetNick)) : (e.targetUid ? (' → ' + esc(e.targetUid)) : '');
        return '<div class="tok-audit-row">' +
          '<div class="tok-audit-top"><strong>' + esc(actionLabel) + '</strong><span class="tok-audit-time">' + fmtDate(e.at) + '</span></div>' +
          '<div class="tok-audit-meta">Por: <strong>' + esc(e.byNick || e.byUid) + '</strong>' + targetStr + amountStr + balStr + '</div>' +
          '<div class="tok-audit-detail">' + esc(e.reason || e.detail || e.rewardDetail || '—') + '</div>' +
          '</div>';
      }).join('');
    }

    function loadUserTokenHistory(uid) {
      var histEl = document.getElementById('tokUserHistoryList');
      if (!histEl || !uid) return;
      histEl.innerHTML = '<div class="sec-empty">Cargando historial…</div>';

      var items = [];

      Promise.all([
        db.ref('users/' + uid + '/tokenLedger').limitToLast(40).once('value'),
        db.ref('users/' + uid + '/extraVerifiedMatches').limitToLast(30).once('value')
      ]).then(function(results) {
        var ledgerSnap = results[0];
        var matchesSnap = results[1];

        if (ledgerSnap.exists()) {
          ledgerSnap.forEach(function(child) {
            var d = child.val() || {};
            items.push({
              at: d.at || 0,
              type: d.type || 'ledger',
              amount: d.amount,
              reason: d.reason || d.rewardType || '',
              source: d.source || 'commander_panel',
              byNick: d.byNick
            });
          });
        }

        if (matchesSnap.exists()) {
          matchesSnap.forEach(function(child) {
            var m = child.val() || {};
            items.push({
              at: m.at || 0,
              type: 'mission_reward',
              amount: null,
              reason: (m.title || 'Misión') + (m.game ? ' · ' + m.game : ''),
              source: 'playzone',
              byNick: 'Sistema'
            });
          });
        }

        items.sort(function(a, b) { return (b.at || 0) - (a.at || 0); });

        if (!items.length) {
          histEl.innerHTML = '<div class="sec-empty">Sin movimientos. El usuario pudo recibir tokens al registrarse (+10) sin registro en ledger.</div>';
          return;
        }

        histEl.innerHTML = items.slice(0, 50).map(function(it) {
          var amt = it.amount != null ? ((it.amount > 0 ? '+' : '') + it.amount + ' tokens · ') : '';
          var typeLabel = it.type === 'mission_reward' ? '🎮 Misión' :
            it.type === 'boss_credit' ? '👑 Boss +' :
            it.type === 'boss_debit' ? '👑 Boss −' :
            it.type === 'commander_credit' ? '➕ Commander' :
            it.type === 'commander_debit' ? '➖ Commander' :
            it.type === 'premium_grant' ? '💎 Premium' : it.type;
          return '<div class="tok-history-row">' +
            '<div><strong>' + esc(typeLabel) + '</strong> ' + amt + esc(it.reason || '') + '</div>' +
            '<div class="tok-history-meta">' + fmtDate(it.at) + ' · ' + esc(it.source) + (it.byNick ? (' · ' + esc(it.byNick)) : '') + '</div>' +
            '</div>';
        }).join('');
      }).catch(function(err) {
        console.error(err);
        histEl.innerHTML = '<div class="sec-empty">Error al cargar historial.</div>';
      });
    }

    function selectTokenUser(uid, data) {
      selectedTokenUser = { uid: uid, data: data || {} };
      var panel = document.getElementById('tokSelectedUserPanel');
      var nickEl = document.getElementById('tokSelectedNick');
      var uidEl = document.getElementById('tokSelectedUid');
      var balEl = document.getElementById('tokSelectedBalance');
      if (!panel) return;

      var nick = (data && (data.nick || data.displayName || data.email)) || uid;
      var balance = Number(data && data.tokens) || 0;

      if (nickEl) nickEl.textContent = nick;
      if (uidEl) uidEl.textContent = uid;
      if (balEl) balEl.textContent = balance.toLocaleString();
      panel.style.display = 'block';

      loadUserTokenHistory(uid);
      updateTokenAdjustUI();
      logTokenAudit({
        action: 'user_viewed',
        targetUid: uid,
        targetNick: nick,
        balanceAfter: balance,
        detail: 'Commander consultó ficha de tokens del usuario'
      });
    }

    function searchTokenUsers() {
      var input = document.getElementById('tokUserSearchInput');
      var resultsEl = document.getElementById('tokUserSearchResults');
      var btn = document.getElementById('tokUserSearchBtn');
      if (!input || !resultsEl) return;
      var q = (input.value || '').trim();
      if (!q) {
        resultsEl.innerHTML = '<div class="sec-empty">Escribe un nick o UID.</div>';
        return;
      }
      if (btn) btn.disabled = true;
      resultsEl.innerHTML = '<div class="sec-empty">Buscando…</div>';

      var usersRef = db.ref('users');
      var results = {};

      function finish() {
        var ids = Object.keys(results);
        if (!ids.length) {
          resultsEl.innerHTML = '<div class="sec-empty">No se encontraron usuarios.</div>';
          if (btn) btn.disabled = false;
          return;
        }
        resultsEl.innerHTML = ids.slice(0, 15).map(function(uid) {
          var d = results[uid] || {};
          var nick = d.nick || d.displayName || d.email || uid;
          var tokens = Number(d.tokens) || 0;
          return '<button type="button" class="tok-user-pick" data-uid="' + esc(uid) + '">' +
            '<span class="tok-user-pick-nick">' + esc(nick) + '</span>' +
            '<span class="tok-user-pick-meta">' + esc(uid) + ' · ' + tokens + ' tokens</span>' +
            '</button>';
        }).join('');
        resultsEl.querySelectorAll('.tok-user-pick').forEach(function(el) {
          el.addEventListener('mousedown', function(e) { e.preventDefault(); });
          el.addEventListener('click', function() {
            var uid = el.getAttribute('data-uid');
            selectTokenUser(uid, results[uid]);
          });
        });
        if (btn) btn.disabled = false;
      }

      if (q.length >= 6) {
        usersRef.child(q).once('value').then(function(snap) {
          if (snap.exists()) results[q] = snap.val();
          finish();
        }).catch(finish);
        return;
      }

      var qNorm = normalizeText(q);
      usersRef.orderByChild('nick_lowercase').startAt(qNorm).endAt(qNorm + '\uf8ff').limitToFirst(25).once('value')
        .then(function(snap) {
          if (snap.exists()) snap.forEach(function(c) { results[c.key] = c.val(); });
          return usersRef.orderByChild('registro').limitToLast(800).once('value');
        })
        .then(function(snap) {
          if (snap && snap.exists()) {
            snap.forEach(function(child) {
              if (results[child.key]) return;
              var d = child.val() || {};
              var fields = [d.nick, d.displayName, d.email, d.nick_lowercase, child.key];
              for (var i = 0; i < fields.length; i++) {
                if (fields[i] && normalizeText(String(fields[i])).indexOf(qNorm) !== -1) {
                  results[child.key] = d;
                  break;
                }
              }
            });
          }
          finish();
        })
        .catch(function(err) {
          console.error(err);
          resultsEl.innerHTML = '<div class="sec-empty">Error en la búsqueda.</div>';
          if (btn) btn.disabled = false;
        });
    }

    var REWARD_TYPE_LABELS = {
      honor: 'Honor comunitario',
      notification: 'Notificación especial',
      nexus_badge: 'Badge Creator Nexus',
      inventory: 'Ítem en inventario',
      internal_tag: 'Etiqueta VIP interna',
      tokens_bonus: 'Bonus masivo de tokens',
      nexus_xp: 'Experiencia Nexus Creator'
    };

    var rewardGrantsCache = {};
    var bossAlertsCache = {};
    var NEXUS_RANK_XP = [0, 500, 1500, 3000, 6000];

    function calcNexusLevelRank(xp) {
      var level = 1;
      var rank = 0;
      for (var i = NEXUS_RANK_XP.length - 1; i >= 0; i--) {
        if (xp >= NEXUS_RANK_XP[i]) {
          level = i + 1;
          rank = i;
          break;
        }
      }
      return { level: level, rank: rank };
    }

    function pushUserRewardNotification(uid, rewardType, detail, extraValue) {
      var typeLabel = REWARD_TYPE_LABELS[rewardType] || rewardType;
      var valuePart = extraValue ? (' (' + extraValue + ')') : '';
      return db.ref('users/' + uid + '/notifications').push({
        text: currentCommanderNick + ' te entregó: ' + typeLabel + valuePart + '. Motivo: ' + detail,
        icon: 'fa-gift',
        timestamp: Date.now(),
        read: false,
        type: 'commander_reward',
        fromCommander: true,
        commanderNick: currentCommanderNick,
        commanderUid: currentCommanderUid,
        rewardType: rewardType,
        rewardDetail: detail,
        rewardValue: extraValue || null
      });
    }

    function registerRewardGrant(payload) {
      return secRoot.child('rewardGrants').push({
        targetUid: payload.targetUid,
        targetNick: payload.targetNick,
        rewardType: payload.rewardType,
        rewardValue: payload.rewardValue || null,
        reason: payload.reason || '',
        detail: payload.detail || '',
        byUid: currentCommanderUid,
        byNick: currentCommanderNick,
        byRango: currentCommanderRango || 'commander',
        at: nowTs()
      });
    }

    function notifyBossOfCommanderReward(payload) {
      if (isBossActor()) return Promise.resolve();
      return secRoot.child('bossRewardAlerts').push({
        message: (currentCommanderNick || 'Commander') + ' entregó «' + (REWARD_TYPE_LABELS[payload.rewardType] || payload.rewardType) + '» a ' + (payload.targetNick || payload.targetUid) + (payload.rewardValue ? (' (' + payload.rewardValue + ')') : '') + '. Motivo: ' + (payload.reason || '—'),
        targetUid: payload.targetUid,
        targetNick: payload.targetNick,
        rewardType: payload.rewardType,
        rewardValue: payload.rewardValue || null,
        reason: payload.reason || '',
        byUid: currentCommanderUid,
        byNick: currentCommanderNick,
        at: nowTs(),
        read: false
      });
    }

    function recordRewardDelivery(uid, nick, type, value, detail, auditAction) {
      var skipUserNotif = type === 'notification';
      var tasks = [
        registerRewardGrant({ targetUid: uid, targetNick: nick, rewardType: type, rewardValue: value, reason: detail, detail: detail }),
        notifyBossOfCommanderReward({ targetUid: uid, targetNick: nick, rewardType: type, rewardValue: value, reason: detail }),
        logTokenAudit({
          action: auditAction || 'premium_grant',
          targetUid: uid,
          targetNick: nick,
          rewardType: type,
          rewardValue: value,
          rewardDetail: detail,
          reason: value ? (type + ': ' + value) : type
        })
      ];
      if (!skipUserNotif) tasks.push(pushUserRewardNotification(uid, type, detail, value));
      return Promise.all(tasks);
    }

    function renderRewardGrants() {
      var listEl = document.getElementById('tokRewardGrantsList');
      var countEl = document.getElementById('tokRewardGrantsCount');
      if (!listEl) return;
      var ids = Object.keys(rewardGrantsCache);
      if (countEl) countEl.textContent = ids.length + ' entregas';
      ids.sort(function(a, b) { return (rewardGrantsCache[b].at || 0) - (rewardGrantsCache[a].at || 0); });
      if (!ids.length) {
        listEl.innerHTML = '<div class="sec-empty">Sin entregas registradas aún.</div>';
        return;
      }
      listEl.innerHTML = ids.slice(0, 40).map(function(id) {
        var g = rewardGrantsCache[id];
        var typeLabel = REWARD_TYPE_LABELS[g.rewardType] || g.rewardType;
        return '<div class="tok-reward-grant-row">' +
          '<div class="tok-reward-grant-top">' +
          '<strong class="tok-reward-grant-user">' + esc(g.targetNick || g.targetUid) + '</strong>' +
          '<span class="tok-reward-grant-type">' + esc(typeLabel) + '</span>' +
          '<span class="tok-audit-time">' + fmtDate(g.at) + '</span>' +
          '</div>' +
          '<div class="tok-reward-grant-meta">Por: <strong>' + esc(g.byNick || g.byUid) + '</strong>' +
          (g.rewardValue ? (' · Valor: <strong>' + esc(String(g.rewardValue)) + '</strong>') : '') +
          '</div>' +
          '<div class="tok-reward-grant-reason"><i class="fas fa-quote-left"></i> ' + esc(g.reason || g.detail || '—') + '</div>' +
          '</div>';
      }).join('');
    }

    function renderBossRewardAlerts() {
      var panel = document.getElementById('tokBossAlertsPanel');
      var listEl = document.getElementById('tokBossAlertsList');
      var badge = document.getElementById('tokBossAlertsBadge');
      if (!panel || !listEl) return;
      if (!isBossActor()) {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = 'block';
      var ids = Object.keys(bossAlertsCache);
      var unread = ids.filter(function(id) { return !bossAlertsCache[id].read; }).length;
      if (badge) badge.textContent = unread > 0 ? String(unread) : '';
      ids.sort(function(a, b) { return (bossAlertsCache[b].at || 0) - (bossAlertsCache[a].at || 0); });
      if (!ids.length) {
        listEl.innerHTML = '<div class="sec-empty">Sin alertas de entregas de Commanders.</div>';
        return;
      }
      listEl.innerHTML = ids.slice(0, 25).map(function(id) {
        var a = bossAlertsCache[id];
        var unreadCls = a.read ? '' : ' tok-boss-alert-unread';
        return '<div class="tok-boss-alert-row' + unreadCls + '">' +
          '<div class="tok-boss-alert-msg">' + esc(a.message || '—') + '</div>' +
          '<div class="tok-boss-alert-meta">' + fmtDate(a.at) + ' · Commander: <strong>' + esc(a.byNick || a.byUid) + '</strong></div>' +
          '</div>';
      }).join('');
    }

    function grantNexusXP() {
      if (!isBossActor()) {
        showFloatingMessage('error', 'Solo Boss of the State puede otorgar XP Nexus.');
        return;
      }
      var amountEl = document.getElementById('tokNexusXpAmount');
      var reasonEl = document.getElementById('tokNexusXpReason');
      var amount = Math.abs(Number(amountEl && amountEl.value) || 0);
      var reason = (reasonEl && reasonEl.value || '').trim();
      if (!amount || amount < 1) {
        showFloatingMessage('error', 'Indica una cantidad válida de XP.');
        return;
      }
      if (amount > 5000) {
        showFloatingMessage('error', 'Máximo 5 000 XP por entrega.');
        return;
      }
      if (!reason) {
        showFloatingMessage('error', 'El motivo es obligatorio para auditoría.');
        return;
      }
      var targetUid = selectedTokenUser ? selectedTokenUser.uid : null;
      var targetNick = selectedTokenUser ? (selectedTokenUser.data.nick || selectedTokenUser.data.displayName || targetUid) : null;
      if (!targetUid) {
        showFloatingMessage('error', 'Selecciona un jugador en la búsqueda de arriba.');
        return;
      }
      if (targetUid === currentCommanderUid) {
        showFloatingMessage('error', 'No puedes otorgarte XP Nexus a ti mismo.');
        return;
      }
      if (!confirm('¿Otorgar +' + amount + ' XP Nexus a ' + targetNick + '?')) return;

      if (!tokFunctions) {
        showFloatingMessage('error', 'Cloud Functions no disponibles para XP Nexus.');
        return;
      }

      tokFunctions.httpsCallable('grantNexusXpCommander')({
        targetUid: targetUid,
        amount: amount,
        reason: reason
      }).then(function(result) {
        var data = result.data || {};
        var afterXp = Number(data.afterXp) || Number((data.stats || {}).xp) || 0;
        var level = Number(data.level) || Number((data.stats || {}).level) || 1;
        return recordRewardDelivery(targetUid, targetNick, 'nexus_xp', amount + ' XP', reason, 'nexus_xp_grant').then(function() {
          return { afterXp: afterXp, level: level };
        });
      }).then(function(meta) {
        if (reasonEl) reasonEl.value = '';
        renderRewardGrants();
        renderBossRewardAlerts();
        showFloatingMessage('success', '+' + amount + ' XP Nexus a ' + targetNick + ' (nivel ' + meta.level + ', total ' + meta.afterXp.toLocaleString() + ' XP)');
      }).catch(function(err) {
        console.error(err);
        var msg = 'Error al otorgar XP Nexus.';
        var code = err && err.code ? String(err.code) : '';
        if (code.indexOf('permission-denied') !== -1) {
          msg = err.message || 'Sin permiso. Solo Boss of the State puede otorgar XP Nexus.';
        } else if (code.indexOf('resource-exhausted') !== -1) {
          msg = err.message || 'Tope diario de XP Nexus alcanzado.';
        } else if (code.indexOf('invalid-argument') !== -1) {
          msg = err.message || 'Datos inválidos para otorgar XP.';
        }
        showFloatingMessage('error', msg);
      });
    }

    function grantNexusXpBoost() {
      var reasonEl = document.getElementById('tokNexusXpReason');
      var reason = (reasonEl && reasonEl.value || '').trim();
      if (!reason) {
        showFloatingMessage('error', 'El motivo es obligatorio para auditoría del boost.');
        return;
      }
      var targetUid = selectedTokenUser ? selectedTokenUser.uid : null;
      var targetNick = selectedTokenUser ? (selectedTokenUser.data.nick || selectedTokenUser.data.displayName || targetUid) : null;
      if (!targetUid) {
        showFloatingMessage('error', 'Selecciona un jugador en la búsqueda de arriba.');
        return;
      }
      if (targetUid === currentCommanderUid) {
        showFloatingMessage('error', 'No puedes otorgarte boost Nexus a ti mismo.');
        return;
      }
      if (!confirm('¿Otorgar boost XP x2 (1 hora) a ' + targetNick + '?')) return;

      if (!tokFunctions) {
        showFloatingMessage('error', 'Cloud Functions no disponibles para boost Nexus.');
        return;
      }

      tokFunctions.httpsCallable('grantNexusXpBoostCommander')({
        targetUid: targetUid,
        reason: reason,
        durationMinutes: 60
      }).then(function(result) {
        var data = result.data || {};
        return recordRewardDelivery(targetUid, targetNick, 'nexus_xp_boost', 'Boost x2 · 1h', reason, 'nexus_xp_boost').then(function() {
          return data;
        });
      }).then(function(data) {
        if (reasonEl) reasonEl.value = '';
        renderRewardGrants();
        renderBossRewardAlerts();
        showFloatingMessage('success', 'Boost x2 otorgado a ' + targetNick + ' hasta ' + new Date(data.expiresAt).toLocaleTimeString('es-ES'));
      }).catch(function(err) {
        console.error(err);
        var msg = 'Error al otorgar boost Nexus.';
        var code = err && err.code ? String(err.code) : '';
        if (code.indexOf('permission-denied') !== -1) {
          msg = 'Sin permiso. Solo Commanders/Boss pueden otorgar boost.';
        } else if (code.indexOf('invalid-argument') !== -1) {
          msg = err.message || 'Datos inválidos para el boost.';
        }
        showFloatingMessage('error', msg);
      });
    }

    function adjustUserTokens(sign) {
      if (!selectedTokenUser) {
        showFloatingMessage('error', 'Selecciona un usuario primero.');
        return;
      }
      if (!canModifyTargetTokens(selectedTokenUser.uid, selectedTokenUser.data)) {
        showFloatingMessage('error', 'Rango protegido. Solo Boss of the State puede modificar sus tokens.');
        return;
      }
      var amountEl = document.getElementById('tokAdjustAmount');
      var reasonEl = document.getElementById('tokAdjustReason');
      var amount = Math.abs(Number(amountEl && amountEl.value) || 0);
      var reason = (reasonEl && reasonEl.value || '').trim();
      var delta = sign > 0 ? amount : -amount;
      if (!amount || amount < 1) {
        showFloatingMessage('error', 'Indica una cantidad válida.');
        return;
      }
      if (!reason) {
        showFloatingMessage('error', 'El motivo es obligatorio para auditoría.');
        return;
      }
      if (delta < 0 && !confirm('¿Descontar ' + amount + ' tokens a ' + (selectedTokenUser.data.nick || selectedTokenUser.uid) + '?')) return;
      if (delta > 0 && amount >= 500 && !confirm('¿Agregar ' + amount + ' tokens? Esta acción quedará registrada.')) return;

      var uid = selectedTokenUser.uid;
      var nick = selectedTokenUser.data.nick || selectedTokenUser.data.displayName || uid;
      var tokenRef = db.ref('users/' + uid + '/tokens');

      tokenRef.transaction(function(current) {
        var bal = Number(current) || 0;
        var next = bal + delta;
        if (next < 0) return;
        return next;
      }).then(function(result) {
        if (!result.committed) {
          showFloatingMessage('error', 'No se pudo actualizar (saldo insuficiente o error).');
          return;
        }
        var before = Number(result.snapshot.val()) - delta;
        var after = Number(result.snapshot.val());
        var type = isBossActor()
          ? (delta > 0 ? 'boss_credit' : 'boss_debit')
          : (delta > 0 ? 'commander_credit' : 'commander_debit');
        var action = delta > 0 ? 'token_add' : 'token_remove';

        return Promise.all([
          writeUserLedger(uid, { type: type, amount: delta, balanceBefore: before, balanceAfter: after, reason: reason }),
          logTokenAudit({ action: action, targetUid: uid, targetNick: nick, amount: delta, balanceBefore: before, balanceAfter: after, reason: reason })
        ]).then(function() {
          selectedTokenUser.data.tokens = after;
          document.getElementById('tokSelectedBalance').textContent = after.toLocaleString();
          usersTokenCache = [];
          renderTopTokenHolders(true);
          loadUserTokenHistory(uid);
          refreshGlobalStats();
          showFloatingMessage('success', (delta > 0 ? 'Tokens agregados: +' : 'Tokens descontados: ') + amount);
        });
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'Error al ajustar tokens.');
      });
    }

    function deliverPremiumReward() {
      if (!selectedTokenUser) {
        showFloatingMessage('error', 'Selecciona un usuario en la búsqueda.');
        return;
      }
      if (!canModifyTargetTokens(selectedTokenUser.uid, selectedTokenUser.data)) {
        showFloatingMessage('error', 'Rango protegido. Solo Boss of the State puede entregar recompensas.');
        return;
      }
      var typeEl = document.getElementById('tokRewardType');
      var valueEl = document.getElementById('tokRewardValue');
      var detailEl = document.getElementById('tokRewardDetail');
      var amountEl = document.getElementById('tokAdjustAmount');
      var type = typeEl ? typeEl.value : '';
      var value = (valueEl && valueEl.value || '').trim();
      var detail = (detailEl && detailEl.value || '').trim();
      if (!detail) {
        showFloatingMessage('error', 'Describe la entrega en el campo de detalle.');
        return;
      }

      var uid = selectedTokenUser.uid;
      var nick = selectedTokenUser.data.nick || selectedTokenUser.data.displayName || uid;
      var ops = [];

      if (type === 'honor') {
        var pts = Number(value) || 0;
        if (pts < 1) { showFloatingMessage('error', 'Indica puntos de honor en Valor.'); return; }
        ops.push(db.ref('users/' + uid + '/communityHonor').transaction(function(cur) {
          return (Number(cur) || 0) + pts;
        }));
      } else if (type === 'notification') {
        ops.push(db.ref('users/' + uid + '/notifications').push({
          text: detail,
          icon: 'fa-gem',
          timestamp: Date.now(),
          read: false,
          type: 'commander_reward',
          fromCommander: true,
          commanderNick: currentCommanderNick,
          commanderUid: currentCommanderUid,
          rewardType: type,
          rewardDetail: detail
        }));
      } else if (type === 'nexus_badge') {
        var badgeId = value || 'commander_grant';
        ops.push(db.ref('nexus/users/' + uid + '/badges').transaction(function(cur) {
          var arr = Array.isArray(cur) ? cur.slice() : [];
          if (arr.indexOf(badgeId) === -1) arr.push(badgeId);
          return arr;
        }));
      } else if (type === 'inventory') {
        var itemName = value || 'Premio StudiosGamesRS';
        if (!tokFunctions) {
          showFloatingMessage('error', 'Cloud Functions no disponibles.');
          return;
        }
        if (!confirm('¿Entregar «' + (REWARD_TYPE_LABELS[type] || type) + '» a ' + nick + '?\n\nMotivo: ' + detail)) return;
        tokFunctions.httpsCallable('grantUserInventoryItem')({
          targetUid: uid,
          name: itemName,
          description: detail
        }).then(function() {
          return Promise.all([
            recordRewardDelivery(uid, nick, type, value, detail, 'premium_grant'),
            writeUserLedger(uid, {
              type: 'premium_grant',
              amount: null,
              balanceBefore: Number(selectedTokenUser.data.tokens) || 0,
              balanceAfter: Number(selectedTokenUser.data.tokens) || 0,
              reason: detail,
              rewardType: type,
              rewardValue: value
            })
          ]);
        }).then(function() {
          loadUserTokenHistory(uid);
          renderRewardGrants();
          renderBossRewardAlerts();
          showFloatingMessage('success', 'Recompensa entregada a ' + nick + ' — registrada en el log.');
          if (detailEl) detailEl.value = '';
        }).catch(function(err) {
          console.error(err);
          showFloatingMessage('error', 'No se pudo entregar el ítem de inventario.');
        });
        return;
      } else if (type === 'internal_tag') {
        ops.push(db.ref('users/' + uid + '/internalTag').set(value || 'VIP SGRS'));
      } else if (type === 'tokens_bonus') {
        var bonus = Number(value) || 0;
        if (bonus < 1) { showFloatingMessage('error', 'Indica cantidad de tokens en Valor.'); return; }
        if (amountEl) amountEl.value = String(bonus);
        adjustUserTokens(1);
        return;
      } else {
        showFloatingMessage('error', 'Tipo de entrega no válido.');
        return;
      }

      if (!confirm('¿Entregar «' + (REWARD_TYPE_LABELS[type] || type) + '» a ' + nick + '?\n\nMotivo: ' + detail)) return;

      Promise.all(ops).then(function() {
        return Promise.all([
          recordRewardDelivery(uid, nick, type, value, detail, 'premium_grant'),
          writeUserLedger(uid, {
            type: 'premium_grant',
            amount: null,
            balanceBefore: Number(selectedTokenUser.data.tokens) || 0,
            balanceAfter: Number(selectedTokenUser.data.tokens) || 0,
            reason: detail,
            rewardType: type,
            rewardValue: value
          })
        ]);
      }).then(function() {
        loadUserTokenHistory(uid);
        renderRewardGrants();
        renderBossRewardAlerts();
        showFloatingMessage('success', 'Recompensa entregada a ' + nick + ' — registrada en el log.');
        if (detailEl) detailEl.value = '';
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'No se pudo entregar la recompensa.');
      });
    }

    secRoot.child('tokenAuditLog').limitToLast(120).on('value', function(snap) {
      tokenAuditCache = snap.val() || {};
      renderTokenAudit();
    });

    secRoot.child('rewardGrants').limitToLast(80).on('value', function(snap) {
      rewardGrantsCache = snap.val() || {};
      renderRewardGrants();
    });

    secRoot.child('bossRewardAlerts').limitToLast(40).on('value', function(snap) {
      bossAlertsCache = snap.val() || {};
      renderBossRewardAlerts();
    });

    var refreshBtn = document.getElementById('tokStatsRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshGlobalStats);

    var topRefreshBtn = document.getElementById('tokTopHoldersRefreshBtn');
    if (topRefreshBtn) topRefreshBtn.addEventListener('click', function() { renderTopTokenHolders(true); });

    var claimBossBtn = document.getElementById('tokClaimBossBtn');
    if (claimBossBtn) claimBossBtn.addEventListener('click', claimBossOfTheState);

    loadBossStateConfig();
    renderTopTokenHolders(false);

    var searchBtn = document.getElementById('tokUserSearchBtn');
    var searchInput = document.getElementById('tokUserSearchInput');
    if (searchBtn) searchBtn.addEventListener('click', searchTokenUsers);
    if (searchInput) {
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') searchTokenUsers();
      });
    }

    var addBtn = document.getElementById('tokAddBtn');
    var removeBtn = document.getElementById('tokRemoveBtn');
    if (addBtn) addBtn.addEventListener('click', function() { adjustUserTokens(1); });
    if (removeBtn) removeBtn.addEventListener('click', function() { adjustUserTokens(-1); });

    var deliverBtn = document.getElementById('tokRewardDeliverBtn');
    if (deliverBtn) deliverBtn.addEventListener('click', deliverPremiumReward);

    var nexusXpBtn = document.getElementById('tokNexusXpGrantBtn');
    if (nexusXpBtn) nexusXpBtn.addEventListener('click', grantNexusXP);
    var nexusBoostBtn = document.getElementById('tokNexusBoostGrantBtn');
    if (nexusBoostBtn) nexusBoostBtn.addEventListener('click', grantNexusXpBoost);

    syncNexusXpBossUi();

    document.querySelectorAll('[data-tok-filter]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('[data-tok-filter]').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        tokenAuditFilter = btn.getAttribute('data-tok-filter') || 'all';
        renderTokenAudit();
      });
    });

    onTokensTabOpen = function() {
      loadBossStateConfig().then(function() {
        refreshGlobalStats();
        renderTopTokenHolders(true);
        renderRewardGrants();
        renderBossRewardAlerts();
      });
      logTokenAudit({ action: 'tokens_tab_open', detail: 'Commander abrió la pestaña Tokens' });
    };
  }

  // -------------------------------------------------
  // TORNEOS: centro compartido con Competition Hub (SGTournamentOrganizer)
  // -------------------------------------------------
  function initTournamentsHub() {
    if (!db || !window.SGTournamentOrganizer) return;

    function escPlain(s) {
      if (s == null) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function commanderCanOrganize(ud) {
      if (!ud || !ud.rango) return false;
      var r = String(ud.rango).toLowerCase().replace(/\s+/g, '_');
      return r === 'commander' || r === 'divisional_commander' || r === 'boss_of_the_state';
    }

    window.SGTournamentOrganizer.init({
      getUser: function () {
        return (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
      },
      getUserData: function () {
        return { rango: currentCommanderRango, nick: currentCommanderNick };
      },
      canOrganize: commanderCanOrganize,
      sanitizeText: escPlain,
      notify: function (type, msg) { showFloatingMessage(type, msg); },
      fnError: function (err, fallback) {
        return (err && err.message) ? err.message : fallback;
      },
      onTournamentCreated: function () {
        window.SGTournamentOrganizer.refreshCommanderTournaments();
      }
    });

    var createBtn = document.getElementById('cmdTourCreateBtn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        window.SGTournamentOrganizer.openCreate();
      });
    }
  }

  // -------------------------------------------------
  // CREATOR MARKET: solicitudes, aprobaciones, escáner Facebook, publicaciones
  // Datos: nexus/creatorApplications, creatorMarket/publications, nexus/users/{uid}/creatorMarket
  // -------------------------------------------------
  var onCreatorsTabOpen = null;

  function initCreatorMarketHub() {
    if (!db) return;
    var appsCache = {};
    var pubsCache = {};
    var queueCache = {};
    var fbConfigCache = {};
    var cmFunctions = (typeof firebase !== 'undefined' && firebase.functions) ? firebase.functions() : null;

    function escCm(s) {
      if (s == null) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function fmtCmDate(ms) {
      if (!ms || typeof ms !== 'number') return '—';
      return new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function notifyUser(uid, text, icon) {
      return db.ref('users/' + uid + '/notifications').push({
        text: text,
        icon: icon || 'fa-store',
        timestamp: Date.now(),
        read: false,
        fromCommander: true,
        commanderNick: currentCommanderNick
      });
    }

    function renderSubmissionQueue() {
      var listEl = document.getElementById('cmSubmissionQueueList');
      var countEl = document.getElementById('cmContentPendingCount');
      if (!listEl) return;
      var items = [];
      Object.keys(queueCache).forEach(function(uid) {
        var userQueue = queueCache[uid] || {};
        Object.keys(userQueue).forEach(function(submissionId) {
          items.push({ uid: uid, submissionId: submissionId, data: userQueue[submissionId] || {} });
        });
      });
      items.sort(function(a, b) {
        return (b.data.createdAt || 0) - (a.data.createdAt || 0);
      });
      if (countEl) countEl.textContent = String(items.length);
      updateCreatorMarketTabLabel();
      if (!items.length) {
        listEl.innerHTML = '<div class="sec-empty">No hay contenido pendiente de publicar.</div>';
        return;
      }
      listEl.innerHTML = items.map(function(item) {
        var d = item.data;
        var mediaBlock = '';
        if (d.mediaUrl) {
          if (d.mediaType === 'video') {
            mediaBlock = '<div class="cm-cmd-queue-media"><video controls playsinline src="' + escCm(d.mediaUrl) + '"></video></div>';
          } else {
            mediaBlock = '<div class="cm-cmd-queue-media"><a href="' + escCm(d.mediaUrl) + '" target="_blank" rel="noopener"><img src="' + escCm(d.mediaUrl) + '" alt=""></a></div>';
          }
        }
        var insightLine = d.insightScore != null ? ('<div class="cm-cmd-app-detail">Potencial estimado (ref.): <strong>' + d.insightScore + '/100</strong></div>') : '';
        return '<div class="cm-cmd-app-row cm-cmd-app-pending">' +
          '<div class="cm-cmd-app-top"><strong>' + escCm(d.title || 'Sin título') + '</strong>' +
          '<span class="cm-cmd-app-status">PENDIENTE</span></div>' +
          '<div class="cm-cmd-app-meta">' + escCm(d.authorName || item.uid) + ' · ' + fmtCmDate(d.createdAt) + '</div>' +
          '<div class="cm-cmd-app-detail">' + escCm((d.caption || '').slice(0, 280)) + '</div>' +
          insightLine +
          mediaBlock +
          (d.mediaUrl ? '<div class="cm-cmd-app-detail"><a href="' + escCm(d.mediaUrl) + '" target="_blank" rel="noopener">Ver archivo en StudiosGamesRS</a></div>' : '') +
          '<div class="cm-cmd-app-actions">' +
          '<button type="button" class="comms-btn comms-btn-primary cm-publish-btn" data-uid="' + escCm(item.uid) + '" data-submission="' + escCm(item.submissionId) + '"><i class="fab fa-facebook"></i> Aprobar y publicar</button>' +
          '<button type="button" class="comms-btn comms-btn-danger cm-reject-content-btn" data-uid="' + escCm(item.uid) + '" data-submission="' + escCm(item.submissionId) + '"><i class="fas fa-times"></i> Rechazar</button>' +
          '</div></div>';
      }).join('');

      listEl.querySelectorAll('.cm-publish-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          publishCreatorContent(btn.getAttribute('data-uid'), btn.getAttribute('data-submission'), btn);
        });
      });
      listEl.querySelectorAll('.cm-reject-content-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          rejectCreatorContent(btn.getAttribute('data-uid'), btn.getAttribute('data-submission'));
        });
      });
    }

    function publishCreatorContent(uid, submissionId, btn) {
      if (!cmFunctions) {
        showFloatingMessage('error', 'Firebase Functions no disponible.');
        return;
      }
      if (!confirm('¿Publicar este contenido en la página de Facebook de StudiosGamesRS?')) return;
      var orig = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Publicando…'; }
      cmFunctions.httpsCallable('publishCreatorContent')({ uid: uid, submissionId: submissionId })
        .then(function(res) {
          showFloatingMessage('success', 'Publicado en Facebook. Enlace: ' + (res.data && res.data.facebookPostUrl ? 'listo' : 'ok'));
          if (res.data && res.data.facebookPostUrl) {
            window.open(res.data.facebookPostUrl, '_blank');
          }
        })
        .catch(function(err) {
          console.error(err);
          showFloatingMessage('error', (err && err.message) || 'No se pudo publicar.');
        })
        .finally(function() {
          if (btn) { btn.disabled = false; btn.innerHTML = orig; }
        });
    }

    function rejectCreatorContent(uid, submissionId) {
      if (!cmFunctions) {
        showFloatingMessage('error', 'Firebase Functions no disponible.');
        return;
      }
      var note = prompt('Motivo del rechazo (opcional):', '');
      if (note === null) return;
      cmFunctions.httpsCallable('rejectCreatorContent')({ uid: uid, submissionId: submissionId, note: note })
        .then(function() {
          showFloatingMessage('success', 'Envío rechazado.');
        })
        .catch(function(err) {
          console.error(err);
          showFloatingMessage('error', (err && err.message) || 'No se pudo rechazar.');
        });
    }

    function updateCreatorMarketTabLabel() {
      var pendingApps = Object.keys(appsCache).filter(function(id) { return appsCache[id].status === 'pending'; }).length;
      var queueItems = 0;
      Object.keys(queueCache).forEach(function(uid) {
        queueItems += Object.keys(queueCache[uid] || {}).length;
      });
      var creatorsTab = document.querySelector('.commander-tab[data-tab="creators"] span');
      if (!creatorsTab) return;
      var parts = [];
      if (pendingApps) parts.push(pendingApps + ' sol.');
      if (queueItems) parts.push(queueItems + ' envío' + (queueItems === 1 ? '' : 's'));
      creatorsTab.textContent = parts.length ? ('Creator Market (' + parts.join(' · ') + ')') : 'Creator Market';
    }

    function renderApplications() {
      var listEl = document.getElementById('cmApplicationsList');
      var countEl = document.getElementById('cmAppsPendingCount');
      if (!listEl) return;
      var ids = Object.keys(appsCache);
      var pending = ids.filter(function(id) { return appsCache[id].status === 'pending'; });
      if (countEl) countEl.textContent = String(pending.length);
      updateCreatorMarketTabLabel();
      ids.sort(function(a, b) {
        var pa = appsCache[a].status === 'pending' ? 0 : 1;
        var pb = appsCache[b].status === 'pending' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return (appsCache[b].submittedAt || 0) - (appsCache[a].submittedAt || 0);
      });
      if (!ids.length) {
        listEl.innerHTML = '<div class="sec-empty">No hay solicitudes de Creator Market.</div>';
        return;
      }
      listEl.innerHTML = ids.map(function(uid) {
        var a = appsCache[uid];
        var q = a.questionnaire || {};
        var st = a.status || 'pending';
        var stLabel = st === 'pending' ? 'PENDIENTE' : st === 'approved' ? 'APROBADO' : 'RECHAZADO';
        var actions = '';
        if (st === 'pending') {
          actions = '<div class="cm-cmd-app-actions">' +
            (uid === currentCommanderUid ? '<span class="cm-self-app-hint">Tu solicitud — puedes auto-aprobar</span>' : '') +
            '<button type="button" class="comms-btn comms-btn-primary cm-approve-btn" data-uid="' + escCm(uid) + '"><i class="fas fa-check"></i> Aprobar</button>' +
            '<button type="button" class="comms-btn comms-btn-danger cm-reject-btn" data-uid="' + escCm(uid) + '"><i class="fas fa-times"></i> Rechazar</button>' +
            '</div>';
        }
        return '<div class="cm-cmd-app-row cm-cmd-app-' + st + '">' +
          '<div class="cm-cmd-app-top"><strong>' + escCm(a.nick || uid) + '</strong>' +
          '<span class="cm-cmd-app-status">' + stLabel + '</span></div>' +
          '<div class="cm-cmd-app-meta">UID: ' + escCm(uid) + ' · ' + fmtCmDate(a.submittedAt) + '</div>' +
          '<div class="cm-cmd-app-fb"><i class="fab fa-facebook"></i> <strong>' + escCm(q.facebookProfileName) + '</strong> · ' + escCm(q.facebookProfileUrl) + '</div>' +
          '<div class="cm-cmd-app-detail">Tipo: ' + escCm(q.contentType) + ' · Frecuencia: ' + escCm(q.postingFrequency) + '</div>' +
          '<div class="cm-cmd-app-detail">Experiencia: ' + escCm((q.experience || '').slice(0, 200)) + '</div>' +
          '<div class="cm-cmd-app-detail">Motivación: ' + escCm((q.motivation || '').slice(0, 200)) + '</div>' +
          actions + '</div>';
      }).join('');

      listEl.querySelectorAll('.cm-approve-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { approveApplication(btn.getAttribute('data-uid')); });
      });
      listEl.querySelectorAll('.cm-reject-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { rejectApplication(btn.getAttribute('data-uid')); });
      });
    }

    function approveApplication(uid) {
      var app = appsCache[uid];
      if (!app || app.status !== 'pending') {
        showFloatingMessage('error', 'Solicitud no pendiente o no encontrada.');
        return;
      }
      var q = app.questionnaire || {};
      var isSelf = uid === currentCommanderUid;
      var confirmMsg = isSelf
        ? '¿Auto-aprobarte como creador en Creator Market?\n\nFacebook: ' + (q.facebookProfileName || '—')
        : '¿Aprobar a ' + (app.nick || uid) + ' en Creator Market?\n\nFacebook: ' + (q.facebookProfileName || '—');
      if (!confirm(confirmMsg)) return;
      var reviewedAt = Date.now();
      db.ref('nexus/creatorApplications/' + uid).update({
        status: 'approved',
        reviewedAt: reviewedAt,
        reviewedByUid: currentCommanderUid,
        reviewedByNick: currentCommanderNick,
        facebookLinked: {
          profileName: q.facebookProfileName,
          profileUrl: q.facebookProfileUrl,
          linkedAt: reviewedAt
        }
      }).then(function() {
        return db.ref('nexus/users/' + uid + '/creatorMarket').set({
          applicationStatus: 'approved',
          approvedAt: reviewedAt,
          approvedBy: currentCommanderNick,
          facebookProfileName: q.facebookProfileName,
          facebookProfileUrl: q.facebookProfileUrl,
          totalEarnings: 0,
          pendingEarnings: 0
        });
      }).then(function() {
        return notifyUser(uid, '¡Aprobado en Creator Market! Tu Facebook está enlazado. Ya puedes subir contenido y ganar dinero por publicaciones.', 'fa-store');
      }).then(function() {
        showFloatingMessage('success', (isSelf ? 'Te aprobaste como creador' : 'Creador aprobado') + ': ' + (app.nick || uid));
      }).catch(function(err) {
        console.error('approveApplication:', err);
        showFloatingMessage('error', 'No se pudo aprobar: ' + (err && err.message ? err.message : 'revisa permisos Firebase'));
      });
    }

    function rejectApplication(uid) {
      var app = appsCache[uid];
      if (!app || app.status !== 'pending') return;
      var note = window.prompt('Motivo del rechazo (visible para el usuario):', '');
      if (note == null) return;
      db.ref('nexus/creatorApplications/' + uid).update({
        status: 'rejected',
        reviewedAt: firebase.database.ServerValue.TIMESTAMP,
        reviewedByUid: currentCommanderUid,
        reviewedByNick: currentCommanderNick,
        reviewNote: String(note).trim() || 'No aprobado en esta ocasión.'
      }).then(function() {
        return db.ref('nexus/users/' + uid + '/creatorMarket').update({ applicationStatus: 'rejected' });
      }).then(function() {
        return notifyUser(uid, 'Tu solicitud de Creator Market no fue aprobada. Motivo: ' + (note || '—'), 'fa-store');
      }).then(function() {
        showFloatingMessage('success', 'Solicitud rechazada.');
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'Error al rechazar.');
      });
    }

    function calcEarnings(views, likes, comments, mediaType, videoPlays) {
      var v = Number(views) || 0;
      var plays = Number(videoPlays) || v;
      if (mediaType === 'video') {
        return Math.round((plays / 1000) * 0.60 * 100) / 100;
      }
      return Math.round((v / 1000) * 0.67 * 100) / 100;
    }

    function renderPublicationsAdmin() {
      var listEl = document.getElementById('cmPublicationsAdminList');
      if (!listEl) return;
      var ids = Object.keys(pubsCache);
      ids.sort(function(a, b) { return (pubsCache[b].publishedAt || 0) - (pubsCache[a].publishedAt || 0); });
      if (!ids.length) {
        listEl.innerHTML = '<div class="sec-empty">Sin publicaciones registradas.</div>';
        return;
      }
      listEl.innerHTML = ids.map(function(id) {
        var p = pubsCache[id];
        var m = p.metrics || {};
        var e = p.earnings || {};
        var live = p.status === 'live' && m.fbLive !== false;
        var removed = p.status === 'removed' || m.fbLive === false;
        return '<div class="cm-cmd-pub-row' + (live ? ' cm-cmd-pub-live' : '') + '" data-pub-id="' + escCm(id) + '">' +
          '<div class="cm-cmd-pub-top"><strong>' + escCm(p.title || 'Publicación') + '</strong>' +
          '<span>' + escCm(p.authorNick || p.authorUid) + '</span>' +
          (live ? '<span class="cm-pub-live"><i class="fas fa-circle"></i> VIVO</span>' : '') +
          (removed ? '<span class="cm-pub-status cm-pub-status-removed"><i class="fas fa-ban"></i> BAJA</span>' : '') + '</div>' +
          '<div class="cm-cmd-pub-metrics-form">' +
          '<label>Vistas <input type="number" class="comms-input cm-metric-input" data-pub="' + escCm(id) + '" data-metric="views" value="' + (m.views || 0) + '" min="0"></label>' +
          '<label>Plays <input type="number" class="comms-input cm-metric-input" data-pub="' + escCm(id) + '" data-metric="videoPlays" value="' + (m.videoPlays || 0) + '" min="0"></label>' +
          '<label>Me gusta <input type="number" class="comms-input cm-metric-input" data-pub="' + escCm(id) + '" data-metric="likes" value="' + (m.likes || 0) + '" min="0"></label>' +
          '<label>Comentarios <input type="number" class="comms-input cm-metric-input" data-pub="' + escCm(id) + '" data-metric="comments" value="' + (m.comments || 0) + '" min="0"></label>' +
          '<label>Pago $ <input type="number" class="comms-input cm-metric-input" data-pub="' + escCm(id) + '" data-metric="earnings" value="' + (e.amount != null ? e.amount : calcEarnings(m.views, m.likes, m.comments, p.mediaType, m.videoPlays)) + '" min="0" step="0.01"></label>' +
          '</div>' +
          '<div class="cm-cmd-pub-actions">' +
          '<button type="button" class="comms-btn comms-btn-primary cm-save-metrics-btn" data-pub="' + escCm(id) + '"><i class="fas fa-save"></i> Guardar métricas</button>' +
          '<button type="button" class="comms-btn comms-btn-ghost cm-close-pub-btn" data-pub="' + escCm(id) + '"><i class="fas fa-stop"></i> Cerrar</button>' +
          '</div>' +
          '<div class="cm-cmd-pub-meta">Actualizado: ' + fmtCmDate(m.lastUpdatedAt) +
          (m.scanStatus === 'facebook_api' ? ' · <span class="cm-metric-source">Facebook API</span>' : '') +
          (p.facebookPostUrl ? ' · <a href="' + escCm(p.facebookPostUrl) + '" target="_blank" rel="noopener">Ver en Facebook</a>' : '') + '</div>' +
          '</div>';
      }).join('');

      listEl.querySelectorAll('.cm-save-metrics-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { savePublicationMetrics(btn.getAttribute('data-pub')); });
      });
      listEl.querySelectorAll('.cm-close-pub-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { closePublication(btn.getAttribute('data-pub')); });
      });
    }

    function savePublicationMetrics(pubId) {
      var row = document.querySelector('.cm-cmd-pub-row[data-pub-id="' + pubId + '"]');
      if (!row) return;
      var p = pubsCache[pubId] || {};
      var views = Number(row.querySelector('[data-metric="views"]')?.value) || 0;
      var videoPlays = Number(row.querySelector('[data-metric="videoPlays"]')?.value) || 0;
      var likes = Number(row.querySelector('[data-metric="likes"]')?.value) || 0;
      var comments = Number(row.querySelector('[data-metric="comments"]')?.value) || 0;
      var earnings = Number(row.querySelector('[data-metric="earnings"]')?.value);
      if (isNaN(earnings)) earnings = calcEarnings(views, likes, comments, p.mediaType, videoPlays);
      db.ref('creatorMarket/publications/' + pubId).update({
        metrics: { views: views, videoPlays: videoPlays, likes: likes, comments: comments, lastUpdatedAt: Date.now(), scanStatus: 'manual' },
        earnings: { amount: earnings, currency: 'USD', status: p.earnings?.status || 'pending', calculatedAt: Date.now() }
      }).then(function() {
        return updateCreatorEarnings(p.authorUid);
      }).then(function() {
        showFloatingMessage('success', 'Métricas guardadas.');
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'Error al guardar métricas.');
      });
    }

    function updateCreatorEarnings(uid) {
      if (!uid) return Promise.resolve();
      var total = 0;
      var pending = 0;
      Object.keys(pubsCache).forEach(function(id) {
        var p = pubsCache[id];
        if (p.authorUid !== uid) return;
        var amt = Number(p.earnings?.amount) || 0;
        if (p.earnings?.status === 'paid') total += amt;
        else pending += amt;
      });
      return db.ref('nexus/users/' + uid + '/creatorMarket').update({ totalEarnings: total, pendingEarnings: pending });
    }

    function closePublication(pubId) {
      if (!confirm('¿Cerrar esta publicación y finalizar el monitoreo en vivo?')) return;
      db.ref('creatorMarket/publications/' + pubId).update({ status: 'closed', closedAt: Date.now() });
    }

    function renderPendingPayouts() {
      var block = document.getElementById('cmBossPayoutsBlock');
      var listEl = document.getElementById('cmPendingPayoutsList');
      var countEl = document.getElementById('cmPayoutsPendingCount');
      var isBoss = isBossOfTheStateRango(currentCommanderRango);
      if (block) block.style.display = isBoss ? 'block' : 'none';
      if (!isBoss || !listEl) return;
      if (!cmFunctions) {
        listEl.innerHTML = '<div class="sec-empty">Firebase Functions no disponible.</div>';
        return;
      }
      listEl.innerHTML = '<div class="sec-empty">Cargando pagos pendientes…</div>';
      cmFunctions.httpsCallable('listCreatorPendingPayouts')({})
        .then(function(res) {
          var items = (res.data && res.data.items) || [];
          if (countEl) countEl.textContent = String(items.length);
          if (!items.length) {
            listEl.innerHTML = '<div class="sec-empty">No hay ingresos pendientes de verificación.</div>';
            return;
          }
          listEl.innerHTML = items.map(function(item) {
            var amt = Number(item.amount) || 0;
            var tokens = Number(item.tokens) || 0;
            var amountLine = amt > 0 ? ('+$' + amt.toFixed(2)) : '';
            if (tokens > 0) amountLine += (amountLine ? ' · ' : '') + ('+' + tokens + ' tokens');
            var pubLine = item.publicationTitle
              ? ('<div class="cm-cmd-app-detail"><i class="fas fa-file-alt"></i> ' + escCm(item.publicationTitle) + '</div>')
              : '';
            var pubLink = item.publicationId && pubsCache[item.publicationId] && pubsCache[item.publicationId].facebookPostUrl
              ? ('<div class="cm-cmd-app-detail"><a href="' + escCm(pubsCache[item.publicationId].facebookPostUrl) + '" target="_blank" rel="noopener">Ver publicación en Facebook</a></div>')
              : '';
            return '<div class="cm-cmd-app-row cm-cmd-app-pending">' +
              '<div class="cm-cmd-app-top"><strong>' + escCm(item.nick || item.uid) + '</strong>' +
              '<span class="cm-cmd-app-status">' + escCm(amountLine || '—') + '</span></div>' +
              '<div class="cm-cmd-app-meta">UID: ' + escCm(item.uid) + ' · ' + fmtCmDate(item.createdAt) + '</div>' +
              '<div class="cm-cmd-app-detail">' + escCm(item.reason || 'Movimiento Creator Market') + '</div>' +
              pubLine + pubLink +
              '<div class="cm-cmd-app-actions">' +
              '<button type="button" class="comms-btn comms-btn-primary cm-approve-payout-btn" data-uid="' + escCm(item.uid) + '" data-ledger="' + escCm(item.ledgerId) + '"><i class="fas fa-check"></i> Verificar pago</button>' +
              '</div></div>';
          }).join('');
          listEl.querySelectorAll('.cm-approve-payout-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              approveCreatorPayout(btn.getAttribute('data-uid'), btn.getAttribute('data-ledger'), btn);
            });
          });
        })
        .catch(function(err) {
          console.error(err);
          listEl.innerHTML = '<div class="sec-empty">' + escCm((err && err.message) || 'No se pudieron cargar los pagos.') + '</div>';
        });
    }

    function approveCreatorPayout(uid, ledgerId, btn) {
      if (!cmFunctions) {
        showFloatingMessage('error', 'Firebase Functions no disponible.');
        return;
      }
      if (!confirm('¿Verificar este ingreso del creador? Quedará marcado como pagado en su cartera.')) return;
      var orig = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando…'; }
      cmFunctions.httpsCallable('approveCreatorPayout')({ uid: uid, ledgerId: ledgerId })
        .then(function() {
          showFloatingMessage('success', 'Pago verificado para el creador.');
          renderPendingPayouts();
        })
        .catch(function(err) {
          console.error(err);
          showFloatingMessage('error', (err && err.message) || 'No se pudo verificar el pago.');
        })
        .finally(function() {
          if (btn) { btn.disabled = false; btn.innerHTML = orig; }
        });
    }

    function syncAllPublicationMetrics() {
      if (!cmFunctions) {
        showFloatingMessage('error', 'Firebase Functions no disponible.');
        return;
      }
      var btn = document.getElementById('cmScanAllBtn');
      var orig = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Actualizando…'; }
      cmFunctions.httpsCallable('syncCreatorMarketMetrics')({})
        .then(function(res) {
          var n = (res.data && res.data.updated) || 0;
          showFloatingMessage('success', 'Métricas actualizadas desde Facebook (' + n + ' publicación' + (n === 1 ? '' : 'es') + ').');
        })
        .catch(function(err) {
          console.error(err);
          showFloatingMessage('error', (err && err.message) || 'Error al actualizar métricas.');
        })
        .finally(function() {
          if (btn) { btn.disabled = false; btn.innerHTML = orig; }
        });
    }

    db.ref('creatorMarket/submissionQueue').on('value', function(snap) {
      queueCache = snap.val() || {};
      renderSubmissionQueue();
    });

    db.ref('nexus/creatorApplications').on('value', function(snap) {
      appsCache = snap.val() || {};
      renderApplications();
    });

    db.ref('creatorMarket/publications').on('value', function(snap) {
      pubsCache = snap.val() || {};
      renderPublicationsAdmin();
    });

    db.ref('creatorMarket/config').on('value', function(snap) {
      fbConfigCache = snap.val() || {};
      var pageIdInput = document.getElementById('cmFbPageId');
      var pageInput = document.getElementById('cmFbPageUrl');
      var tokenInput = document.getElementById('cmFbPageToken');
      if (pageIdInput && fbConfigCache.facebookPageId) pageIdInput.value = fbConfigCache.facebookPageId;
      if (pageInput && fbConfigCache.facebookPageUrl) pageInput.value = fbConfigCache.facebookPageUrl;
      if (tokenInput && fbConfigCache.facebookPageAccessToken) {
        tokenInput.placeholder = 'Token guardado (deja vacío para mantener el actual)';
      }
      var tokenStatus = document.getElementById('cmFbTokenStatus');
      if (tokenStatus) {
        if (fbConfigCache.facebookPageAccessToken) {
          tokenStatus.innerHTML = '<i class="fas fa-check-circle"></i> Token de página conectado' +
            (fbConfigCache.facebookPageName ? (' · ' + escCm(fbConfigCache.facebookPageName)) : '') +
            (fbConfigCache.facebookTokenUpdatedAt ? (' · ' + fmtCmDate(fbConfigCache.facebookTokenUpdatedAt)) : '');
        } else {
          tokenStatus.textContent = 'Pega el token de me/accounts una vez y pulsa Guardar token.';
        }
      }
      var meta = document.getElementById('cmScanMeta');
      if (meta && fbConfigCache.lastScanAt) {
        meta.textContent = 'Última actualización: ' + fmtCmDate(fbConfigCache.lastScanAt) +
          (fbConfigCache.lastScanCount != null ? (' · ' + fbConfigCache.lastScanCount + ' publicación(es)') : '');
      }
    });

    var scanBtn = document.getElementById('cmScanAllBtn');
    if (scanBtn) scanBtn.addEventListener('click', syncAllPublicationMetrics);

    var saveCfgBtn = document.getElementById('cmSaveFbConfigBtn');
    if (saveCfgBtn) saveCfgBtn.addEventListener('click', function() {
      var pageId = (document.getElementById('cmFbPageId')?.value || '').trim();
      var url = (document.getElementById('cmFbPageUrl')?.value || '').trim();
      var token = (document.getElementById('cmFbPageToken')?.value || '').trim();
      if (!pageId) {
        showFloatingMessage('error', 'El Page ID es obligatorio.');
        return;
      }
      if (!/^[0-9]{5,20}$/.test(pageId) || pageId === '0') {
        showFloatingMessage('error', 'Page ID inválido. Debe ser el número largo de la página (campo "id" en me/accounts), no 0.');
        return;
      }
      if (!token && !fbConfigCache.facebookPageAccessToken) {
        showFloatingMessage('error', 'Pega el token de PÁGINA de me/accounts (no el token de usuario).');
        return;
      }
      var payload = {
        facebookPageId: pageId,
        facebookPageUrl: url,
        updatedAt: Date.now()
      };
      if (token) {
        payload.facebookPageAccessToken = token;
        payload.facebookTokenType = 'page_permanent';
        payload.facebookTokenUpdatedAt = Date.now();
      } else if (fbConfigCache.facebookPageAccessToken) {
        payload.facebookPageAccessToken = fbConfigCache.facebookPageAccessToken;
      }
      db.ref('creatorMarket/config').update(payload).then(function() {
        showFloatingMessage('success', 'Token guardado. No necesitas volver a pegarlo salvo que Meta revoque permisos.');
        var tokenInput = document.getElementById('cmFbPageToken');
        if (tokenInput) tokenInput.value = '';
      }).catch(function(err) {
        console.error(err);
        showFloatingMessage('error', 'No se pudo guardar la configuración.');
      });
    });

    var validateFbBtn = document.getElementById('cmValidateFbBtn');
    if (validateFbBtn) validateFbBtn.addEventListener('click', function() {
      if (!cmFunctions) {
        showFloatingMessage('error', 'Firebase Functions no disponible.');
        return;
      }
      var resultEl = document.getElementById('cmFbValidateResult');
      if (resultEl) resultEl.textContent = 'Probando token…';
      validateFbBtn.disabled = true;
      cmFunctions.httpsCallable('validateCreatorMarketFacebook')({})
        .then(function(res) {
          var r = res.data || {};
          var lines = [];
          if (r.pageName) lines.push('Página: ' + r.pageName);
          if (r.scopes && r.scopes.length) lines.push('Permisos: ' + r.scopes.join(', '));
          if (r.missing && r.missing.length) lines.push('Faltan: ' + r.missing.join(', '));
          (r.hints || []).forEach(function(h) { lines.push(h); });
          if (resultEl) {
            resultEl.textContent = lines.join(' · ');
            resultEl.style.color = r.ok ? '#3fb950' : '#e3b341';
          }
          showFloatingMessage(r.ok ? 'success' : 'info', r.ok ? 'Token listo para publicar.' : 'Revisa permisos del token.');
        })
        .catch(function(err) {
          console.error(err);
          if (resultEl) resultEl.textContent = err.message || 'Error al probar.';
          showFloatingMessage('error', err.message || 'Error al probar token.');
        })
        .finally(function() {
          validateFbBtn.disabled = false;
        });
    });

    onCreatorsTabOpen = function() {
      renderSubmissionQueue();
      renderApplications();
      renderPublicationsAdmin();
      renderPendingPayouts();
    };
  }

  // -------------------------------------------------
  // SEGURIDAD: bugs, mantenimiento, variables, palabras prohibidas, fraude, auditoría
  // Datos en RTDB bajo security/ (solo commanders por reglas).
  // -------------------------------------------------
  function initSecurityHub() {
    if (!db) return;
    var root = db.ref('security');

    function nowTs() { return firebase.database.ServerValue.TIMESTAMP; }
    function fmtDate(ms) {
      if (!ms || typeof ms !== 'number') return '—';
      var d = new Date(ms);
      return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // Registra una acción en el log de auditoría (constancia de quién y cuándo).
    function logAudit(action, detail) {
      return root.child('auditLog').push({
        action: action,
        detail: detail || '',
        byUid: currentCommanderUid || 'unknown',
        byNick: currentCommanderNick || 'Commander',
        at: nowTs()
      });
    }

    // ===================== AUDITORÍA CRÍTICA (SOLO BOSS) =====================
    var SEVERITY = {
      critical: { label: 'Crítico', weight: 0, cls: 'sev-critical' },
      high:     { label: 'Alto',    weight: 1, cls: 'sev-high' },
      medium:   { label: 'Medio',   weight: 2, cls: 'sev-medium' },
      normal:   { label: 'Normal',  weight: 3, cls: 'sev-normal' }
    };

    var COMMUNITY_SECURITY_AUDIT = [
      { id: 'SEC-001', priority: 1, severity: 'critical', necessity: 'inmediata', category: 'nexus_xp', title: 'Escritura directa de XP en Nexus RTDB', description: 'Cualquier usuario puede escribir su propio nodo nexus/users/{uid}/stats (xp, level, rank) sin validación server-side.', impact: 'Inflar XP al máximo, desbloquear Mercado Técnico, recompensas y niveles de acceso sin jugar.', location: 'database.rules.json → nexus/users/$uid/stats', remediation: 'Poner stats.write en false para usuarios; XP solo vía Cloud Functions firmadas.' },
      { id: 'SEC-002', priority: 2, severity: 'critical', necessity: 'inmediata', category: 'nexus_xp', title: 'Escritura directa de stats en users/{uid}/stats', description: 'Ruta paralela users/{uid}/stats permite al dueño modificar estadísticas globales del perfil.', impact: 'Duplicar vector de farmeo de XP y desincronizar dashboard vs Nexus.', location: 'database.rules.json → users/$uid/stats', remediation: 'Bloquear write de usuarios; unificar stats en una sola ruta server-validada.' },
      { id: 'SEC-003', priority: 3, severity: 'critical', necessity: 'inmediata', category: 'nexus_xp', title: 'Misión dailyLogin otorga XP sin verificación', description: 'completeQuest() se ejecuta al pulsar la misión de login diario sin comprobar actividad real.', impact: 'Spam de +100 XP por click en consola o repetición de saveUserData.', location: 'nexus-logic.js → executeQuestAction → dailyLogin', remediation: 'Completar misiones solo desde Cloud Function con cooldown atómico en RTDB.' },
      { id: 'SEC-004', priority: 4, severity: 'critical', necessity: 'inmediata', category: 'nexus_xp', title: 'XP por descargar overlay (client-side)', description: 'downloadOverlay() llama addXP(100) cada vez que se descarga el canvas.', impact: 'Truco trivial: descargas ilimitadas = XP infinito.', location: 'nexus-logic.js → downloadOverlay()', remediation: 'Quitar addXP del cliente; registrar descarga en backend con límite diario.' },
      { id: 'SEC-005', priority: 5, severity: 'critical', necessity: 'inmediata', category: 'nexus_xp', title: 'XP por compartir overlay sin validar', description: 'shareOverlay() suma +10 XP solo por pulsar el botón.', impact: 'Farmeo rápido de XP sin compartir nada.', location: 'nexus-logic.js → shareOverlay()', remediation: 'Verificar share real o eliminar XP del botón.' },
      { id: 'SEC-006', priority: 6, severity: 'critical', necessity: 'inmediata', category: 'nexus_xp', title: 'Boost x2 XP activable desde el cliente', description: 'activateXpBoost() activa multiplicador x2 en memoria sin persistencia ni permiso server.', impact: 'Multiplicar toda ganancia de XP durante 1h sin costo ni límite.', location: 'nexus-logic.js → activateXpBoost()', remediation: 'Boost solo si Commander lo otorga o vía ítem validado en backend.' },
      { id: 'SEC-007', priority: 7, severity: 'critical', necessity: 'inmediata', category: 'tokens', title: 'tokenLedger escribible por el propio usuario', description: 'users/{uid}/tokenLedger permite write al dueño de la cuenta.', impact: 'Falsificar historial de créditos para ocultar fraude o suplantar movimientos legítimos.', location: 'database.rules.json → users/$uid/tokenLedger', remediation: 'Ledger append-only vía Cloud Functions; write false para usuarios.' },
      { id: 'SEC-008', priority: 8, severity: 'critical', necessity: 'inmediata', category: 'economy', title: 'Hijack de códigos refCodes', description: 'Cualquier usuario autenticado puede sobrescribir refCodes/{code} apuntándolo a su UID.', impact: 'Robar referidos ajenos y desviar bonificaciones de promoción.', location: 'database.rules.json → refCodes/$code', remediation: 'Solo crear códigos al registrar usuario; write false excepto Functions.' },
      { id: 'SEC-009', priority: 9, severity: 'critical', necessity: 'inmediata', category: 'auth', title: 'Auto-promoción a Boss of the State', description: 'Un Commander puede reclamar boss_of_the_state si security/bossOfTheState no existe.', impact: 'Control total de tokens, rangos y panel sin autorización real.', location: 'database.rules.json → users/$uid/rango + commander-panel.js', remediation: 'Boss solo asignable por seed admin o Cloud Function one-time.' },
      { id: 'SEC-010', priority: 10, severity: 'critical', necessity: 'inmediata', category: 'data', title: 'teamId modificable por cualquier usuario', description: 'users/{uid}/teamId tiene write auth != null sin restringir al dueño.', impact: 'Inyectar jugadores en equipos ajenos o romper verificación de equipos.', location: 'database.rules.json → users/$uid/teamId', remediation: 'Write solo auth.uid === $uid o Functions de equipos.' },
      { id: 'SEC-011', priority: 11, severity: 'high', necessity: 'alta', category: 'nexus_xp', title: 'Recompensas Nexus reclamables solo en cliente', description: 'claimReward() desbloquea badges/temas y xpBonus sin comprobar nivel en servidor.', impact: 'Reclamar recompensas de nivel 5 estando en nivel 1 si se manipula State.', location: 'nexus-logic.js → claimReward()', remediation: 'Validar level y claimedRewards en reglas o Functions.' },
      { id: 'SEC-012', priority: 12, severity: 'high', necessity: 'alta', category: 'nexus_xp', title: 'Logros Nexus desbloqueables localmente', description: 'checkAchievements() corre en cliente; achievements en nexus/users es user-writable.', impact: 'Auto-otorgar logros y XP bonus asociado.', location: 'nexus-logic.js + nexus/users/$uid', remediation: 'Achievements write false; desbloqueo server-side.' },
      { id: 'SEC-013', priority: 13, severity: 'high', necessity: 'alta', category: 'nexus_xp', title: 'Cooldown de misiones solo en cliente', description: 'Estado quests en Firebase del usuario sin reglas que impidan re-completar.', impact: 'Repetir misiones de 400–500 XP editando quests o reiniciando estado.', location: 'nexus-logic.js → completeQuest + nexus/users', remediation: 'Timestamp lastCompleted validado en reglas con .validate estricta.' },
      { id: 'SEC-014', priority: 14, severity: 'high', necessity: 'alta', category: 'nexus_xp', title: 'Racha diaria manipulable', description: 'checkDailyStreak() confía en lastLogin del propio usuario en stats.', impact: 'Editar lastLogin/streak para bonos de hasta +500 XP diarios.', location: 'nexus-logic.js → checkDailyStreak()', remediation: 'Registrar login diario en nodo server-only con Functions.' },
      { id: 'SEC-015', priority: 15, severity: 'high', necessity: 'alta', category: 'nexus_xp', title: 'XP por acciones de IA/branding sin límite', description: 'Generar IA, analizar diseño y usar sugerencias otorgan XP desde el cliente.', impact: 'Farmeo repetitivo en Branding Studio.', location: 'nexus-logic.js → addXP en canvas/IA', remediation: 'Rate limit server-side por uid y acción.' },
      { id: 'SEC-016', priority: 16, severity: 'high', necessity: 'alta', category: 'tokens', title: 'addTokens() en Community con transacción cliente', description: 'community.js intenta incrementar tokens vía transaction en users/{uid}.', impact: 'Si reglas fallan o hay race, riesgo de crédito no autorizado (Forge upload +10).', location: 'community.js → addTokens()', remediation: 'Tokens solo vía awardMissionTokens Cloud Function.' },
      { id: 'SEC-017', priority: 17, severity: 'high', necessity: 'alta', category: 'economy', title: 'inventory/prestige user-writable', description: 'Usuarios pueden escribir inventory y prestige en su nodo users.', impact: 'Otorgarse ítems, prestigio o ventajas de economía sin costo.', location: 'database.rules.json → users/$uid/inventory|prestige', remediation: 'Write false; mutaciones solo por Functions/comercio validado.' },
      { id: 'SEC-018', priority: 18, severity: 'medium', necessity: 'media', category: 'privacy', title: 'Lectura global de nexus/users', description: 'Cualquier autenticado lee stats/XP de todos los jugadores en Nexus.', impact: 'Scraping de ranking, targeting de cuentas y análisis competitivo abusivo.', location: 'database.rules.json → nexus/users .read', remediation: 'Leer solo propio uid; leaderboard vía endpoint agregado.' },
      { id: 'SEC-019', priority: 19, severity: 'medium', necessity: 'media', category: 'data', title: 'recommendations/{uid} escribible por cualquiera', description: 'Cualquier usuario autenticado puede escribir en recommendations de otro.', impact: 'Spam, manipulación de sugerencias sociales, posible XSS almacenado.', location: 'database.rules.json → recommendations/$uid', remediation: 'Write solo auth.uid === $uid con validate de schema.' },
      { id: 'SEC-020', priority: 20, severity: 'medium', necessity: 'media', category: 'data', title: 'commanderNotifications/lastReport abierto', description: 'lastReport bajo commanderNotifications acepta write de cualquier auth.', impact: 'Falsificar reportes o inundar canal de moderación.', location: 'database.rules.json → commanderNotifications/lastReport', remediation: 'Write solo commanders verificados.' },
      { id: 'SEC-021', priority: 21, severity: 'medium', necessity: 'media', category: 'nexus_xp', title: 'Estado Nexus en localStorage', description: 'nexus_state en localStorage puede restaurarse antes de sync Firebase.', impact: 'Confusión de UI y vectores si se mezcla con writes RTDB manipulados.', location: 'nexus-logic.js → saveUserData / localStorage', remediation: 'Servidor como única fuente de verdad; ignorar localStorage para XP.' },
      { id: 'SEC-022', priority: 22, severity: 'medium', necessity: 'baja', category: 'auth', title: 'Config Firebase expuesta en frontend', description: 'API keys y databaseURL visibles en HTML/JS (patrón Firebase cliente).', impact: 'Facilita ataques automatizados directos a RTDB si reglas fallan.', location: 'dashboard.html, nexus.html, commander-panel.js', remediation: 'Reglas estrictas + App Check + rate limiting; rotar keys si abuso.' },
      { id: 'SEC-023', priority: 23, severity: 'high', necessity: 'alta', category: 'tokens', title: 'Commander puede auto-asignarse XP Nexus', description: 'tokNexusXpSelfBtn permite a Commanders grantearse XP Nexus sin límite.', impact: 'Abuso interno: nivel máximo Nexus en cuenta staff.', location: 'commander-panel.js → grantNexusXP', remediation: 'Solo Boss puede XP Nexus; auditoría obligatoria y tope diario.' }
    ];

    /** Competition Hub — equipos, torneos, chat (auditoría dedicada). Estado en security/auditCatalog/COMP-xxx */
    var COMPETITION_SECURITY_AUDIT = [
      { id: 'COMP-001', priority: 1, severity: 'critical', necessity: 'inmediata', category: 'teams', title: 'Auto-inscripción en roster ajeno', description: 'Reglas permiten que auth.uid escriba teams/{teamId}/roster/{userId} sin invitación ni join request aprobado.', impact: 'Unirse a cualquier equipo, inflar plantillas y saltarse flujos de capitán.', location: 'database.rules.json → teams/$teamId/roster/$userId', remediation: 'Roster write false para miembros; altas solo vía Cloud Functions (invite/join).' },
      { id: 'COMP-002', priority: 2, severity: 'critical', necessity: 'inmediata', category: 'teams', title: 'Invitaciones de equipo por cualquier usuario', description: 'teamInvites/{victim}/{teamId} permite create si !data.exists() sin validar capitán ni invitedBy.', impact: 'Spam/phishing de invitaciones a cualquier jugador con nombres de equipo falsos.', location: 'database.rules.json → teamInvites + competition-hub-logic.js sendInviteToUser', remediation: 'Create solo si captain === auth.uid; validar invitedBy === auth.uid.' },
      { id: 'COMP-003', priority: 3, severity: 'critical', necessity: 'inmediata', category: 'tournaments', title: 'tournamentInvites lectura/escritura global', description: 'Cualquier autenticado lee y escribe todo tournamentInvites/{teamId}.', impact: 'Invites falsos, borrar invites rivales, reconocimiento masivo.', location: 'database.rules.json → tournamentInvites', remediation: 'Read/write solo capitán del teamId (+ staff organizador torneo).' },
      { id: 'COMP-004', priority: 4, severity: 'high', necessity: 'alta', category: 'tournaments', title: 'Registro en torneo sin cuota ni verificación', description: 'acceptTournamentInvite escribe registeredTeams=true desde cliente; reglas solo exigen ser capitán.', impact: 'Equipos no verificados en torneos oficiales sin pagar entry fee.', location: 'competition-hub-logic.js → acceptTournamentInvite + tournaments/registeredTeams', remediation: 'CF atómica: fee, verification.status, cupos; write false en registeredTeams.' },
      { id: 'COMP-005', priority: 5, severity: 'high', necessity: 'alta', category: 'teams_economy', title: 'Capitán puede falsificar verification', description: 'Capitán tiene write en todo teams/{id}; verification no está bloqueado pese a payTeamVerification CF.', impact: 'Estado verified y partidas restantes sin pagar monedas de verificación.', location: 'database.rules.json → teams + teamVerification.js', remediation: 'verification.write false; solo Admin SDK / Functions.' },
      { id: 'COMP-006', priority: 6, severity: 'high', necessity: 'alta', category: 'teams', title: 'Stats de equipo editables por capitán', description: 'stats.wins/losses/tokens escribibles vía write de capitán sin validación.', impact: 'Ranking Top Teams fraudulento en Competition Hub.', location: 'database.rules.json → teams/$teamId + loadTopTeams', remediation: 'stats.write false; actualizar solo tras partidas vía Functions.' },
      { id: 'COMP-007', priority: 7, severity: 'high', necessity: 'alta', category: 'teams', title: 'teamJoinRequests suplantables', description: 'teamJoinRequests/{teamId}/{userId} .write auth != null sin auth.uid === $userId.', impact: 'Peticiones falsas bajo otro UID; borrar solicitudes legítimas.', location: 'database.rules.json → teamJoinRequests', remediation: 'Create/delete propio UID; capitán solo decline vía CF o regla estricta.' },
      { id: 'COMP-008', priority: 8, severity: 'medium', necessity: 'alta', category: 'teams', title: 'userJoinRequests index abusable', description: 'userJoinRequests/{userId} writable por cualquier auth sin auth.uid === $userId.', impact: 'Marcar equipos como solicitados en perfiles ajenos.', location: 'database.rules.json → userJoinRequests', remediation: 'Write solo auth.uid === $userId.' },
      { id: 'COMP-009', priority: 9, severity: 'medium', necessity: 'media', category: 'teams', title: 'Decline join request sin enforcement en reglas', description: 'declineJoinRequest valida capitán en cliente; reglas permiten delete a cualquiera (COMP-007).', impact: 'Griefing: eliminar solicitudes antes de que el capitán las vea.', location: 'competition-hub-logic.js → declineJoinRequest', remediation: 'Misma remediación que COMP-007; preferir CF declineJoinRequest.' },
      { id: 'COMP-010', priority: 10, severity: 'high', necessity: 'alta', category: 'teams', title: 'Aceptar invite sin Cloud Function', description: 'acceptReceivedInvite escribe roster y teamId sin exigir teamInvites ni transacción server-side.', impact: 'Bypass de invitación y auditoría; combinable con COMP-001.', location: 'competition-hub-logic.js → acceptReceivedInvite', remediation: 'CF acceptTeamInvite atómica (invite + roster + teamId + cupo).' },
      { id: 'COMP-011', priority: 11, severity: 'high', necessity: 'alta', category: 'tokens', title: 'Creación de equipo con debito tokens en cliente', description: 'finalizeBtn intenta increment(-10) en users/tokens al crear equipo; reglas no permiten auto-debito.', impact: 'Equipos huérfanos si falla tokens; riesgo de bypass si reglas difieren.', location: 'competition-hub-logic.js ~914–948 + users/tokens rules', remediation: 'CF createTeam: debito atómico + team + teamId.' },
      { id: 'COMP-012', priority: 12, severity: 'medium', necessity: 'alta', category: 'teams_economy', title: 'Fondos premium appearance sin lock RTDB', description: 'purchaseTeamBackground usa CF pero capitán puede escribir appearance/ownedBackgrounds directo.', impact: 'Desbloquear fondos de equipo sin pagar monedas.', location: 'teamVerification.js + teams/appearance', remediation: 'ownedBackgrounds.write false; solo CF.' },
      { id: 'COMP-013', priority: 13, severity: 'high', necessity: 'alta', category: 'chat', title: 'XSS en chat de equipo (URLs en img)', description: 'photoURL e imageUrl en mensajes se interpolan en innerHTML sin sanitizar.', impact: 'Miembros del roster pueden ejecutar script en navegadores del equipo.', location: 'competition-hub-logic.js → render chat ~3334–3362', remediation: 'Solo https URLs allowlist; escapar atributos; CSP.' },
      { id: 'COMP-014', priority: 14, severity: 'medium', necessity: 'alta', category: 'chat', title: 'Mensajes de teamChats sin schema en reglas', description: 'Write solo verifica roster; no valida userId, type, longitud ni URLs.', impact: 'Facilita COMP-013; payloads enormes; campos impersonación.', location: 'database.rules.json → teamChats/messages', remediation: '.validate estricta en push de mensajes.' },
      { id: 'COMP-015', priority: 15, severity: 'medium', necessity: 'media', category: 'storage', title: 'chat_images sin reglas Storage en repo', description: 'Hub sube a chat_images/{teamId}/ pero storage.rules no define ese path.', impact: 'Upload fallido o bucket demasiado abierto en prod.', location: 'competition-hub-logic.js handleImageUpload + storage.rules', remediation: 'Reglas: miembro roster, MIME/tamaño, path por teamId.' },
      { id: 'COMP-016', priority: 16, severity: 'medium', necessity: 'media', category: 'storage', title: 'team_emblems sin reglas Storage en repo', description: 'Emblemas y fondos suben a team_emblems/{teamId}/ sin reglas documentadas.', impact: 'Abuso de almacenamiento o sobrescritura cross-team.', location: 'uploadTeamEmblem / uploadTeamBackground', remediation: 'Storage: solo capitán del teamId, límites de tamaño.' },
      { id: 'COMP-017', priority: 17, severity: 'high', necessity: 'alta', category: 'teams', title: 'teamMatches writable por cualquier auth', description: 'teamMatches/{teamId} .write auth != null sin rol.', impact: 'Historial competitivo falsificado si algún cliente escribe ahí.', location: 'database.rules.json → teamMatches', remediation: 'Write false; solo Functions/Commander.' },
      { id: 'COMP-018', priority: 18, severity: 'medium', necessity: 'media', category: 'data', title: 'battleCalls/latest abierto (ecosistema)', description: 'battleCalls/latest write auth != null (usado fuera del Hub pero afecta competición).', impact: 'Spam de convocatorias globales.', location: 'database.rules.json → battleCalls/latest', remediation: 'Write staff o CF; no cliente genérico.' },
      { id: 'COMP-019', priority: 19, severity: 'medium', necessity: 'media', category: 'privacy', title: 'Búsqueda Competition descarga users completo', description: 'searchPlayersAndTeams hace users.once(value) y filtra en cliente.', impact: 'Scraping de todos los perfiles autenticados.', location: 'competition-hub-logic.js → searchPlayersAndTeams', remediation: 'Queries indexadas; campos mínimos; rate limit.' },
      { id: 'COMP-020', priority: 20, severity: 'medium', necessity: 'media', category: 'tokens', title: 'tokenTransferRequests desde chat sin lock server', description: 'handleTokenTransferSubmit valida saldo en cliente; push a tokenTransferRequests.', impact: 'Cola Commander spam; montos arbitrarios sin debito atómico.', location: 'competition-hub-logic.js + tokenTransferRequests rules', remediation: 'CF con debito atómico y validación mismo equipo.' },
      { id: 'COMP-021', priority: 21, severity: 'medium', necessity: 'media', category: 'chat', title: 'XSS en onclick de invites de torneo', description: 'acceptTournamentInvite embebido en atributo onclick con nombre de torneo.', impact: 'XSS si invite malicioso (COMP-003) llega al capitán.', location: 'competition-hub-logic.js loadTournamentInvites ~3696', remediation: 'addEventListener + data-*; sin inline handlers.' },
      { id: 'COMP-022', priority: 22, severity: 'normal', necessity: 'baja', category: 'tournaments', title: 'tournament-system.js referenciado pero ausente', description: 'competition-hub.html carga tournament-system.js; archivo no está en el repo.', impact: 'Flujos de torneo fragmentados; más superficie sin auditar.', location: 'competition-hub.html + competition-hub-logic.js', remediation: 'Incluir módulo o quitar script; centralizar registro en CF.' },
      { id: 'COMP-023', priority: 23, severity: 'normal', necessity: 'baja', category: 'teams', title: 'Referencia: teamId ya reforzado (SEC-010)', description: 'users/{uid}/teamId write restringido a auth.uid; kick/disband/accept join vía CF.', impact: 'Vector SEC-010 mitigado; mantener al cerrar COMP-001/010.', location: 'SEC-010 / teamMembership.js', remediation: 'Marcar reparado si prod coincide; no regresar write abierto.' }
    ];

    /** Play Zone — misiones, economía de tokens, verificación CS2 y chats. Estado en security/auditCatalog/PZ-xxx */
    var PLAYZONE_SECURITY_AUDIT = [
      { id: 'PZ-001', priority: 1, severity: 'critical', necessity: 'inmediata', category: 'economy', title: 'Minteo ilimitado de tokens al crear misión', description: 'La regla .write de missions/$missionId permite crear el nodo completo, y por cascada RTDB se ignora el .write de commander en rewardPerPlayer: solo aplica su .validate (5–50).', impact: 'Crear misiones con rewardPerPlayer 50 y cobrar 50 tokens por participante sin escrow ni costo: dinero infinito.', location: 'database.rules.json → missions/$missionId (327-328) + rewardPerPlayer (372-375)', remediation: 'REPARADO: el .validate de rewardPerPlayer ahora solo acepta valores distintos de 5 a rango Commander/Boss, y resolveRewardPerPlayer recorta el premio en servidor salvo boost verificado.' },
      { id: 'PZ-002', priority: 2, severity: 'critical', necessity: 'inmediata', category: 'economy', title: 'awardMissionTokens paga sin escrow real', description: 'escrowMissionPrize deja escrow 0 y sponsoredReward true, pero awardMissionTokens acredita perPlayer a cada participante con creditTokens sin comprobar fondos retenidos.', impact: 'Todo pago sale del sistema, no del creador: la economía se infla con cada misión completada.', location: 'functions/awardMissionTokens.js → escrowMissionPrize (142-150) y awardMissionTokens (194-208)', remediation: 'REPARADO: los premios salen de la bolsa finita playzoneRewardBudget con débito atómico y cupo diario de 25 tokens por jugador (tokenAwardsDaily); los Commanders la recargan desde la pestaña Tokens.' },
      { id: 'PZ-003', priority: 3, severity: 'critical', necessity: 'inmediata', category: 'economy', title: 'Puerta de tiempo mínimo omitible', description: 'La comprobación es "if (start != null && ...)": si la misión se crea sin startedAt, sin schedule pasado y sin createdAt, getStartTime devuelve null y el control de duración se salta entero.', impact: 'Crear la misión omitiendo esos tres campos (las reglas solo exigen game, title y creatorUid), confirmar al instante con cuentas propias y cobrar en segundos.', location: 'functions/awardMissionTokens.js → getStartTime (110-119) y awardMissionTokens (210-217)', remediation: 'REPARADO: getStartTime solo acepta startedAt (que las reglas atan al creador y a ±60 s del momento real) y el pago se rechaza si falta; playzone-smart.js bloquea además la confirmación.' },
      { id: 'PZ-004', priority: 4, severity: 'critical', necessity: 'inmediata', category: 'missions', title: 'Pago sin exigir misión activa', description: 'awardMissionTokens nunca comprueba after.status; basta con completionConfirmations de todos los participantes.', impact: 'Misiones en estado pending o canceladas pagan igual, saltándose el ciclo de vida completo.', location: 'functions/awardMissionTokens.js → awardMissionTokens (162-191)', remediation: 'REPARADO: solo se paga con status active o finished, y las reglas restringen el campo a pending/active/finished mediante lista blanca.' },
      { id: 'PZ-005', priority: 5, severity: 'critical', necessity: 'inmediata', category: 'auth', title: 'creatorUid no ligado a auth.uid', description: 'El .validate de missions/$missionId solo exige hasChildren(game, title, creatorUid), sin comprobar que creatorUid sea el del autor.', impact: 'Suplantar a otro jugador como anfitrión y heredar sus permisos de líder (status, startedAt, expulsar, inscribir).', location: 'database.rules.json → missions/$missionId (327-328)', remediation: 'REPARADO: el .validate de creatorUid exige que coincida con auth.uid al crear la misión y lo deja inmutable después, así que ya no se puede levantar una misión a nombre de otro jugador.' },
      { id: 'PZ-006', priority: 6, severity: 'critical', necessity: 'inmediata', category: 'auth', title: 'Clave de API de Steam en el repositorio', description: 'STEAM_API_KEY está escrita en texto plano dentro del código de la Cloud Function de verificación CS2.', impact: 'Cualquiera con acceso al repo usa la clave, agota la cuota Steam y tumba la verificación de misiones CS2.', location: 'functions/cs2FriendsMission.js (19)', remediation: 'REPARADO: la clave ya no vive en el código (steamStats.js y cs2FriendsMission.js la leen de Secret Manager vía defineSecret), steam_login.php se sacó del repo y de Firebase Hosting, y el .gitignore la bloquea a futuro. Estuvo expuesta unos días vía Firebase Hosting hasta cerrar esa fuga; no hay logs disponibles para confirmar si alguien la llegó a leer, y a criterio del equipo se decidió mantener el valor actual sin rotarlo. Rotarla sigue siendo tan simple como generar una clave nueva en Steam y avisar.' },
      { id: 'PZ-007', priority: 7, severity: 'critical', necessity: 'inmediata', category: 'economy', title: 'sponsoredReward y boost falsificables al crear', description: 'sponsoredReward, commanderRewardBoost y commanderRewardBoostBy tienen .write de commander pero su .validate solo comprueba el tipo, y el .write del padre permite escribirlos en la creación.', impact: 'Marcar la misión como patrocinada y con boost de Commander sin ningún rango, multiplicando el premio.', location: 'database.rules.json → missions/$missionId (376-391)', remediation: 'REPARADO: el .validate de commanderRewardBoost, commanderRewardBoostAt y commanderRewardBoostBy ahora exige que quien escribe sea Commander/Boss en ese instante, y commanderRewardBoostBy solo puede ser el propio auth.uid del que activa el boost, así ya no se puede firmar el boost con el UID de un Commander ajeno.' },
      { id: 'PZ-008', priority: 8, severity: 'high', necessity: 'alta', category: 'xss', title: 'XSS en tarjeta de misión (título, juego, avatar)', description: 'renderMissionCard escapa la descripción con escHtml pero interpola cardTitle, mission.game, skill, type y el avatar del participante directamente en innerHTML.', impact: 'Una misión creada con título malicioso ejecuta script en el navegador de cualquiera que abra Play Zone.', location: 'playzone.js → renderMissionCard (1549-1592)', remediation: 'REPARADO: renderMissionCard ya pasa cardTitle, mission.game, skill, type, nick y avatar por un escHtml que codifica comillas simples y dobles ademas de los signos de menor/mayor (el truco de textContent no cubria comillas, asi que no bastaba para atributos como src/title), y el avatar solo admite el sprite local por defecto o una URL https; cualquier otro esquema (javascript:, data:, http:) cae al avatar por defecto.' },
      { id: 'PZ-009', priority: 9, severity: 'high', necessity: 'alta', category: 'xss', title: 'XSS en tarjeta de jugador y onclick inline', description: 'renderPlayerCard inserta user.nick sin escapar y construye onclick="inviteToMission(\'uid\', \'nick\')" escapando solo la comilla simple.', impact: 'Un nick con comillas dobles o etiquetas rompe el atributo y ejecuta script al abrir la pestaña Jugadores.', location: 'playzone.js → renderPlayerCard (1814-1842)', remediation: 'REPARADO: renderPlayerCard ya escapa nick, avatar, rango, estilo de juego, franja horaria y juego destacado con el pzEsc reforzado (codifica comillas y signos de menor/mayor, no solo texto plano), y los onclick inline se sustituyeron por addEventListener que reciben los valores reales por closure, así ya no hay strings de usuario dentro de atributos HTML ejecutables.' },
      { id: 'PZ-010', priority: 10, severity: 'high', necessity: 'alta', category: 'missions', title: 'Cupos de misión solo validados en la interfaz', description: 'joinMission hace un set directo en participants y las reglas no cuentan participantes frente a maxParticipants.', impact: 'Saltarse el botón "Misión llena" desde consola y meter cuentas ilimitadas para forzar confirmaciones y premios.', location: 'playzone.js → joinMission (1696-1731) + database.rules.json → participants (329-332)', remediation: 'REPARADO: las reglas RTDB no pueden contar hijos (no hay numChildren en su lenguaje), así que unirse ahora pasa por la Cloud Function joinMission, que usa una transaction() atómica sobre participants para contar y rechazar si ya no hay cupo; el cliente ya no puede escribir participants/{uid} para darse de alta, database.rules.json solo le deja borrar su propia entrada o la de otro si es anfitrión/Commander (salir/expulsar siguen funcionando igual). maxParticipants ya era inmutable tras crear la misión.' },
      { id: 'PZ-011', priority: 11, severity: 'high', necessity: 'alta', category: 'missions', title: 'El anfitrión puede inscribir a terceros', description: 'La regla de participants/$participantUid permite escribir tanto al propio jugador como al creatorUid de la misión.', impact: 'Meter jugadores sin su consentimiento, inflar cupos y montar misiones fantasma para farmear tokens.', location: 'database.rules.json → missions/$missionId/participants/$participantUid (329-332)', remediation: 'REPARADO como efecto directo del fix de PZ-010: participants/$participantUid ahora exige data.exists() && !newData.exists() (borrado) para cualquier escritor, así que ni el anfitrión ni un Commander pueden ya crear la entrada de otro jugador, solo expulsarlo; las altas pasan por la Cloud Function joinMission, que usa exclusivamente context.auth.uid y no acepta un UID de destino, así que tampoco desde ahí se puede inscribir a un tercero.' },
      { id: 'PZ-012', priority: 12, severity: 'high', necessity: 'alta', category: 'missions', title: 'Invitaciones con remitente falsificable', description: 'missionInvites/$targetUid/$missionId tenía .write auth != null y su .validate no comprobaba que fromUid coincidiera con auth.uid.', impact: 'Spam y phishing de invitaciones suplantando la identidad de cualquier jugador.', location: 'database.rules.json → missionInvites (551-558)', remediation: 'REPARADO: el cliente ya no puede crear missionInvites/$targetUid/$missionId directo (database.rules.json solo le deja borrar su propia invitación recibida); enviar una invitación pasa por la Cloud Function sendMissionInvite, que fija fromUid/fromNick/fromAvatar desde context.auth.uid y el perfil real, valida que la misión y el destinatario existan, y aplica un enfriamiento atómico (missionInviteThrottle vía transaction) de 4 segundos por emisor contra ráfagas de spam.' },
      { id: 'PZ-013', priority: 13, severity: 'high', necessity: 'alta', category: 'missions', title: 'nexusVerifiedComplete escribible por participantes', description: 'La regla permitía que cualquier participante sellara nexusVerifiedComplete sin que el servidor hubiera validado nada (el chequeo de "todos confirmaron" solo vivía en el JS del cliente, saltable desde la consola).', impact: 'Marcar la misión como verificada por el Nexo y ensuciar historial y estadísticas de verificación.', location: 'database.rules.json → missions/$missionId/nexusVerifiedComplete (363-365)', remediation: 'REPARADO: nexusVerifiedComplete pasó a .write:false, así que el cliente ya no puede tocarlo bajo ninguna circunstancia; el sellado es exclusivo de la Cloud Function awardMissionTokens, que se dispara sola en cuanto el último participante escribe su completionConfirmations y ahí sí revalida en servidor que todos confirmaron antes de sellar. Las misiones en solitario (menos del mínimo para cobrar) también se sellan para el historial, solo que sin premio.' },
      { id: 'PZ-014', priority: 14, severity: 'high', necessity: 'alta', category: 'data', title: 'Historial de partidas verificadas falsificable', description: 'users/$uid/extraVerifiedMatches permitía escritura al propio usuario (y a Commanders) con un .validate que solo exigía at, title y type, sin comprobar que la misión existiera ni que se hubiera completado de verdad.', impact: 'Inventar partidas verificadas en el perfil sin haber completado ninguna misión.', location: 'database.rules.json → users/$uid/extraVerifiedMatches (190-194)', remediation: 'REPARADO: extraVerifiedMatches/$entryId pasó a .write:false; ningún cliente (ni siquiera Commander) puede escribir ahí. El único origen de estas entradas es writeMissionHistory dentro de la Cloud Function awardMissionTokens (Admin SDK, que ignora las reglas), que ya solo corre después de validar en servidor que la misión fue confirmada por todos los participantes (ver PZ-013).' },
      { id: 'PZ-015', priority: 15, severity: 'high', necessity: 'alta', category: 'xss', title: 'XSS en chat de misión vía photoURL', description: 'renderHubChatMessage escapaba nick y texto con pzEsc pero colocaba msg.photoURL sin filtrar dentro del atributo src de la imagen.', impact: 'Un participante ejecuta script en el navegador del resto del equipo desde el chat del hub.', location: 'playzone.js → renderHubChatMessage (3248-3263)', remediation: 'REPARADO: renderHubChatMessage ahora pasa msg.photoURL por pzSanitizeAvatarUrl (solo admite el sprite local por defecto o una URL https, cualquier otro esquema como javascript:/data: cae al avatar por defecto) y además escapa el resultado con pzEsc antes de interpolarlo en src="...", así que ni un esquema peligroso ni comillas dentro de la URL pueden romper el atributo. Aplica tanto al chat de equipo como al DM dentro del hub, que comparten la misma función de render.' },
      { id: 'PZ-016', priority: 16, severity: 'high', necessity: 'alta', category: 'xss', title: 'XSS en chat privado vía photoURL e imageUrl', description: 'renderPrivateChatMessage escapaba nick y texto pero interpolaba photoURL e imageUrl crudos en atributos src.', impact: 'Ejecución de script entre usuarios que abren un chat 1 a 1 desde Play Zone.', location: 'playzone.js → renderPrivateChatMessage (3476-3494)', remediation: 'REPARADO: el avatar pasa por pzSanitizeAvatarUrl + pzEsc (mismo criterio que PZ-015: sprite local o https, luego escapado), y para imageUrl se sumó pzSanitizeChatImageUrl, que solo acepta https con host de Firebase Storage (firebasestorage.googleapis.com); cualquier otro esquema o dominio simplemente no se dibuja como imagen. La validación real de origen sigue pendiente en las reglas (ver PZ-018/PZ-021), esto cierra el vector de ejecución de script en el cliente mientras tanto.' },
      { id: 'PZ-017', priority: 17, severity: 'high', necessity: 'alta', category: 'privacy', title: 'Descarga masiva del nodo users', description: 'users tenía .read auth != null y Play Zone (además de comunidad, hub de competición y dashboard) cargaba y filtraba usuarios en el cliente para la búsqueda y la pestaña Jugadores.', impact: 'Cualquier autenticado extrae el padrón completo: nicks, rangos, Steam y metadatos de todos los jugadores.', location: 'database.rules.json → users (.read) + playzone.js → loadPlayers / searchHubUsersForInvite (además de community.js, competition-hub-logic.js y dashboard-logic.js)', remediation: 'REPARADO: users/.read pasó a exigir rango Commander/Boss/Divisional Commander (solo moderación/telemetría del panel siguen leyendo la colección entera); ver el perfil de un UID puntual conocido sigue abierto para cualquier autenticado en users/$uid, igual que hoy. Para las listas, buscadores y rankings que antes barrían toda la colección se creó publicProfiles/{uid}, un espejo de solo lectura con únicamente los campos que ya se mostraban en pantalla (nick, avatar, rango, honor, datos de juego, "pensamiento" público...), nunca tokens, Steam ID crudo, settings ni flags de moderación. Una Cloud Function (syncPublicProfile) lo mantiene al día en cada escritura de users/{uid}, y se corrió una migración única (backfillPublicProfiles) para las cuentas que ya existían. playzone.js, community.js, competition-hub-logic.js y dashboard-logic.js ahora leen publicProfiles en vez de users para sus listas/buscadores/rankings.' },
      { id: 'PZ-018', priority: 18, severity: 'medium', necessity: 'alta', category: 'missions', title: 'Chat de misión sin esquema en reglas', description: 'missions/$missionId/chat, su DM interno y missionChats/$missionId permitían escribir a los participantes sin ningún .validate de campos, autoría ni longitud.', impact: 'Suplantar el senderUid, inyectar photoURL malicioso (ver PZ-015) y subir cargas enormes a la base.', location: 'database.rules.json → missions/$missionId/chat (342-345) y missionChats (574-581)', remediation: 'REPARADO: los tres nodos (chat de equipo, DM dentro del hub y missionChats) ahora exigen senderUid/userId === auth.uid, nick y texto no vacíos con tope de longitud (60 y 1000 caracteres), timestamp dentro de ±60s del reloj del servidor (mismo margen que startedAt) y, si viene photoURL, que sea el sprite local por defecto o una URL https (mismo criterio que pzSanitizeAvatarUrl en el cliente, ver PZ-015/016) — cualquier otro esquema como javascript:/data: se rechaza directo en el servidor, no solo al pintarlo. Los mensajes ya escritos pasan a ser de solo borrado salvo para Commander/Boss, que sí pueden editarlos/eliminarlos para moderación.' },
      { id: 'PZ-019', priority: 19, severity: 'medium', necessity: 'media', category: 'economy', title: 'tokensAwarded inyectable en la creación', description: 'Nada impide incluir tokensAwarded true en el objeto inicial de la misión, y awardMissionTokens aborta en cuanto lo detecta por idempotencia.', impact: 'Sabotear misiones legítimas: el equipo completa la misión y nunca cobra el premio.', location: 'database.rules.json → missions/$missionId (327-328) + functions/awardMissionTokens.js (165)', remediation: 'REPARADO: se añadió .validate: false en missions/$missionId a los seis campos exclusivos del pago (tokensAwarded, awardedAmount, awardedPayouts, awardedCapped, escrowStatus, awardedAt). A diferencia de .write, .validate no se hereda del nodo padre, así que aunque la creación de la misión esté permitida en bloque, cualquier intento de incluir uno de esos campos (en la creación o en una actualización posterior) hace fallar la escritura completa. El único origen real de estos valores sigue siendo el Admin SDK dentro de awardMissionTokens, que ignora las reglas.' },
      { id: 'PZ-020', priority: 20, severity: 'medium', necessity: 'alta', category: 'economy', title: 'CS2: cuenta partidas no jugadas juntas', description: 'verifyCs2FriendsMission solo exige que el contador total_matches_played de cada jugador suba en 1, sin correlacionar una partida común.', impact: 'Cobrar el premio de misiones CS2 jugando por separado, sin cumplir el objetivo de jugar en equipo.', location: 'functions/cs2FriendsMission.js → verifyCs2FriendsMission', remediation: 'MITIGADO (limitación de la API pública de Steam): GetUserStatsForGame no expone lobby/match ID ni Premier rating para terceros, así que no existe forma 100% verificable de probar la misma partida con la API pública. Como mejor proxy disponible, verifyCs2FriendsMission ahora exige además que la última partida de cada participante tenga al menos 4 rondas (descarta calentamientos/abandonos) y, sobre todo, que el número de rondas de esa última partida sea IDÉNTICO para todos los participantes — ese valor es un agregado por partida (no varía de jugador a jugador), así que si no coincide es evidencia fuerte de que jugaron partidas distintas y la verificación falla con el motivo not_same_match. Riesgo residual: coincidencia fortuita de rondas jugando partidas separadas, mismo tipo de limitación que ya advertía el comentario original del archivo; una corrección 100% verificable requeriría una integración distinta a la API pública (p. ej. código de lobby o replay, no disponibles hoy). SEGUIMIENTO: se detectó que el contador agregado total_matches_played de Steam se replica con retraso respecto a los stats de "última partida" (last_match_rounds/last_match_kills), causando falsos negativos (no_new_match) justo después de jugar aunque el jugador ya haya terminado la partida. Se corrigió capturando también last_match_rounds/last_match_kills en el baseline y aceptando el cambio de esos valores como evidencia igualmente válida de partida nueva, sin depender solo del contador agregado.' },
      { id: 'PZ-021', priority: 21, severity: 'medium', necessity: 'media', category: 'data', title: 'privateChats valida la sala por subcadena', description: 'La regla usa $chatRoomID.contains(auth.uid) en lugar de comparar los UID que componen la sala.', impact: 'Un identificador de sala manipulado que contenga el UID propio concede lectura y escritura fuera del par previsto.', location: 'database.rules.json → privateChats/$chatRoomID (560-565)', remediation: 'REPARADO: el chatRoomID se genera en el cliente como [uidA, uidB].sort().join(\'_\'), y las reglas de Realtime Database no tienen función split(), así que en vez de "contains" (que aceptaba cualquier UID que apareciera como subcadena en cualquier posición) ahora se exige que la sala EMPIECE con "auth.uid + \'_\'" o TERMINE con "\'_\' + auth.uid" (beginsWith/endsWith). Eso ancla la coincidencia exactamente al UID que ocupa el primer o el segundo lugar del par, en vez de aceptar que aparezca en cualquier punto intermedio de la cadena.' },
      { id: 'PZ-022', priority: 22, severity: 'medium', necessity: 'media', category: 'storage', title: 'private_chat_images sin reglas de Storage', description: 'handlePrivateChatImageUpload sube a private_chat_images/{room}/ pero storage.rules no declara ninguna coincidencia para esa ruta.', impact: 'Las imágenes del chat privado fallan al subirse en producción y el flujo queda roto sin aviso.', location: 'playzone.js → handlePrivateChatImageUpload (3521) + storage.rules', remediation: 'REPARADO: se agregó el match private_chat_images/{chatRoomID}/{fileName} en storage.rules. Como el chatRoomID es el mismo [uidA, uidB].sort().join(\'_\') que valida privateChats (ver PZ-021) y Storage Rules tampoco tiene una forma confiable de partir ese ID cuando un UID de Steam ya trae "_" adentro, se usó la misma técnica de anclado por regex (chatRoomID empieza con auth.uid + "_" o termina con "_" + auth.uid) para exigir que solo los dos participantes reales lean o escriban esa carpeta, además de tope de 5 MB y exigir contentType image/*.' },
      { id: 'PZ-023', priority: 23, severity: 'medium', necessity: 'media', category: 'missions', title: 'Metadatos de participante sin validar', description: 'joinMission escribe nick, rank y photoURL elegidos por el cliente y las reglas de participants no imponen ningún esquema.', impact: 'Suplantar rango y nombre dentro del hub de la misión y colar URLs de avatar maliciosas.', location: 'playzone.js → joinMission (1725-1731) + database.rules.json → participants (329-332)', remediation: 'REPARADO: unirse a una misión ya pasaba por la Cloud Function joinMission (ver PZ-010), que toma nick/rank/photoURL del users/{uid} real en el servidor, pero quedaba un hueco: al CREAR una misión el propio cliente manda de una vez participants: {miUid: creatorInfo} dentro del mismo objeto de creación, y como .write se hereda del nodo padre (missions/$missionId ya permite crear en bloque) esa restricción de "solo borrar" en participants/$participantUid no se aplicaba a esa escritura inicial. Se le agregó un .validate (que a diferencia de .write nunca se hereda, mismo principio que en PZ-019) que exige forma completa (nick/photoURL/joinedAt/rank), topes de longitud, que $participantUid sea exactamente auth.uid, y que nick/rank/photoURL coincidan con el perfil real en users/{uid} o con las cadenas por defecto exactas que usa el propio código (Usuario / Operativo / Tribal Warrior / sprite local) — cualquier otro valor inventado hace fallar la escritura completa.' },
      { id: 'PZ-024', priority: 24, severity: 'normal', necessity: 'baja', category: 'economy', title: 'Premio mostrado siempre como 5 tokens', description: 'missionRewardLabel ignora el argumento mission y devuelve la cadena fija "5 tokens/jugador" aunque rewardPerPlayer valga otra cosa.', impact: 'La interfaz oculta premios reales distintos, lo que enmascara el abuso descrito en PZ-001.', location: 'playzone.js → missionRewardLabel (1691-1693)', remediation: 'Leer mission.rewardPerPlayer y mostrar el premio real de cada misión.' }
    ];

    var NECESSITY_LABELS = {
      inmediata: { label: 'Reparación inmediata', cls: 'immediate' },
      alta: { label: 'Alta prioridad', cls: 'high' },
      media: { label: 'Prioridad media', cls: 'medium' },
      baja: { label: 'Mejora recomendada', cls: 'medium' }
    };

    var CATEGORY_LABELS = {
      tokens: 'Tokens',
      nexus_xp: 'Nexus XP',
      auth: 'Autenticación / Rangos',
      data: 'Integridad de datos',
      economy: 'Economía / Ítems',
      privacy: 'Privacidad',
      teams: 'Equipos / roster',
      tournaments: 'Torneos',
      teams_economy: 'Verificación / apariencia',
      chat: 'Chat de equipo',
      storage: 'Firebase Storage',
      missions: 'Misiones Play Zone',
      xss: 'Inyección / XSS'
    };

    var auditCatalogCache = {};
    var auditCatalogListenerAttached = false;
    var bossAuditBlock = document.getElementById('secBossAuditBlock');
    var bossAuditListEl = document.getElementById('secBossAuditList');
    var auditSummaryEl = document.getElementById('secAuditSummary');
    var competitionAuditBlock = document.getElementById('secCompetitionAuditBlock');
    var competitionAuditListEl = document.getElementById('secCompetitionAuditList');
    var competitionAuditSummaryEl = document.getElementById('secCompetitionAuditSummary');
    var playzoneAuditBlock = document.getElementById('secPlayzoneAuditBlock');
    var playzoneAuditListEl = document.getElementById('secPlayzoneAuditList');
    var playzoneAuditSummaryEl = document.getElementById('secPlayzoneAuditSummary');

    function updateBossAuditVisibility() {
      var isBoss = isBossOfTheStateRango(currentCommanderRango);
      if (bossAuditBlock) bossAuditBlock.style.display = isBoss ? 'block' : 'none';
      if (competitionAuditBlock) competitionAuditBlock.style.display = isBoss ? 'block' : 'none';
      if (playzoneAuditBlock) playzoneAuditBlock.style.display = isBoss ? 'block' : 'none';
      if (isBoss) {
        if (!auditCatalogListenerAttached) {
          auditCatalogListenerAttached = true;
          root.child('auditCatalog').on('value', function(snap) {
            auditCatalogCache = snap.val() || {};
            renderBossAuditCatalog();
            renderCompetitionAuditCatalog();
            renderPlayzoneAuditCatalog();
          });
        }
        renderBossAuditCatalog();
        renderCompetitionAuditCatalog();
        renderPlayzoneAuditCatalog();
      }
    }
    window.__sgUpdateBossAuditVisibility = updateBossAuditVisibility;

    function renderAuditCatalogPanel(findings, summaryEl, listEl) {
      if (!listEl || !isBossOfTheStateRango(currentCommanderRango)) return;
      var openCount = 0;
      var criticalOpen = 0;

      findings.forEach(function(f) {
        var st = auditCatalogCache[f.id];
        if (!st || st.status !== 'repaired') {
          openCount++;
          if (f.severity === 'critical') criticalOpen++;
        }
      });

      if (summaryEl) {
        summaryEl.innerHTML =
          '<span class="sec-audit-summary-item">Hallazgos auditados<strong>' + findings.length + '</strong></span>' +
          '<span class="sec-audit-summary-item">Pendientes<strong>' + openCount + '</strong></span>' +
          '<span class="sec-audit-summary-item">Críticos abiertos<strong>' + criticalOpen + '</strong></span>' +
          '<span class="sec-audit-summary-item">Veredicto<strong>' + (criticalOpen > 0 ? 'NO SEGURO' : (openCount > 5 ? 'EN RIESGO' : 'MEJORABLE')) + '</strong></span>';
      }

      listEl.innerHTML = '';
      var sorted = findings.slice().sort(function(a, b) { return a.priority - b.priority; });
      sorted.forEach(function(f, idx) {
        var st = auditCatalogCache[f.id] || {};
        var isRepaired = st.status === 'repaired';
        var sev = SEVERITY[f.severity] || SEVERITY.high;
        var nec = NECESSITY_LABELS[f.necessity] || NECESSITY_LABELS.media;
        var catLabel = CATEGORY_LABELS[f.category] || f.category;
        var isLast = idx === sorted.length - 1;
        var padNum = f.priority < 10 ? '0' + f.priority : String(f.priority);

        var card = document.createElement('article');
        card.className = 'sec-audit-finding ' + sev.cls + (isRepaired ? ' is-repaired' : '') + (isLast ? ' is-last' : '');
        card.innerHTML =
          '<div class="sec-audit-rail' + (isLast ? ' is-last' : '') + '">' +
            '<span class="sec-audit-rail-dot ' + sev.cls + '">' + padNum + '</span>' +
            (isLast ? '' : '<span class="sec-audit-rail-line"></span>') +
          '</div>' +
          '<div class="sec-audit-panel">' +
            '<button type="button" class="sec-audit-panel-head" aria-expanded="false">' +
              '<div class="sec-audit-panel-meta">' +
                '<span class="sec-audit-chip ' + sev.cls + '">' + sev.label + '</span>' +
                '<span class="sec-audit-chip cat-' + f.category + '">' + catLabel + '</span>' +
                '<span class="sec-audit-chip sec-audit-chip-id">' + escapeHtml(f.id) + '</span>' +
                '<span class="sec-audit-status ' + (isRepaired ? 'ok' : 'pending') + '">' + (isRepaired ? 'Reparado' : 'Pendiente') + '</span>' +
              '</div>' +
              '<h4 class="sec-audit-panel-title">' + escapeHtml(f.title) + '</h4>' +
              '<p class="sec-audit-panel-lead">' + escapeHtml(f.description) + '</p>' +
              '<span class="sec-audit-necessity-pill ' + nec.cls + '">' + nec.label + '</span>' +
              '<span class="sec-audit-expand" aria-hidden="true"><i class="fas fa-chevron-down"></i></span>' +
            '</button>' +
            '<div class="sec-audit-panel-body">' +
              '<div class="sec-audit-info-grid">' +
                '<div class="sec-audit-info-box impact">' +
                  '<span class="sec-audit-info-label"><i class="fas fa-bolt"></i> Impacto</span>' +
                  '<p>' + escapeHtml(f.impact) + '</p>' +
                '</div>' +
                '<div class="sec-audit-info-box fix">' +
                  '<span class="sec-audit-info-label"><i class="fas fa-wrench"></i> Reparación</span>' +
                  '<p>' + escapeHtml(f.remediation) + '</p>' +
                '</div>' +
              '</div>' +
              '<div class="sec-audit-path"><i class="fas fa-code"></i><code>' + escapeHtml(f.location) + '</code></div>' +
              (st.repairedAt ? '<p class="sec-audit-repaired-note"><i class="fas fa-check-circle"></i> Reparado por ' + escapeHtml(st.repairedByNick || 'Boss') + ' · ' + fmtDate(st.repairedAt) + '</p>' : '') +
              '<div class="sec-audit-panel-actions">' +
                (isRepaired
                  ? '<button type="button" class="sec-audit-btn ghost sec-audit-reopen-btn" data-audit-id="' + f.id + '"><i class="fas fa-undo"></i> Reabrir</button>'
                  : '<button type="button" class="sec-audit-btn primary sec-audit-repair-btn" data-audit-id="' + f.id + '"><i class="fas fa-check"></i> Marcar reparado</button>') +
                '<button type="button" class="sec-audit-btn ghost sec-audit-order-btn" data-audit-id="' + f.id + '"><i class="fas fa-plus"></i> Crear orden</button>' +
              '</div>' +
            '</div>' +
          '</div>';

        var headBtn = card.querySelector('.sec-audit-panel-head');
        headBtn.addEventListener('click', function() {
          var open = card.classList.toggle('open');
          headBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        var repairBtn = card.querySelector('.sec-audit-repair-btn');
        if (repairBtn) {
          repairBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            markAuditFindingRepaired(f.id, f.title);
          });
        }
        var reopenBtn = card.querySelector('.sec-audit-reopen-btn');
        if (reopenBtn) {
          reopenBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            reopenAuditFinding(f.id, f.title);
          });
        }
        var orderBtn = card.querySelector('.sec-audit-order-btn');
        if (orderBtn) {
          orderBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            createBugFromAuditFinding(f);
          });
        }

        listEl.appendChild(card);
      });
    }

    function renderBossAuditCatalog() {
      renderAuditCatalogPanel(COMMUNITY_SECURITY_AUDIT, auditSummaryEl, bossAuditListEl);
    }

    function renderCompetitionAuditCatalog() {
      renderAuditCatalogPanel(COMPETITION_SECURITY_AUDIT, competitionAuditSummaryEl, competitionAuditListEl);
    }

    function renderPlayzoneAuditCatalog() {
      renderAuditCatalogPanel(PLAYZONE_SECURITY_AUDIT, playzoneAuditSummaryEl, playzoneAuditListEl);
    }

    function markAuditFindingRepaired(id, title) {
      if (!isBossOfTheStateRango(currentCommanderRango)) return;
      if (!confirm('¿Marcar "' + title + '" como REPARADO en la auditoría?')) return;
      root.child('auditCatalog/' + id).set({
        status: 'repaired',
        repairedByUid: currentCommanderUid || 'unknown',
        repairedByNick: currentCommanderNick || 'Boss',
        repairedAt: nowTs()
      }).then(function() {
        logAudit('audit_repaired', id + ': ' + title);
        showFloatingMessage('success', 'Hallazgo marcado como reparado.');
      }).catch(function(e) {
        console.error(e);
        showFloatingMessage('error', 'No se pudo actualizar el hallazgo.');
      });
    }

    function reopenAuditFinding(id, title) {
      if (!isBossOfTheStateRango(currentCommanderRango)) return;
      root.child('auditCatalog/' + id).set({
        status: 'open',
        reopenedByUid: currentCommanderUid || 'unknown',
        reopenedByNick: currentCommanderNick || 'Boss',
        reopenedAt: nowTs()
      }).then(function() {
        logAudit('audit_reopened', id + ': ' + title);
        showFloatingMessage('success', 'Hallazgo reabierto.');
      }).catch(function(e) {
        console.error(e);
        showFloatingMessage('error', 'No se pudo reabrir.');
      });
    }

    function createBugFromAuditFinding(f) {
      if (!f) return;
      root.child('bugs').push({
        title: '[' + f.id + '] ' + f.title,
        description: f.description + '\n\nImpacto: ' + f.impact + '\n\nReparación: ' + f.remediation + '\n\nUbicación: ' + f.location,
        severity: f.severity === 'critical' ? 'critical' : (f.severity === 'high' ? 'high' : 'medium'),
        status: 'open',
        source: 'audit_catalog',
        auditId: f.id,
        createdAt: nowTs(),
        createdByUid: currentCommanderUid || 'unknown',
        createdByNick: currentCommanderNick || 'Boss'
      }).then(function() {
        logAudit('audit_bug_created', f.id);
        showFloatingMessage('success', 'Orden creada desde auditoría.');
      }).catch(function(e) {
        console.error(e);
        showFloatingMessage('error', 'No se pudo crear la orden.');
      });
    }

    updateBossAuditVisibility();

    // ===================== BUGS / ÓRDENES DE SEGURIDAD =====================
    var bugFilter = 'open';
    var bugsCache = {};

    var bugTitleEl = document.getElementById('secBugTitle');
    var bugSevEl = document.getElementById('secBugSeverity');
    var bugDescEl = document.getElementById('secBugDescription');
    var bugAddBtn = document.getElementById('secBugAddBtn');
    var bugsListEl = document.getElementById('secBugsList');
    var bugsOpenCountEl = document.getElementById('secBugsOpenCount');

    if (bugAddBtn) {
      bugAddBtn.addEventListener('click', function() {
        var title = (bugTitleEl.value || '').trim();
        var sev = bugSevEl.value || 'normal';
        var desc = (bugDescEl.value || '').trim();
        if (!title) { showFloatingMessage('error', 'Ponle un título a la orden.'); return; }
        if (!SEVERITY[sev]) sev = 'normal';
        bugAddBtn.disabled = true;
        root.child('bugs').push({
          title: title,
          description: desc,
          severity: sev,
          status: 'open',
          createdAt: nowTs(),
          createdByUid: currentCommanderUid || 'unknown',
          createdByNick: currentCommanderNick || 'Commander'
        }).then(function(ref) {
          logAudit('bug_created', 'Orden creada: "' + title + '" (' + sev + ')');
          bugTitleEl.value = '';
          bugDescEl.value = '';
          bugSevEl.value = 'medium';
          showFloatingMessage('success', 'Orden de seguridad creada.');
        }).catch(function(e) {
          console.error(e);
          showFloatingMessage('error', 'No se pudo crear la orden.');
        }).finally(function() { bugAddBtn.disabled = false; });
      });
    }

    document.querySelectorAll('.sec-filter-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.sec-filter-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        bugFilter = btn.getAttribute('data-bug-filter') || 'open';
        renderBugs();
      });
    });

    function markBugRepaired(id) {
      var bug = bugsCache[id];
      if (!bug) return;
      if (!confirm('¿Marcar esta orden como REPARADA? Quedará constancia de tu usuario y la fecha.')) return;
      root.child('bugs/' + id).update({
        status: 'repaired',
        repairedByUid: currentCommanderUid || 'unknown',
        repairedByNick: currentCommanderNick || 'Commander',
        repairedAt: nowTs()
      }).then(function() {
        logAudit('bug_repaired', 'Reparada: "' + (bug.title || id) + '"');
        showFloatingMessage('success', 'Marcada como reparada. Constancia guardada.');
      }).catch(function(e) {
        console.error(e);
        showFloatingMessage('error', 'No se pudo actualizar la orden.');
      });
    }

    function renderBugs() {
      if (!bugsListEl) return;
      var ids = Object.keys(bugsCache);
      var openCount = ids.filter(function(id) { return bugsCache[id].status !== 'repaired'; }).length;
      if (bugsOpenCountEl) bugsOpenCountEl.textContent = openCount + ' abiertas';

      var filtered = ids.filter(function(id) {
        var st = bugsCache[id].status === 'repaired' ? 'repaired' : 'open';
        return bugFilter === 'all' ? true : st === bugFilter;
      });

      filtered.sort(function(a, b) {
        var ba = bugsCache[a], bb = bugsCache[b];
        var wa = (SEVERITY[ba.severity] || SEVERITY.normal).weight;
        var wb = (SEVERITY[bb.severity] || SEVERITY.normal).weight;
        if (wa !== wb) return wa - wb;
        return (bb.createdAt || 0) - (ba.createdAt || 0);
      });

      if (!filtered.length) {
        bugsListEl.innerHTML = '<div class="sec-empty">No hay órdenes en esta vista.</div>';
        return;
      }

      bugsListEl.innerHTML = '';
      filtered.forEach(function(id) {
        var b = bugsCache[id];
        var sev = SEVERITY[b.severity] || SEVERITY.normal;
        var repaired = b.status === 'repaired';

        var card = document.createElement('div');
        card.className = 'sec-bug-card ' + sev.cls + (repaired ? ' is-repaired' : '');

        var head = document.createElement('div');
        head.className = 'sec-bug-head';
        head.innerHTML =
          '<span class="sec-sev-badge ' + sev.cls + '">' + sev.label + '</span>' +
          '<span class="sec-bug-title">' + escapeHtml(b.title || 'Sin título') + '</span>' +
          '<span class="sec-bug-status ' + (repaired ? 'ok' : 'pending') + '">' +
            (repaired ? '<i class="fas fa-check-circle"></i> Reparado' : '<i class="fas fa-exclamation-circle"></i> Abierto') +
          '</span>' +
          '<i class="fas fa-chevron-down sec-bug-caret"></i>';

        var body = document.createElement('div');
        body.className = 'sec-bug-body';
        var meta = 'Creada por ' + escapeHtml(b.createdByNick || '—') + ' · ' + fmtDate(b.createdAt);
        if (repaired) {
          meta += '<br><span class="sec-repaired-meta"><i class="fas fa-user-shield"></i> Reparado por ' +
            escapeHtml(b.repairedByNick || '—') + ' · ' + fmtDate(b.repairedAt) + '</span>';
        }
        body.innerHTML =
          '<p class="sec-bug-desc">' + (b.description ? escapeHtml(b.description) : '<em>Sin descripción.</em>') + '</p>' +
          '<div class="sec-bug-meta">' + meta + '</div>';

        var actions = document.createElement('div');
        actions.className = 'sec-bug-actions';
        if (!repaired) {
          var repBtn = document.createElement('button');
          repBtn.type = 'button';
          repBtn.className = 'comms-btn comms-btn-primary';
          repBtn.innerHTML = '<i class="fas fa-check"></i> Reparado el bug';
          repBtn.addEventListener('click', function(e) { e.stopPropagation(); markBugRepaired(id); });
          actions.appendChild(repBtn);
        }
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'comms-btn comms-btn-ghost';
        delBtn.innerHTML = '<i class="fas fa-trash"></i> Eliminar';
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (!confirm('¿Eliminar esta orden por completo?')) return;
          root.child('bugs/' + id).remove().then(function() {
            logAudit('bug_deleted', 'Orden eliminada: "' + (b.title || id) + '"');
          });
        });
        actions.appendChild(delBtn);
        body.appendChild(actions);

        head.addEventListener('click', function() { card.classList.toggle('open'); });

        card.appendChild(head);
        card.appendChild(body);
        bugsListEl.appendChild(card);
      });
    }

    root.child('bugs').on('value', function(snap) {
      bugsCache = snap.val() || {};
      renderBugs();
    });

    // ===================== MODO MANTENIMIENTO =====================
    var maintToggle = document.getElementById('secMaintenanceToggle');
    var maintMsg = document.getElementById('secMaintenanceMsg');
    var maintSaveBtn = document.getElementById('secMaintenanceSaveBtn');
    var maintBadge = document.getElementById('secMaintenanceBadge');
    var maintMeta = document.getElementById('secMaintenanceMeta');

    root.child('maintenance').on('value', function(snap) {
      var m = snap.val() || {};
      if (maintToggle) maintToggle.checked = !!m.enabled;
      if (maintMsg && document.activeElement !== maintMsg) maintMsg.value = m.message || '';
      if (maintBadge) {
        maintBadge.textContent = m.enabled ? 'ACTIVO' : 'Inactivo';
        maintBadge.style.color = m.enabled ? '#ff6b6b' : '';
      }
      if (maintMeta) {
        maintMeta.textContent = m.at ? ('Último cambio: ' + (m.byNick || '—') + ' · ' + fmtDate(m.at)) : '';
      }
    });

    if (maintSaveBtn) {
      maintSaveBtn.addEventListener('click', function() {
        var enabled = !!(maintToggle && maintToggle.checked);
        var msg = (maintMsg && maintMsg.value || '').trim();
        maintSaveBtn.disabled = true;
        root.child('maintenance').set({
          enabled: enabled,
          message: msg,
          byUid: currentCommanderUid || 'unknown',
          byNick: currentCommanderNick || 'Commander',
          at: nowTs()
        }).then(function() {
          logAudit('maintenance_' + (enabled ? 'on' : 'off'), msg);
          showFloatingMessage('success', 'Modo mantenimiento ' + (enabled ? 'ACTIVADO' : 'desactivado') + '.');
        }).catch(function(e) {
          console.error(e);
          showFloatingMessage('error', 'No se pudo guardar.');
        }).finally(function() { maintSaveBtn.disabled = false; });
      });
    }

    // ===================== VARIABLES GLOBALES =====================
    var gName = document.getElementById('secGlobalName');
    var gValue = document.getElementById('secGlobalValue');
    var gAddBtn = document.getElementById('secGlobalAddBtn');
    var gList = document.getElementById('secGlobalsList');

    if (gAddBtn) {
      gAddBtn.addEventListener('click', function() {
        var name = (gName.value || '').trim();
        var value = (gValue.value || '').trim();
        if (!name) { showFloatingMessage('error', 'Ponle un nombre a la variable.'); return; }
        gAddBtn.disabled = true;
        root.child('globals').push({
          name: name, value: value,
          byUid: currentCommanderUid || 'unknown', byNick: currentCommanderNick || 'Commander', at: nowTs()
        }).then(function() {
          logAudit('global_set', name + ' = ' + value);
          gName.value = ''; gValue.value = '';
          showFloatingMessage('success', 'Variable guardada.');
        }).catch(function(e) { console.error(e); showFloatingMessage('error', 'No se pudo guardar.'); })
          .finally(function() { gAddBtn.disabled = false; });
      });
    }

    root.child('globals').on('value', function(snap) {
      if (!gList) return;
      var v = snap.val() || {};
      var ids = Object.keys(v);
      if (!ids.length) { gList.innerHTML = '<div class="sec-empty">Sin variables aún.</div>'; return; }
      gList.innerHTML = '';
      ids.forEach(function(id) {
        var it = v[id];
        var row = document.createElement('div');
        row.className = 'sec-row';
        row.innerHTML = '<span class="sec-row-key">' + escapeHtml(it.name || '') + '</span>' +
          '<span class="sec-row-val">' + escapeHtml(String(it.value == null ? '' : it.value)) + '</span>';
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'sec-row-del';
        del.innerHTML = '<i class="fas fa-times"></i>';
        del.title = 'Eliminar variable';
        del.addEventListener('click', function() {
          root.child('globals/' + id).remove().then(function() { logAudit('global_deleted', it.name || id); });
        });
        row.appendChild(del);
        gList.appendChild(row);
      });
    });

    // ===================== PALABRAS PROHIBIDAS =====================
    var bWord = document.getElementById('secBannedWord');
    var bAddBtn = document.getElementById('secBannedAddBtn');
    var bList = document.getElementById('secBannedList');
    var bCount = document.getElementById('secBannedCount');

    function addBannedWord() {
      var word = (bWord.value || '').trim().toLowerCase();
      if (!word) { showFloatingMessage('error', 'Escribe una palabra.'); return; }
      bAddBtn.disabled = true;
      root.child('bannedWords').push({ word: word, byUid: currentCommanderUid || 'unknown', at: nowTs() })
        .then(function() {
          logAudit('bannedword_added', word);
          bWord.value = '';
        }).catch(function(e) { console.error(e); showFloatingMessage('error', 'No se pudo añadir.'); })
        .finally(function() { bAddBtn.disabled = false; });
    }
    if (bAddBtn) bAddBtn.addEventListener('click', addBannedWord);
    if (bWord) bWord.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); addBannedWord(); } });

    root.child('bannedWords').on('value', function(snap) {
      if (!bList) return;
      var v = snap.val() || {};
      var ids = Object.keys(v);
      if (bCount) bCount.textContent = ids.length + ' palabras';
      if (!ids.length) { bList.innerHTML = '<div class="sec-empty">Sin palabras prohibidas.</div>'; return; }
      bList.innerHTML = '';
      ids.forEach(function(id) {
        var it = v[id];
        var chip = document.createElement('span');
        chip.className = 'sec-chip';
        chip.innerHTML = escapeHtml(it.word || '') + ' <i class="fas fa-times"></i>';
        chip.title = 'Quitar';
        chip.addEventListener('click', function() {
          root.child('bannedWords/' + id).remove().then(function() { logAudit('bannedword_removed', it.word || id); });
        });
        bList.appendChild(chip);
      });
    });

    // ===================== TRANSACCIONES MARCADAS POR FRAUDE =====================
    var fList = document.getElementById('secFraudList');
    var fCount = document.getElementById('secFraudCount');

    function reviewFraud(id, decision, data) {
      root.child('fraudFlags/' + id).update({
        status: decision, // 'approved' | 'rejected'
        reviewedByUid: currentCommanderUid || 'unknown',
        reviewedByNick: currentCommanderNick || 'Commander',
        reviewedAt: nowTs()
      }).then(function() {
        logAudit('fraud_' + decision, (data.label || id) + (data.amount != null ? (' · ' + data.amount + ' tokens') : ''));
        showFloatingMessage('success', 'Transacción marcada como ' + (decision === 'approved' ? 'legítima' : 'fraude confirmado') + '.');
      }).catch(function(e) { console.error(e); showFloatingMessage('error', 'No se pudo actualizar.'); });
    }

    root.child('fraudFlags').on('value', function(snap) {
      if (!fList) return;
      var v = snap.val() || {};
      var ids = Object.keys(v).filter(function(id) { return (v[id].status || 'pending') === 'pending'; });
      if (fCount) fCount.textContent = ids.length + ' pendientes';
      if (!ids.length) { fList.innerHTML = '<div class="sec-empty">No hay transacciones pendientes de revisión.</div>'; return; }
      fList.innerHTML = '';
      ids.sort(function(a, b) { return (v[b].at || 0) - (v[a].at || 0); });
      ids.forEach(function(id) {
        var it = v[id];
        var row = document.createElement('div');
        row.className = 'sec-fraud-row';
        row.innerHTML =
          '<div class="sec-fraud-info">' +
            '<span class="sec-fraud-label">' + escapeHtml(it.label || 'Transacción sospechosa') + '</span>' +
            '<span class="sec-fraud-meta">' + (it.amount != null ? (escapeHtml(String(it.amount)) + ' tokens · ') : '') +
              escapeHtml(it.detail || '') + ' · ' + fmtDate(it.at) + '</span>' +
          '</div>';
        var acts = document.createElement('div');
        acts.className = 'sec-fraud-actions';
        var okBtn = document.createElement('button');
        okBtn.type = 'button'; okBtn.className = 'comms-btn comms-btn-ghost';
        okBtn.innerHTML = '<i class="fas fa-check"></i> Legítima';
        okBtn.addEventListener('click', function() { reviewFraud(id, 'approved', it); });
        var badBtn = document.createElement('button');
        badBtn.type = 'button'; badBtn.className = 'comms-btn comms-btn-danger';
        badBtn.innerHTML = '<i class="fas fa-ban"></i> Fraude';
        badBtn.addEventListener('click', function() { reviewFraud(id, 'rejected', it); });
        acts.appendChild(okBtn);
        acts.appendChild(badBtn);
        row.appendChild(acts);
        fList.appendChild(row);
      });
    });

    // ===================== LOG DE AUDITORÍA =====================
    var auditList = document.getElementById('secAuditList');
    root.child('auditLog').limitToLast(50).on('value', function(snap) {
      if (!auditList) return;
      var v = snap.val() || {};
      var ids = Object.keys(v);
      if (!ids.length) { auditList.innerHTML = '<div class="sec-empty">Sin registros aún.</div>'; return; }
      ids.sort(function(a, b) { return (v[b].at || 0) - (v[a].at || 0); });
      auditList.innerHTML = '';
      ids.forEach(function(id) {
        var it = v[id];
        var row = document.createElement('div');
        row.className = 'sec-audit-row';
        row.innerHTML =
          '<span class="sec-audit-action">' + escapeHtml(it.action || 'acción') + '</span>' +
          '<span class="sec-audit-detail">' + escapeHtml(it.detail || '') + '</span>' +
          '<span class="sec-audit-who">' + escapeHtml(it.byNick || '—') + ' · ' + fmtDate(it.at) + '</span>';
        auditList.appendChild(row);
      });
    });
  }

  // -------------------------------------------------
  // Encuestas + publicidad + kit de marca (siteEngagement / RTDB)
  // -------------------------------------------------
  function initSiteEngagementHub() {
    if (!db) return;

    var root = db.ref('siteEngagement');
    var activePollRef = root.child('activePoll');
    var pollArchiveRef = root.child('pollArchive');
    var pollVotesRoot = root.child('pollVotes');
    var adSlotsRef = root.child('adSlots');
    var brandKitRef = root.child('brandKit');

    var statsUnsub = null;
    var currentStatsPollId = null;

    function originBase() {
      return (window.location && window.location.origin) ? window.location.origin.replace(/\/$/, '') : '';
    }

    function fillShareInputs() {
      var o = originBase();
      var u = function(path, campaign) {
        return o + path + '?utm_source=commander_panel&utm_medium=copy&utm_campaign=' + campaign;
      };
      var h = document.getElementById('shareLinkHome');
      var d = document.getElementById('shareLinkDashboard');
      var n = document.getElementById('shareLinkNexus');
      var c = document.getElementById('shareLinkCommunity');
      var p = document.getElementById('shareLinkPlayzone');
      if (h) h.value = u('/', 'sg_home');
      if (d) d.value = u('/dashboard', 'sg_dashboard');
      if (n) n.value = u('/nexus', 'sg_nexus');
      if (c) c.value = u('/community', 'sg_community');
      if (p) p.value = u('/playzone', 'sg_playzone');
    }

    function copyFromInput(id) {
      var el = document.getElementById(id);
      if (!el || !el.value) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.value).then(function() {
          showFloatingMessage('success', 'Enlace copiado.');
        }).catch(function() {
          legacyCopy(el.value);
        });
      } else {
        legacyCopy(el.value);
      }
    }

    function legacyCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showFloatingMessage('success', 'Enlace copiado.');
      } catch (e) {
        showFloatingMessage('error', 'No se pudo copiar.');
      }
      document.body.removeChild(ta);
    }

    document.querySelectorAll('.js-sg-copy').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-sg-copy-target');
        if (id) copyFromInput(id);
      });
    });

    fillShareInputs();

    brandKitRef.on('value', function(snap) {
      var b = snap.val() || {};
      var tag = document.getElementById('brandTagline');
      var hash = document.getElementById('brandHashtag');
      var pitch = document.getElementById('brandPitch');
      var disc = document.getElementById('brandDiscord');
      var yt = document.getElementById('brandYoutube');
      var tw = document.getElementById('brandTwitter');
      if (tag) tag.value = b.tagline || '';
      if (hash) hash.value = b.hashtag || '';
      if (pitch) pitch.value = b.elevatorPitch || '';
      if (disc) disc.value = (b.officialLinks && b.officialLinks.discord) || '';
      if (yt) yt.value = (b.officialLinks && b.officialLinks.youtube) || '';
      if (tw) tw.value = (b.officialLinks && b.officialLinks.twitter) || '';
    });

    var brandSave = document.getElementById('brandKitSaveBtn');
    if (brandSave) {
      brandSave.addEventListener('click', function() {
        var payload = {
          tagline: (document.getElementById('brandTagline') && document.getElementById('brandTagline').value || '').trim(),
          hashtag: (document.getElementById('brandHashtag') && document.getElementById('brandHashtag').value || '').trim(),
          elevatorPitch: (document.getElementById('brandPitch') && document.getElementById('brandPitch').value || '').trim(),
          officialLinks: {
            discord: (document.getElementById('brandDiscord') && document.getElementById('brandDiscord').value || '').trim(),
            youtube: (document.getElementById('brandYoutube') && document.getElementById('brandYoutube').value || '').trim(),
            twitter: (document.getElementById('brandTwitter') && document.getElementById('brandTwitter').value || '').trim()
          },
          updatedAt: Date.now()
        };
        brandKitRef.set(payload).then(function() {
          showFloatingMessage('success', 'Kit de marca guardado.');
        }).catch(function(err) {
          console.error(err);
          showFloatingMessage('error', 'No se pudo guardar (¿reglas Firebase?).');
        });
      });
    }

    adSlotsRef.on('value', function(snap) {
      var slots = snap.val() || {};
      var ds = slots.dashboard_sidebar || {};
      var nx = slots.nexus_hero || {};
      function set(id, v) { var e = document.getElementById(id); if (e) e.value = v != null ? v : ''; }
      function setCh(id, on) { var e = document.getElementById(id); if (e) e.checked = !!on; }
      set('adDashTitle', ds.title);
      set('adDashBody', ds.body);
      set('adDashImage', ds.imageUrl);
      set('adDashCtaLabel', ds.ctaLabel);
      set('adDashCtaUrl', ds.ctaUrl);
      setCh('adDashEnabled', ds.enabled);
      set('adNexusTitle', nx.title);
      set('adNexusBody', nx.body);
      set('adNexusImage', nx.imageUrl);
      set('adNexusCtaLabel', nx.ctaLabel);
      set('adNexusCtaUrl', nx.ctaUrl);
      setCh('adNexusEnabled', nx.enabled);
    });

    var adSave = document.getElementById('adSlotsSaveBtn');
    if (adSave) {
      adSave.addEventListener('click', function() {
        var payload = {
          dashboard_sidebar: {
            title: (document.getElementById('adDashTitle') && document.getElementById('adDashTitle').value || '').trim(),
            body: (document.getElementById('adDashBody') && document.getElementById('adDashBody').value || '').trim(),
            imageUrl: (document.getElementById('adDashImage') && document.getElementById('adDashImage').value || '').trim(),
            ctaLabel: (document.getElementById('adDashCtaLabel') && document.getElementById('adDashCtaLabel').value || '').trim(),
            ctaUrl: (document.getElementById('adDashCtaUrl') && document.getElementById('adDashCtaUrl').value || '').trim(),
            enabled: !!(document.getElementById('adDashEnabled') && document.getElementById('adDashEnabled').checked),
            updatedAt: Date.now()
          },
          nexus_hero: {
            title: (document.getElementById('adNexusTitle') && document.getElementById('adNexusTitle').value || '').trim(),
            body: (document.getElementById('adNexusBody') && document.getElementById('adNexusBody').value || '').trim(),
            imageUrl: (document.getElementById('adNexusImage') && document.getElementById('adNexusImage').value || '').trim(),
            ctaLabel: (document.getElementById('adNexusCtaLabel') && document.getElementById('adNexusCtaLabel').value || '').trim(),
            ctaUrl: (document.getElementById('adNexusCtaUrl') && document.getElementById('adNexusCtaUrl').value || '').trim(),
            enabled: !!(document.getElementById('adNexusEnabled') && document.getElementById('adNexusEnabled').checked),
            updatedAt: Date.now()
          }
        };
        adSlotsRef.set(payload).then(function() {
          showFloatingMessage('success', 'Publicidad guardada.');
        }).catch(function(err) {
          console.error(err);
          showFloatingMessage('error', 'No se pudo guardar adSlots.');
        });
      });
    }

    function aggregateVotesSnap(snap) {
      var counts = {};
      var total = 0;
      snap.forEach(function(c) {
        var v = c.val();
        if (v && typeof v.optionIndex === 'number') {
          var k = String(v.optionIndex);
          counts[k] = (counts[k] || 0) + 1;
          total++;
        }
      });
      return { counts: counts, total: total };
    }

    function renderPollStats(poll, agg) {
      var el = document.getElementById('sgPollStatsLive');
      if (!el) return;
      if (!poll || !poll.options) {
        el.innerHTML = '';
        return;
      }
      agg = agg || { counts: {}, total: 0 };
      if (!agg.total) {
        el.innerHTML = '<span class="sg-stat-muted">Aún no hay votos.</span>';
        return;
      }
      var parts = [];
      poll.options.forEach(function(label, idx) {
        var n = agg.counts[String(idx)] || 0;
        var pct = agg.total ? Math.round((n / agg.total) * 100) : 0;
        parts.push('<div class="sg-stat-row"><span class="sg-stat-label">' + String(label).replace(/</g, '&lt;') + '</span><span class="sg-stat-num">' + n + ' (' + pct + '%)</span></div>');
      });
      parts.push('<div class="sg-stat-total">Total votos: ' + agg.total + '</div>');
      el.innerHTML = parts.join('');
    }

    function bindStatsForPoll(poll) {
      if (statsUnsub && currentStatsPollId) {
        pollVotesRoot.child(currentStatsPollId).off('value', statsUnsub);
      }
      statsUnsub = null;
      currentStatsPollId = null;
      if (!poll || !poll.pollId) {
        renderPollStats(null, { counts: {}, total: 0 });
        return;
      }
      currentStatsPollId = poll.pollId;
      var ref = pollVotesRoot.child(poll.pollId);
      statsUnsub = function(snap) {
        renderPollStats(poll, aggregateVotesSnap(snap));
      };
      ref.on('value', statsUnsub);
    }

    activePollRef.on('value', function(snap) {
      var poll = snap.val();
      var sum = document.getElementById('sgActivePollSummary');
      if (!sum) return;
      if (!poll || !poll.pollId) {
        sum.innerHTML = '<p class="sg-poll-summary-empty">No hay encuesta activa. Publica una nueva abajo.</p>';
        bindStatsForPoll(null);
        return;
      }
      var ends = poll.endsAt ? new Date(poll.endsAt).toLocaleString() : '—';
      var opts = (poll.options || []).map(function(o) { return String(o).replace(/</g, '&lt;'); }).join(' · ');
      sum.innerHTML =
        '<p><strong>ID:</strong> <code>' + poll.pollId + '</code></p>' +
        '<p><strong>Pregunta:</strong> ' + String(poll.question || '').replace(/</g, '&lt;') + '</p>' +
        '<p><strong>Opciones:</strong> ' + opts + '</p>' +
        '<p><strong>Cierre:</strong> ' + ends + ' · <strong>Mostrar:</strong> ' + (poll.showOn || 'all') + '</p>';
      bindStatsForPoll(poll);
    });

    pollArchiveRef.on('value', function(snap) {
      var list = document.getElementById('sgPollArchiveList');
      if (!list) return;
      var rows = [];
      snap.forEach(function(child) {
        var a = child.val() || {};
        var id = child.key;
        var t = a.archivedAt ? new Date(a.archivedAt).toLocaleString() : '—';
        var q = String(a.question || '').replace(/</g, '&lt;');
        var tv = a.totalVotes != null ? a.totalVotes : '—';
        rows.push('<div class="sg-archive-row"><span class="sg-archive-id">' + id + '</span><span class="sg-archive-q">' + q + '</span><span class="sg-archive-meta">' + t + ' · ' + tv + ' votos</span></div>');
      });
      list.innerHTML = rows.length ? rows.join('') : '<p class="sg-stat-muted">Sin archivos todavía.</p>';
    });

    function archivePollById(pollId, meta) {
      if (!pollId) return Promise.resolve();
      return pollVotesRoot.child(pollId).once('value').then(function(vSnap) {
        var agg = aggregateVotesSnap(vSnap);
        var archivePayload = {
          question: meta && meta.question || '',
          options: meta && meta.options || [],
          voteCounts: agg.counts,
          totalVotes: agg.total,
          archivedAt: Date.now(),
          showOn: meta && meta.showOn || 'all',
          previousEndsAt: meta && meta.endsAt || null
        };
        return pollArchiveRef.child(pollId).set(archivePayload);
      }).then(function() {
        return pollVotesRoot.child(pollId).remove();
      });
    }

    var pollQ = document.getElementById('commsPollQuestion');
    var pollOpt = document.getElementById('commsPollOptions');
    var pollDur = document.getElementById('commsPollDurationMin');
    var pollShow = document.getElementById('commsPollShowOn');
    var pollLaunch = document.getElementById('commsPollLaunchBtn');
    var pollClose = document.getElementById('commsPollCloseBtn');
    var pollShare = document.getElementById('commsPollShareLinkBtn');

    if (pollShare) {
      pollShare.addEventListener('click', function() {
        activePollRef.once('value').then(function(s) {
          var p = s.val();
          if (!p || !p.pollId) {
            showFloatingMessage('error', 'No hay encuesta activa para compartir.');
            return;
          }
          var link = originBase() + '/dashboard#sg-poll=' + encodeURIComponent(p.pollId);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(function() {
              showFloatingMessage('success', 'Enlace copiado (Dashboard). También válido en Nexus con el mismo hash.');
            });
          } else {
            legacyCopy(link);
          }
        });
      });
    }

    if (pollLaunch) {
      pollLaunch.addEventListener('click', function() {
        var q = (pollQ && pollQ.value || '').trim();
        var opts = (pollOpt && pollOpt.value || '').trim();
        if (!q || !opts) {
          showFloatingMessage('error', 'Pregunta y opciones obligatorias.');
          return;
        }
        var lines = opts.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
        if (lines.length < 2) {
          showFloatingMessage('error', 'Mínimo dos opciones (una por línea).');
          return;
        }
        if (lines.length > 25) {
          showFloatingMessage('error', 'Máximo 25 opciones.');
          return;
        }
        var mins = parseInt(pollDur && pollDur.value, 10) || 1440;
        var showOn = (pollShow && pollShow.value) || 'all';
        var newPollId = db.ref().push().key;
        var endsAt = Date.now() + mins * 60 * 1000;

        activePollRef.once('value').then(function(prevSnap) {
          var prev = prevSnap.val();
          if (prev && prev.pollId) {
            return archivePollById(prev.pollId, prev);
          }
        }).then(function() {
          return activePollRef.set({
            pollId: newPollId,
            question: q,
            options: lines,
            endsAt: endsAt,
            createdAt: Date.now(),
            showOn: showOn
          });
        }).then(function() {
          showFloatingMessage('success', 'Encuesta publicada. Los usuarios la verán según “Mostrar en”.');
          if (pollQ) pollQ.value = '';
          if (pollOpt) pollOpt.value = '';
        }).catch(function(err) {
          console.error(err);
          showFloatingMessage('error', 'Error al publicar encuesta.');
        });
      });
    }

    if (pollClose) {
      pollClose.addEventListener('click', function() {
        activePollRef.once('value').then(function(s) {
          var p = s.val();
          if (!p || !p.pollId) {
            showFloatingMessage('info', 'No hay encuesta activa.');
            return;
          }
          return archivePollById(p.pollId, p).then(function() {
            return activePollRef.remove();
          }).then(function() {
            showFloatingMessage('success', 'Encuesta cerrada y archivada.');
          });
        }).catch(function(err) {
          console.error(err);
          showFloatingMessage('error', 'Error al cerrar.');
        });
      });
    }
  }

  // -------------------------------------------------
  // Notificación Épica 3D (Broadcast) — Solo Boss of the State
  // Vista previa en vivo comparte el mismo motor Three.js que el overlay
  // real del Dashboard (window.SGCreatureViewer, ver welcome-overlay.js).
  // -------------------------------------------------
  var broadcastPanelInited = false;
  var broadcastPreviewViewer = null;

  function initBroadcastPanel() {
    if (broadcastPanelInited) return;
    if (!db || !window.SGCreatureViewer) return;
    var previewCanvas = document.getElementById('broadcastPreviewCanvas');
    if (!previewCanvas) return;
    broadcastPanelInited = true;

    var broadcastRef = db.ref('siteBroadcast/current');
    var previewLoading = document.getElementById('broadcastPreviewLoading');
    var charSel = document.getElementById('broadcastCharacterSelect');
    var animSel = document.getElementById('broadcastAnimSelect');
    var titleInput = document.getElementById('broadcastTitleInput');
    var msgInput = document.getElementById('broadcastMessageInput');
    var activateBtn = document.getElementById('broadcastActivateBtn');
    var deactivateBtn = document.getElementById('broadcastDeactivateBtn');
    var statusEl = document.getElementById('broadcastActiveStatus');
    var liveBadge = document.getElementById('broadcastLiveBadge');

    function playPreview() {
      if (!isBossOfTheStateRango(currentCommanderRango)) return;
      if (!broadcastPreviewViewer) broadcastPreviewViewer = window.SGCreatureViewer.create(previewCanvas);
      var charId = (charSel && charSel.value) || 'golem-tortoise';
      var clip = (animSel && animSel.value) || 'awake';
      if (previewLoading) { previewLoading.style.display = ''; previewLoading.textContent = 'Cargando…'; }
      broadcastPreviewViewer.playEntrance(charId, clip, function(err) {
        if (!previewLoading) return;
        if (err) { previewLoading.textContent = 'No se pudo cargar la animación.'; }
        else { previewLoading.style.display = 'none'; }
      }, function(ratio) {
        // Cada clip son ~5.5MB; sin el porcentaje parece que no responde.
        if (previewLoading) previewLoading.textContent = 'Invocando… ' + Math.min(100, Math.round(ratio * 100)) + '%';
      });
    }
    window.__sgBroadcastPreviewPlay = playPreview;

    if (charSel) charSel.addEventListener('change', playPreview);
    if (animSel) animSel.addEventListener('change', playPreview);

    function renderActiveStatus(v) {
      var active = !!(v && v.active === true);
      if (liveBadge) liveBadge.style.display = active ? 'inline-flex' : 'none';
      if (deactivateBtn) deactivateBtn.style.display = active ? 'inline-flex' : 'none';
      if (statusEl) {
        if (active) {
          statusEl.className = 'sg-hint sg-broadcast-live';
          var when = v.triggeredAt ? new Date(v.triggeredAt).toLocaleString() : 'ahora';
          statusEl.textContent = '🔴 En vivo desde ' + when + ' — “' + (v.title || '') + '”';
        } else {
          statusEl.className = 'sg-hint';
          statusEl.textContent = 'Sin transmisión activa.';
        }
      }
    }
    broadcastRef.on('value', function(snap) { renderActiveStatus(snap.val()); });

    if (activateBtn) {
      activateBtn.addEventListener('click', function() {
        if (!isBossOfTheStateRango(currentCommanderRango)) {
          showFloatingMessage('error', 'Solo Boss of the State puede activar transmisiones.');
          return;
        }
        var title = (titleInput && titleInput.value || '').trim();
        var message = (msgInput && msgInput.value || '').trim();
        if (!title || !message) {
          showFloatingMessage('error', 'Título y mensaje son obligatorios.');
          return;
        }
        activateBtn.disabled = true;
        broadcastRef.set({
          active: true,
          characterId: (charSel && charSel.value) || 'golem-tortoise',
          animation: (animSel && animSel.value) || 'awake',
          title: title,
          message: message,
          triggeredBy: currentCommanderUid,
          triggeredAt: firebase.database.ServerValue.TIMESTAMP
        }).then(function() {
          showFloatingMessage('success', '📡 Transmisión activada. Los usuarios en Dashboard la verán en vivo, de inmediato.');
        }).catch(function(err) {
          console.error(err);
          showFloatingMessage('error', 'No se pudo activar (¿reglas Firebase?).');
        }).finally(function() { activateBtn.disabled = false; });
      });
    }

    if (deactivateBtn) {
      deactivateBtn.addEventListener('click', function() {
        broadcastRef.child('active').set(false).then(function() {
          showFloatingMessage('success', 'Transmisión desactivada.');
        }).catch(function(err) {
          console.error(err);
          showFloatingMessage('error', 'No se pudo desactivar.');
        });
      });
    }
  }

  /** Muestra/oculta el bloque de Broadcast según rango, y arranca la preview 3D al revelarlo por primera vez. */
  function syncBroadcastBossUi() {
    var block = document.getElementById('secBossBroadcastBlock');
    if (!block) return;
    var isBoss = isBossOfTheStateRango(currentCommanderRango);
    block.style.display = isBoss ? '' : 'none';
    if (isBoss) {
      initBroadcastPanel();
      if (typeof window.__sgBroadcastPreviewPlay === 'function') window.__sgBroadcastPreviewPlay();
    }
  }
  window.__sgUpdateBossBroadcastVisibility = syncBroadcastBossUi;

  // -------------------------------------------------
  // Gestión de personalización: subir marcos/fondos
  // -------------------------------------------------
  function initCustomizationManager() {
    if (!db || !storage) return;

    var typeSel = document.getElementById('assetTypeSelect');
    var nameInput = document.getElementById('assetNameInput');
    var costInput = document.getElementById('assetCostInput');
    var frameLayoutSel = document.getElementById('assetFrameLayoutSelect');
    var frameLayoutField = document.getElementById('assetFrameLayoutField');
    var frameDesignGuide = document.getElementById('assetFrameDesignGuide');
    var fileInput = document.getElementById('assetFileInput');
    var submitBtn = document.getElementById('assetSubmitBtn');
    var statusEl = document.getElementById('assetUploadStatus');
    var previewOverlay = document.getElementById('assetPreviewFrameOverlay');
    var previewHint = document.getElementById('assetPreviewHint');
    var previewWrap = document.querySelector('.commander-preview-avatar-wrap');

    if (!typeSel || !nameInput || !costInput || !fileInput || !submitBtn) return;

    function readFileAsDataURL(file) {
      return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function() { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function loadImage(src) {
      return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = reject;
        img.src = src;
      });
    }

    function canvasToBlob(canvas, type, quality) {
      return new Promise(function(resolve, reject) {
        canvas.toBlob(function(blob) {
          if (!blob) {
            reject(new Error('No se pudo generar blob de imagen.'));
            return;
          }
          resolve(blob);
        }, type, quality);
      });
    }

    // Estandariza frames para compatibilidad futura:
    // - convierte a PNG
    // - normaliza a lienzo cuadrado 1024x1024
    // - centra contenido sin deformar
    function normalizeFrameFileIfNeeded(file, type) {
      if (type !== 'frame') return Promise.resolve({
        uploadFile: file,
        extension: (file.name.split('.').pop() || 'png').toLowerCase()
      });

      return readFileAsDataURL(file).then(function(dataUrl) {
        return loadImage(dataUrl);
      }).then(function(img) {
        var canvas = document.createElement('canvas');
        var size = 1024;
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);

        var scale = Math.min(size / img.width, size / img.height);
        var drawW = Math.round(img.width * scale);
        var drawH = Math.round(img.height * scale);
        var offsetX = Math.round((size - drawW) / 2);
        var offsetY = Math.round((size - drawH) / 2);
        ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

        return canvasToBlob(canvas, 'image/png', 0.92).then(function(blob) {
          var normalized = new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'frame') + '.png', { type: 'image/png' });
          return { uploadFile: normalized, extension: 'png' };
        });
      });
    }

    function getSelectedFrameLayout() {
      if (!frameLayoutSel) return 'wide';
      var val = frameLayoutSel.value;
      return (val === 'standard' || val === 'ornate') ? val : 'wide';
    }

    function applyPreviewFrameLayout() {
      if (!previewOverlay) return;
      previewOverlay.classList.remove('frame-layout-wide', 'frame-layout-standard', 'frame-layout-ornate');
      previewOverlay.classList.add('frame-layout-' + getSelectedFrameLayout());
    }

    function syncFrameOnlyFields() {
      var isFrame = typeSel.value !== 'background';
      if (frameLayoutField) frameLayoutField.style.display = isFrame ? '' : 'none';
      if (frameDesignGuide) frameDesignGuide.style.display = isFrame ? '' : 'none';
      applyPreviewFrameLayout();
    }

    function setStatus(msg, type) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      statusEl.className = 'commander-customization-status ' + (type || '');
    }

    function renderAssetPreview() {
      if (!previewOverlay) return;
      var type = typeSel.value === 'background' ? 'background' : 'frame';
      var file = fileInput.files && fileInput.files[0];
      var bgLayer = document.getElementById('assetPreviewBgLayer');
      var previewStage = document.getElementById('assetPreviewStage');

      if (!file) {
        previewOverlay.style.display = 'none';
        if (previewWrap) previewWrap.classList.remove('has-profile-frame');
        if (bgLayer) {
          bgLayer.classList.remove('is-visible');
          bgLayer.style.backgroundImage = '';
        }
        if (previewStage) previewStage.classList.remove('has-bg-preview');
        if (previewHint) {
          previewHint.textContent = type === 'frame'
            ? 'Sube un frame para ver cómo se integra.'
            : 'Sube un fondo para ver cómo se verá en la card del perfil.';
        }
        return;
      }

      readFileAsDataURL(file).then(function(dataUrl) {
        if (type === 'frame') {
          if (bgLayer) {
            bgLayer.classList.remove('is-visible');
            bgLayer.style.backgroundImage = '';
          }
          if (previewStage) previewStage.classList.remove('has-bg-preview');
          applyPreviewFrameLayout();
          previewOverlay.style.display = 'block';
          previewOverlay.style.backgroundImage = 'url("' + dataUrl + '")';
          if (previewWrap) previewWrap.classList.add('has-profile-frame');
          if (previewHint) previewHint.textContent = 'Vista previa del marco sobre avatar (estilo: ' + getSelectedFrameLayout() + ').';
        } else {
          previewOverlay.style.display = 'none';
          if (previewWrap) previewWrap.classList.remove('has-profile-frame');
          if (bgLayer) {
            bgLayer.style.backgroundImage = 'url("' + dataUrl + '")';
            bgLayer.classList.add('is-visible');
          }
          if (previewStage) previewStage.classList.add('has-bg-preview');
          if (previewHint) previewHint.textContent = 'Banner de perfil: cover centrado (la tarjeta del dashboard no cambia de estilo).';
        }
      }).catch(function() {
        previewOverlay.style.display = 'none';
        if (previewHint) previewHint.textContent = 'No se pudo cargar la vista previa.';
      });
    }

    typeSel.addEventListener('change', function() {
      syncFrameOnlyFields();
      renderAssetPreview();
    });
    if (frameLayoutSel) frameLayoutSel.addEventListener('change', function() {
      applyPreviewFrameLayout();
      if (previewHint && fileInput.files && fileInput.files[0]) {
        previewHint.textContent = 'Vista previa del marco sobre avatar (estilo: ' + getSelectedFrameLayout() + ').';
      }
    });
    fileInput.addEventListener('change', renderAssetPreview);

    submitBtn.addEventListener('click', function() {
      var type = typeSel.value === 'background' ? 'background' : 'frame';
      var name = (nameInput.value || '').trim();
      var cost = parseInt(costInput.value, 10);
      var file = fileInput.files && fileInput.files[0];

      if (!name) {
        setStatus('Escribe un nombre para el ítem.', 'error');
        return;
      }
      if (!file) {
        setStatus('Selecciona un archivo de imagen.', 'error');
        return;
      }
      if (isNaN(cost) || cost < 0) cost = 0;

      setStatus('Subiendo archivo...', 'info');
      submitBtn.disabled = true;

      var id = db.ref().push().key;
      normalizeFrameFileIfNeeded(file, type).then(function(normalized) {
      var ext = normalized.extension;
      var path = 'profileCustomizationAssets/' + type + '/' + id + '.' + ext;
      var ref = storage.ref().child(path);

      return ref.put(normalized.uploadFile).then(function(snapshot) {
        return snapshot.ref.getDownloadURL();
      }).then(function(url) {
        setStatus('Registrando ítem en la base de datos...', 'info');
        var itemRef = db.ref('profileCustomizationAssets/' + type + '/' + id);
        return itemRef.set({
          id: id,
          type: type,
          name: name,
          tokenCost: cost,
          storagePath: path,
          imageUrl: url,
          frameLayout: type === 'frame' ? getSelectedFrameLayout() : null,
          createdAt: Date.now()
        });
      }).then(function() {
        setStatus('Ítem registrado correctamente.', 'success');
        nameInput.value = '';
        costInput.value = '10';
        fileInput.value = '';
        loadCustomizationItems();
      });
      }).catch(function(err) {
        console.error('Error al subir/registrar ítem de personalización:', err);
        var msg = 'Error al subir o registrar el ítem.';
        if (err && err.code === 'storage/unauthorized') {
          msg = 'Storage denegó la subida. Publica las reglas de Storage (profileCustomizationAssets) o inicia sesión de nuevo.';
        } else if (err && err.code === 'PERMISSION_DENIED') {
          msg = 'Permiso denegado en la base de datos. Solo Commander/Boss pueden registrar ítems.';
        } else if (err && err.message) {
          msg = err.message;
        }
        setStatus(msg, 'error');
      }).finally(function() {
        submitBtn.disabled = false;
        renderAssetPreview();
      });
    });

    renderAssetPreview();
    syncFrameOnlyFields();
    loadCustomizationItems();
  }

  function loadCustomizationItems() {
    if (!db) return;
    var list = document.getElementById('customizationItemsList');
    var empty = document.getElementById('customizationItemsListEmpty');
    if (!list || !empty) return;

    empty.style.display = 'block';
    empty.textContent = 'Cargando ítems...';
    list.innerHTML = '';

    db.ref('profileCustomizationAssets').once('value').then(function(snap) {
      if (!snap.exists()) {
        empty.style.display = 'block';
        empty.textContent = 'Aún no hay ítems registrados desde el panel de Commander.';
        return;
      }
      var items = [];
      snap.forEach(function(typeSnap) {
        var itemType = typeSnap.key === 'background' ? 'background' : 'frame';
        typeSnap.forEach(function(child) {
          var raw = child.val() || {};
          items.push({
            id: raw.id || child.key,
            type: raw.type || itemType,
            name: raw.name || '',
            tokenCost: typeof raw.tokenCost === 'number' ? raw.tokenCost : parseInt(raw.tokenCost, 10) || 0,
            storagePath: raw.storagePath || '',
            imageUrl: raw.imageUrl || '',
            createdAt: raw.createdAt || 0
          });
        });
      });
      if (!items.length) {
        empty.style.display = 'block';
        empty.textContent = 'Aún no hay ítems registrados desde el panel de Commander.';
        return;
      }

      items.sort(function(a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      empty.style.display = 'none';
      items.forEach(function(item) {
        function itemDbPath() {
          var safeType = item.type === 'background' ? 'background' : 'frame';
          return 'profileCustomizationAssets/' + safeType + '/' + item.id;
        }

        function refreshAndToast(type, msg) {
          loadCustomizationItems();
          showFloatingMessage(type || 'success', msg || 'Acción completada.');
        }

        function onUpdatePrice() {
          var current = typeof item.tokenCost === 'number' ? item.tokenCost : 0;
          var input = prompt('Nuevo precio en tokens para "' + (item.name || item.id) + '"', String(current));
          if (input == null) return;
          var next = parseInt(input, 10);
          if (isNaN(next) || next < 0) {
            showFloatingMessage('error', 'Precio inválido. Debe ser 0 o mayor.');
            return;
          }
          db.ref(itemDbPath()).update({
            tokenCost: next,
            updatedAt: Date.now()
          }).then(function() {
            refreshAndToast('success', 'Precio actualizado.');
          }).catch(function(err) {
            console.error('Error updating customization item price:', err);
            showFloatingMessage('error', 'No se pudo actualizar el precio.');
          });
        }

        function onReplaceImage() {
          if (!storage) {
            showFloatingMessage('error', 'Firebase Storage no está disponible.');
            return;
          }
          var picker = document.createElement('input');
          picker.type = 'file';
          picker.accept = 'image/png,image/jpeg,image/webp,image/gif';
          picker.style.display = 'none';
          document.body.appendChild(picker);
          picker.addEventListener('change', function() {
            var file = picker.files && picker.files[0];
            if (!file) {
              if (picker.parentNode) picker.parentNode.removeChild(picker);
              return;
            }
            var safeType = item.type === 'background' ? 'background' : 'frame';
            var ext = (file.name.split('.').pop() || 'png').toLowerCase();
            normalizeFrameFileIfNeeded(file, safeType).then(function(normalized) {
            var path = item.storagePath || ('profileCustomizationAssets/' + safeType + '/' + item.id + '.' + normalized.extension);
            showFloatingMessage('info', 'Subiendo nueva imagen...');
            return storage.ref().child(path).put(normalized.uploadFile).then(function(snapshot) {
              return snapshot.ref.getDownloadURL();
            }).then(function(url) {
              return db.ref(itemDbPath()).update({
                imageUrl: url,
                storagePath: path,
                updatedAt: Date.now()
              });
            }).then(function() {
              refreshAndToast('success', 'Imagen actualizada correctamente.');
            }).catch(function(err) {
              console.error('Error replacing customization item image:', err);
              showFloatingMessage('error', 'No se pudo actualizar la imagen.');
            }).finally(function() {
              if (picker.parentNode) picker.parentNode.removeChild(picker);
            });
            });
          });
          picker.click();
        }

        function onDeleteItem() {
          var ok = confirm('¿Eliminar este ítem?\n\n' + (item.name || item.id) + '\nEsta acción no se puede deshacer.');
          if (!ok) return;
          db.ref(itemDbPath()).remove().then(function() {
            if (!storage || !item.storagePath) return;
            return storage.ref().child(item.storagePath).delete().catch(function(err) {
              console.warn('Item removed from DB but storage delete failed:', err);
            });
          }).then(function() {
            refreshAndToast('success', 'Ítem eliminado.');
          }).catch(function(err) {
            console.error('Error deleting customization item:', err);
            showFloatingMessage('error', 'No se pudo eliminar el ítem.');
          });
        }

        var row = document.createElement('div');
        row.className = 'commander-customization-item-row';

        var left = document.createElement('div');
        left.className = 'cci-left';

        var title = document.createElement('div');
        title.className = 'cci-title';
        title.textContent = (item.type === 'background' ? '[BG] ' : '[Frame] ') + (item.name || item.id);

        var meta = document.createElement('div');
        meta.className = 'cci-meta';
        meta.textContent = 'Costo: ' + (item.tokenCost || 0) + ' tokens • ID: ' + item.id +
          (item.type === 'frame' ? ' • Estilo: ' + (item.frameLayout || 'wide') : '');

        left.appendChild(title);
        left.appendChild(meta);

        var right = document.createElement('div');
        right.className = 'cci-right';

        if (item.imageUrl) {
          var img = document.createElement('img');
          img.src = item.imageUrl;
          img.alt = item.name || item.id;
          img.className = 'cci-thumb';
          right.appendChild(img);
        }

        var actions = document.createElement('div');
        actions.className = 'cci-actions';

        var priceBtn = document.createElement('button');
        priceBtn.type = 'button';
        priceBtn.className = 'cci-action-btn';
        priceBtn.textContent = 'Precio';
        priceBtn.title = 'Cambiar precio del ítem';
        priceBtn.addEventListener('click', onUpdatePrice);

        var replaceBtn = document.createElement('button');
        replaceBtn.type = 'button';
        replaceBtn.className = 'cci-action-btn';
        replaceBtn.textContent = 'Actualizar';
        replaceBtn.title = 'Reemplazar imagen del ítem';
        replaceBtn.addEventListener('click', onReplaceImage);

        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'cci-action-btn danger';
        deleteBtn.textContent = 'Borrar';
        deleteBtn.title = 'Eliminar ítem';
        deleteBtn.addEventListener('click', onDeleteItem);

        actions.appendChild(priceBtn);
        actions.appendChild(replaceBtn);
        actions.appendChild(deleteBtn);
        right.appendChild(actions);

        row.appendChild(left);
        row.appendChild(right);
        list.appendChild(row);
      });
    }).catch(function(err) {
      console.error('Error al cargar ítems de personalización:', err);
      if (empty) {
        empty.style.display = 'block';
        empty.textContent = 'Error al cargar ítems de personalización.';
      }
    });
  }

  function checkCommanderAccess() {
    if (typeof firebase === 'undefined' || !firebase.auth || !db) {
      showStatus('Error: backend no disponible. Intenta recargar.', 'error');
      return;
    }

    var accessSettled = false;
    var accessGranted = false;
    var accessDenied = false;
    var verifyInFlight = false;
    var authBootTimer = setTimeout(function() {
      if (accessSettled) return;
      showStatus('Firebase Auth no respondió. Recarga con Ctrl+F5 o revisa la consola (F12).', 'error');
    }, 12000);

    var logoutRedirectTimer = null;

    function grantCommanderPanel(user, data, rango) {
      if (accessGranted) return;
      accessGranted = true;
      accessSettled = true;
      clearTimeout(authBootTimer);
      var mainContent = document.getElementById('commanderMainContent');
      var guard = document.getElementById('commanderAccessGuard');
      var isBoss = isBossOfTheStateRango(rango);

      currentCommanderUid = user.uid;
      currentCommanderNick = data.nick || data.displayName || data.email || user.email || 'Commander';
      currentCommanderRango = rango;

      if (isBoss) {
        showStatus('👑 Boss of the State — autoridad absoluta. El panel es tuyo.', 'success');
      } else {
        showStatus('Acceso concedido. Commander Panel activo.', 'success');
      }
      if (guard) guard.style.display = 'none';
      if (mainContent) mainContent.style.display = 'block';
      try {
        attachCommanderUI();
        syncNexusXpBossUi();
        if (typeof window.__sgUpdateBossAuditVisibility === 'function') {
          window.__sgUpdateBossAuditVisibility();
        }
        if (typeof window.__sgUpdateBossBroadcastVisibility === 'function') {
          window.__sgUpdateBossBroadcastVisibility();
        }
      } catch (attachErr) {
        console.error('attachCommanderUI:', attachErr);
        showStatus('Error al inicializar el panel. Revisa la consola (F12).', 'error');
        if (guard) guard.style.display = 'block';
      }
      initTelemetryRealtime();
      initCommanderCLI();
      initTelemetryPlaceholders();
      setTimeout(function() { drawServerLoadChart(); }, 300);
    }

    function denyCommanderPanel() {
      if (accessDenied || accessGranted) return;
      accessDenied = true;
      accessSettled = true;
      clearTimeout(authBootTimer);
      var mainContent = document.getElementById('commanderMainContent');
      var guard = document.getElementById('commanderAccessGuard');
      showStatus('Acceso denegado. Solo Commanders y Boss of the State.', 'error');
      if (mainContent) mainContent.style.display = 'none';
      if (guard) guard.style.display = 'block';
      setTimeout(function() {
        window.location.href = '/dashboard';
      }, 2000);
    }

    function verifyRangoForUser(user) {
      if (accessGranted || accessDenied || verifyInFlight) return;
      verifyInFlight = true;
      showStatus('Comprobando rango de Commander…', 'success');
      return waitForDbReady().then(function() {
        return db.ref('users/' + user.uid).once('value');
      }).then(function(uSnap) {
        var data = uSnap.val() || {};
        return { rango: normalizeRango(data.rango), data: data };
      }).then(function(profile) {
        if (canAccessCommanderPanel(profile.rango)) {
          verifyInFlight = false;
          grantCommanderPanel(user, profile.data, profile.rango);
        } else {
          verifyInFlight = false;
          denyCommanderPanel();
        }
      }).catch(function(err) {
        verifyInFlight = false;
        accessSettled = true;
        clearTimeout(authBootTimer);
        console.error('Error al verificar rango:', err);
        var msg = (err && err.code === 'PERMISSION_DENIED')
          ? 'Permiso denegado al leer tu perfil (App Check o reglas RTDB).'
          : 'Error al verificar permisos.';
        showStatus(msg, 'error');
      });
    }

    firebase.auth().onAuthStateChanged(function(user) {
      if (logoutRedirectTimer) {
        clearTimeout(logoutRedirectTimer);
        logoutRedirectTimer = null;
      }

      var mainContent = document.getElementById('commanderMainContent');

      if (!user) {
        if (mainContent) mainContent.style.display = 'none';
        logoutRedirectTimer = setTimeout(function() {
          if (firebase.auth().currentUser) return;
          clearTimeout(authBootTimer);
          showStatus('No has iniciado sesión. Redirigiendo a login...', 'error');
          setTimeout(function() {
            window.location.href = '/login';
          }, 1500);
        }, 900);
        return;
      }

      verifyRangoForUser(user);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      checkCommanderAccess();
      initCommanderTabs();
      initTelemetryPlaceholders();
    });
  } else {
    checkCommanderAccess();
    initCommanderTabs();
    initTelemetryPlaceholders();
  }
})();


