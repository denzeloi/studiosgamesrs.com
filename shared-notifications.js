/**
 * Notificaciones unificadas — TODAS las páginas StudiosGamesRS
 * Fuentes: sistema, amistad, misiones, Creator Market, equipo, chats, partidas, visitas
 */
(function() {
  'use strict';

  var SECTION_ORDER = ['Creator Market', 'Social', 'Mensajes', 'Misiones', 'Sistema', 'Visitas'];

  var state = {
    uid: null,
    notifications: {},
    friendRequests: {},
    missionInvites: {},
    creatorApp: null,
    userData: null,
    dynamic: [],
    attached: false,
    refreshing: false,
    panelWasOpen: false
  };

  function getSeen() {
    var ud = state.userData || {};
    return ud.notificationSeen || {};
  }

  function isFriendUnread(uid) {
    var seen = getSeen().friends || {};
    return !seen[uid];
  }

  function isMissionInviteUnread(mid) {
    var seen = getSeen().missionInvites || {};
    return !seen[mid];
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function parseTime(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      var n = Date.parse(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = typeof ts === 'number' ? new Date(ts) : new Date();
    return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function getDb() {
    return (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
  }

  function countUnread() {
    var unread = Object.keys(state.notifications).filter(function(id) {
      var n = state.notifications[id];
      return n && !n.read;
    }).length;
    var friends = Object.keys(state.friendRequests).filter(function(uid) {
      return isFriendUnread(uid);
    }).length;
    var missions = Object.keys(state.missionInvites).filter(function(mid) {
      return isMissionInviteUnread(mid);
    }).length;
    var dynamic = state.dynamic.filter(function(d) { return d.unread; }).length;
    var creatorPending = 0;
    if (state.creatorApp && state.creatorApp.status === 'pending') {
      var seenCreator = getSeen().creatorMarket;
      var dup = Object.keys(state.notifications).some(function(id) {
        var n = state.notifications[id];
        return n && n.type === 'creator_market' && !n.read;
      });
      creatorPending = (!seenCreator && !dup) ? 1 : 0;
    }
    return unread + friends + missions + dynamic + creatorPending;
  }

  function setNested(obj, keys, val) {
    var cur = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = val;
  }

  function mergeSeenFromUpdates(updates) {
    if (!state.uid) return;
    var prefix = 'users/' + state.uid + '/notificationSeen/';
    if (!state.userData) state.userData = {};
    if (!state.userData.notificationSeen) state.userData.notificationSeen = {};
    Object.keys(updates).forEach(function(path) {
      if (path.indexOf(prefix) !== 0) return;
      var rel = path.slice(prefix.length);
      if (!rel) return;
      setNested(state.userData.notificationSeen, rel.split('/'), updates[path]);
    });
  }

  async function markAsReviewed() {
    if (!state.uid) return;
    var db = getDb();
    if (!db) return;
    var uid = state.uid;
    var now = Date.now();
    var updates = {};
    var seen = getSeen();

    Object.keys(state.notifications).forEach(function(id) {
      var n = state.notifications[id];
      if (n && !n.read) {
        updates['users/' + uid + '/notifications/' + id + '/read'] = true;
        n.read = true;
      }
    });

    Object.keys(state.friendRequests).forEach(function(senderUid) {
      updates['users/' + uid + '/notificationSeen/friends/' + senderUid] = now;
    });

    Object.keys(state.missionInvites).forEach(function(missionId) {
      updates['users/' + uid + '/notificationSeen/missionInvites/' + missionId] = now;
    });

    if (state.creatorApp && state.creatorApp.status === 'pending') {
      updates['users/' + uid + '/notificationSeen/creatorMarket'] = now;
    }

    try {
      var teamSnap = await db.ref('teamInvites/' + uid).once('value');
      updates['users/' + uid + '/notificationSeen/teamInvites/count'] = teamSnap.exists() ? teamSnap.numChildren() : 0;
      updates['users/' + uid + '/notificationSeen/teamInvites/at'] = now;
    } catch (e) {}

    try {
      var pzSnap = await db.ref('playzoneChatInvites/' + uid).once('value');
      updates['users/' + uid + '/notificationSeen/playzoneChat/count'] = pzSnap.exists() ? pzSnap.numChildren() : 0;
      updates['users/' + uid + '/notificationSeen/playzoneChat/at'] = now;
    } catch (e) {}

    var match = state.userData && state.userData.competitive && state.userData.competitive.match;
    if (match && match.opponent) {
      updates['users/' + uid + '/notificationSeen/upcomingMatch'] = String(match.time || '') + '|' + String(match.opponent || '');
    }

    state.dynamic.forEach(function(d) {
      if (!d.seenKey) return;
      updates['users/' + uid + '/notificationSeen/dynamic/' + d.seenKey] = now;
      if (d.seenKey.indexOf('mission_') === 0) {
        updates['users/' + uid + '/notificationSeen/missions/' + d.seenKey.slice(8)] = now;
      }
      if (d.seenKey.indexOf('visit_') === 0) {
        updates['users/' + uid + '/notificationSeen/visits/' + d.seenKey.slice(6)] = now;
      }
    });

    updates['users/' + uid + '/notificationSeen/lastPanelOpen'] = now;

    try {
      await db.ref().update(updates);
      mergeSeenFromUpdates(updates);
    } catch (err) {
      console.warn('SGNotifications markAsReviewed:', err);
    }

    state.dynamic.forEach(function(d) { d.unread = false; });
    await refreshDynamic();
    updateBadge();
  }

  function updateBadge() {
    var badge = document.getElementById('headerNotifBadge');
    if (!badge) return;
    var total = countUnread();
    if (total > 0) {
      badge.style.display = 'inline-flex';
      badge.textContent = total > 99 ? '99+' : String(total);
    } else {
      badge.style.display = 'none';
      badge.textContent = '0';
    }
  }

  function itemHtml(opts) {
    var cls = 'header-notif-item' + (opts.unread ? ' unread' : '') + (opts.extraClass ? ' ' + opts.extraClass : '');
    var attrs = opts.attrs || '';
    var actions = opts.actions || '';
    var icon = opts.icon ? '<i class="fas ' + esc(opts.icon) + '"></i> ' : '';
    return '<div class="' + cls + '" ' + attrs + '>' +
      '<strong>' + icon + esc(opts.title) + '</strong>' +
      '<p>' + esc(opts.text) + '</p>' +
      (opts.time ? '<span class="header-notif-time">' + esc(opts.time) + '</span>' : '') +
      actions + '</div>';
  }

  function buildItems() {
    var items = [];

    if (state.creatorApp) {
      var st = state.creatorApp.status;
      if (st === 'pending') {
        var creatorUnread = !getSeen().creatorMarket;
        items.push({ section: 'Creator Market', sort: Date.now(), unread: creatorUnread,
          html: itemHtml({ title: 'Creator Market — solicitud enviada', text: 'Tu petición está en revisión por los Commanders.',
            icon: 'fa-store', time: fmtTime(state.creatorApp.submittedAt), unread: true, extraClass: 'creator-pending',
            attrs: 'data-creator-action="open-market"' }) });
      } else if (st === 'approved') {
        items.push({ section: 'Creator Market', sort: (state.creatorApp.reviewedAt || 0) + 1e12, unread: false,
          html: itemHtml({ title: 'Creator Market — aprobado', text: 'Ya puedes publicar en Facebook y ganar por métricas.',
            icon: 'fa-check-circle', time: fmtTime(state.creatorApp.reviewedAt), extraClass: 'creator-approved',
            attrs: 'data-creator-action="open-market"' }) });
      } else if (st === 'rejected') {
        items.push({ section: 'Creator Market', sort: (state.creatorApp.reviewedAt || 0) + 5e11, unread: true,
          html: itemHtml({ title: 'Creator Market — no aprobado', text: state.creatorApp.reviewNote || 'Puedes enviar una nueva solicitud.',
            icon: 'fa-times-circle', time: fmtTime(state.creatorApp.reviewedAt), extraClass: 'creator-rejected',
            attrs: 'data-creator-action="open-market"' }) });
      }
    }

    Object.keys(state.friendRequests).forEach(function(senderUid) {
      var req = state.friendRequests[senderUid];
      items.push({ section: 'Social', sort: req.timestamp || 0, unread: isFriendUnread(senderUid),
        html: itemHtml({ title: req.senderNick || 'Jugador', text: 'Solicitud de amistad' + (req.message ? ': "' + req.message + '"' : ''),
          icon: 'fa-user-plus', unread: true,
          actions: '<div class="header-notif-actions">' +
            '<button type="button" class="header-notif-btn accept" data-friend-accept="' + esc(senderUid) + '">Aceptar</button>' +
            '<button type="button" class="header-notif-btn decline" data-friend-decline="' + esc(senderUid) + '">Rechazar</button></div>' }) });
    });

    Object.keys(state.missionInvites).forEach(function(missionId) {
      var inv = state.missionInvites[missionId];
      items.push({ section: 'Misiones', sort: inv.timestamp || inv.at || Date.now(), unread: isMissionInviteUnread(missionId),
        html: itemHtml({ title: 'Invitación a misión', text: (inv.fromNick || 'Jugador') + ': ' + (inv.missionTitle || 'Misión'),
          icon: 'fa-envelope', unread: true,
          actions: '<div class="header-notif-actions"><button type="button" class="header-notif-btn accept" data-mission-open="' + esc(missionId) + '">Ver en PlayZone</button></div>' }) });
    });

    state.dynamic.forEach(function(d) {
      items.push(d);
    });

    Object.keys(state.notifications).forEach(function(id) {
      var n = state.notifications[id];
      if (!n || !n.text) return;
      if (state.creatorApp && n.type === 'creator_market') return;
      var icon = (n.icon && n.icon.indexOf('fa-') === 0) ? n.icon : 'fa-bell';
      items.push({ section: 'Sistema', sort: n.timestamp || n.at || 0, unread: !n.read,
        html: itemHtml({ title: 'StudiosGamesRS', text: n.text, icon: icon, time: fmtTime(n.timestamp || n.at),
          unread: !n.read, attrs: 'data-notif-id="' + esc(id) + '"' + (n.link ? ' data-notif-link="' + esc(n.link) + '"' : '') }) });
    });

    return items;
  }

  function renderList() {
    var list = document.getElementById('headerNotificationsList');
    if (!list) return;

    var items = buildItems();
    items.sort(function(a, b) { return (b.sort || 0) - (a.sort || 0); });

    if (!items.length) {
      list.innerHTML = '<p class="header-notif-empty">No tienes notificaciones.</p>';
      updateBadge();
      return;
    }

    var grouped = {};
    items.forEach(function(it) {
      var sec = it.section || 'Sistema';
      if (!grouped[sec]) grouped[sec] = [];
      grouped[sec].push(it);
    });

    var html = '';
    SECTION_ORDER.forEach(function(sec) {
      if (!grouped[sec] || !grouped[sec].length) return;
      html += '<div class="header-notif-section">' + esc(sec) + '</div>';
      grouped[sec].forEach(function(it) { html += it.html; });
    });
    Object.keys(grouped).forEach(function(sec) {
      if (SECTION_ORDER.indexOf(sec) !== -1) return;
      html += '<div class="header-notif-section">' + esc(sec) + '</div>';
      grouped[sec].forEach(function(it) { html += it.html; });
    });

    list.innerHTML = html;
    bindItemEvents(list);
    updateBadge();
  }

  function bindItemEvents(list) {
    list.querySelectorAll('[data-notif-id]').forEach(function(el) {
      el.addEventListener('click', function() {
        var nid = el.getAttribute('data-notif-id');
        var link = el.getAttribute('data-notif-link');
        if (nid && state.uid) {
          getDb().ref('users/' + state.uid + '/notifications/' + nid).update({ read: true });
          if (state.notifications[nid]) state.notifications[nid].read = true;
          el.classList.remove('unread');
          updateBadge();
        }
        if (link) window.location.href = link;
      });
    });
    list.querySelectorAll('[data-creator-action="open-market"]').forEach(function(el) {
      el.addEventListener('click', function() {
        if (window.location.pathname.indexOf('nexus') !== -1 && typeof toggleNexusPanel === 'function') {
          toggleNexusPanel('creator-market', true);
        } else {
          window.location.href = '/nexus';
        }
      });
    });
    list.querySelectorAll('[data-mission-open]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        window.location.href = '/playzone';
      });
    });
    list.querySelectorAll('[data-friend-accept]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var uid = btn.getAttribute('data-friend-accept');
        if (typeof acceptFriendRequest === 'function') {
          acceptFriendRequest(Object.assign({ senderUid: uid }, state.friendRequests[uid] || {}));
        }
      });
    });
    list.querySelectorAll('[data-friend-decline]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var uid = btn.getAttribute('data-friend-decline');
        if (typeof declineFriendRequest === 'function') declineFriendRequest(uid);
      });
    });
    list.querySelectorAll('[data-dynamic-link]').forEach(function(el) {
      el.addEventListener('click', function() {
        var link = el.getAttribute('data-dynamic-link');
        if (link) window.location.href = link;
        var chatMark = el.getAttribute('data-chat-mark');
        if (chatMark && state.uid) {
          var parts = chatMark.split('/');
          if (parts.length === 2) {
            getDb().ref('users/' + state.uid + '/notificationSeen/chat/' + parts[0] + '/' + parts[1]).set(Date.now());
          }
        }
      });
    });
  }

  function pushDynamic(section, sort, unread, title, text, icon, link, extra) {
    state.dynamic.push({
      section: section,
      sort: sort,
      unread: !!unread,
      seenKey: extra && extra.seenKey ? extra.seenKey : null,
      html: itemHtml({
        title: title,
        text: text,
        icon: icon || 'fa-bell',
        unread: !!unread,
        attrs: (link ? 'data-dynamic-link="' + esc(link) + '" ' : '') + (extra && extra.attrs ? extra.attrs : ''),
        time: extra && extra.time ? fmtTime(extra.time) : ''
      })
    });
  }

  async function refreshDynamic() {
    if (!state.uid || state.refreshing) return;
    var db = getDb();
    if (!db) return;
    state.refreshing = true;
    var uid = state.uid;
    var ud = state.userData || {};
    var seen = getSeen();
    state.dynamic = [];

    try {
      var teamSnap = await db.ref('teamInvites/' + uid).once('value');
      if (teamSnap.exists()) {
        var tc = teamSnap.numChildren();
        var seenTeamCount = (seen.teamInvites && seen.teamInvites.count) || 0;
        if (tc > seenTeamCount) {
          pushDynamic('Mensajes', Date.now() - 1000, true, 'Invitaciones de equipo',
            tc + ' invitación' + (tc > 1 ? 'es' : '') + ' pendiente' + (tc > 1 ? 's' : ''), 'fa-users', '/competition-hub',
            { seenKey: 'teamInvites' });
        }
      }

      var pzChatSnap = await db.ref('playzoneChatInvites/' + uid).once('value');
      if (pzChatSnap.exists()) {
        var pc = pzChatSnap.numChildren();
        var seenPzCount = (seen.playzoneChat && seen.playzoneChat.count) || 0;
        if (pc > seenPzCount) {
          pushDynamic('Mensajes', Date.now() - 1500, true, 'Chat de misión',
            pc + ' invitación' + (pc > 1 ? 'es' : '') + ' a chat', 'fa-comments', '/playzone',
            { seenKey: 'playzoneChat' });
        }
      }

      var seenRoot = (ud.notificationSeen && ud.notificationSeen.chat) || {};
      var chatChecks = [];
      if (ud.teamId) chatChecks.push({ node: 'teamChats', chatId: ud.teamId, label: 'Chat de equipo' });

      try {
        var missionsSnap = await db.ref('missions').once('value');
        if (missionsSnap.exists()) {
          missionsSnap.forEach(function(ch) {
            var m = ch.val() || {};
            if (m.participants && m.participants[uid]) {
              chatChecks.push({ node: 'missionChats', chatId: ch.key, label: m.title || 'Chat de misión' });
            }
          });
        }
      } catch (e) {}

      await Promise.all(chatChecks.map(async function(c) {
        try {
          var snap = await db.ref(c.node + '/' + c.chatId + '/messages').orderByChild('timestamp').limitToLast(1).once('value');
          if (!snap.exists()) return;
          var last = null;
          snap.forEach(function(m) { last = m.val(); });
          if (!last) return;
          var ts = parseTime(last.timestamp);
          var fromMe = last.userId && last.userId === uid;
          var seenAt = parseTime(seenRoot[c.node] && seenRoot[c.node][c.chatId]);
          if (!fromMe && ts > seenAt) {
            pushDynamic('Mensajes', ts, true, c.label, last.text || 'Nuevo mensaje', 'fa-comment',
              '/dashboard', { attrs: 'data-chat-mark="' + esc(c.node + '/' + c.chatId) + '"', time: ts });
          }
        } catch (e) {}
      }));

      var match = ud.competitive && ud.competitive.match ? ud.competitive.match : null;
      if (match && match.opponent && match.opponent !== 'Ninguno') {
        var mt = parseTime(match.time);
        var matchKey = String(match.time || '') + '|' + String(match.opponent || '');
        if (seen.upcomingMatch !== matchKey) {
          pushDynamic('Misiones', mt || Date.now() - 2000, true, 'Próxima partida',
            'vs ' + match.opponent + (match.tournament ? ' (' + match.tournament + ')' : ''), 'fa-flag-checkered',
            '/competition-hub', { time: mt, seenKey: 'upcomingMatch' });
        }
      }

      try {
        var allMissions = await db.ref('missions').once('value');
        if (allMissions.exists()) {
          allMissions.forEach(function(ch) {
            var m = ch.val() || {};
            if (!m.participants || !m.participants[uid]) return;
            var at = parseTime(m.ingressTime || m.startAt || m.scheduledAt);
            var missionSeen = seen.missions && seen.missions[ch.key];
            if (at && at >= Date.now() - 15 * 60 * 1000 && (!missionSeen || missionSeen < at)) {
              pushDynamic('Misiones', at, true, 'Misión próxima', m.title || 'Misión sin título', 'fa-crosshairs',
                '/playzone', { time: at, seenKey: 'mission_' + ch.key });
            }
          });
        }
      } catch (e) {}

      try {
        var visSnap = await db.ref('users/' + uid + '/profileVisitors').orderByChild('visitedAt').limitToLast(3).once('value');
        var visitors = [];
        var seenVisits = seen.visits || {};
        if (visSnap.exists()) visSnap.forEach(function(c) { visitors.push(Object.assign({ id: c.key }, c.val())); });
        visitors.sort(function(a, b) { return parseTime(b.visitedAt) - parseTime(a.visitedAt); });
        visitors.forEach(function(v) {
          var vKey = v.visitorUid || v.id || '';
          var vAt = parseTime(v.visitedAt);
          var seenAt = parseTime(seenVisits[vKey]);
          if (vAt > seenAt) {
            pushDynamic('Visitas', vAt, true, 'Visita al perfil',
              (v.nick || 'Un jugador') + ' visitó tu perfil', 'fa-eye',
              v.visitorUid ? '/dashboard?uid=' + v.visitorUid : '/dashboard',
              { time: v.visitedAt, seenKey: 'visit_' + vKey });
          }
        });
      } catch (e) {}
    } catch (err) {
      console.warn('SGNotifications refresh:', err);
    }

    state.refreshing = false;
    renderList();
  }

  function cleanupLegacyPanels() {
    var legacy = document.getElementById('notificationsPanel');
    if (legacy) legacy.remove();
  }

  function positionPanel(toggle, panel) {
    if (!toggle || !panel) return;
    var rect = toggle.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = Math.round(rect.bottom + 8) + 'px';
    panel.style.right = Math.round(window.innerWidth - rect.right) + 'px';
    panel.style.left = 'auto';
    panel.style.bottom = 'auto';
    panel.style.width = 'min(360px, 92vw)';
  }

  function portalPanel(toggle, panel) {
    if (!panel || panel._sgPortaled) return;
    panel._sgPortalWrap = toggle ? toggle.closest('.header-notifications-wrap') : null;
    document.body.appendChild(panel);
    panel.classList.add('is-portaled');
    panel._sgPortaled = true;
  }

  function closePanel(toggle, panel) {
    if (!panel) panel = document.getElementById('headerNotificationsPanel');
    if (!panel) return;
    panel.classList.remove('is-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function openPanel(toggle, panel) {
    if (!toggle) toggle = document.getElementById('notificationsToggleBtn');
    if (!panel) panel = document.getElementById('headerNotificationsPanel');
    if (!toggle || !panel) return;
    portalPanel(toggle, panel);
    positionPanel(toggle, panel);
    panel.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    refreshDynamic().then(function() {
      return markAsReviewed();
    });
  }

  function handleToggleClick(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    var toggle = document.getElementById('notificationsToggleBtn');
    var panel = document.getElementById('headerNotificationsPanel');
    if (!toggle || !panel) return false;
    if (panel.classList.contains('is-open')) closePanel(toggle, panel);
    else openPanel(toggle, panel);
    return false;
  }

  function setupToggle() {
    cleanupLegacyPanels();

    var toggle = document.getElementById('notificationsToggleBtn');
    var panel = document.getElementById('headerNotificationsPanel');
    if (!toggle || !panel) return;

    if (!toggle._sgDirectBound) {
      toggle._sgDirectBound = true;
      toggle.onclick = function(e) { return handleToggleClick(e); };
    }

    if (!window._sgNotifOutsideBound) {
      window._sgNotifOutsideBound = true;
      document.addEventListener('click', function(e) {
        var refreshBtn = e.target.closest('#headerNotifRefreshBtn');
        if (refreshBtn) {
          e.preventDefault();
          e.stopPropagation();
          refreshBtn.classList.add('spinning');
          refreshDynamic().finally(function() {
            setTimeout(function() { refreshBtn.classList.remove('spinning'); }, 400);
          });
          return;
        }

        var panelEl = document.getElementById('headerNotificationsPanel');
        if (!panelEl || !panelEl.classList.contains('is-open')) return;
        if (e.target.closest('#headerNotificationsPanel') || e.target.closest('#notificationsToggleBtn')) return;
        closePanel(document.getElementById('notificationsToggleBtn'), panelEl);
      });
      window.addEventListener('resize', function() {
        var panelEl = document.getElementById('headerNotificationsPanel');
        var btn = document.getElementById('notificationsToggleBtn');
        if (panelEl && panelEl.classList.contains('is-open')) positionPanel(btn, panelEl);
      });
    }
  }

  function bindAuthWhenReady() {
    try {
      if (typeof firebase === 'undefined' || !firebase.auth) return false;
      if (!firebase.apps || !firebase.apps.length) return false;
      if (authBound) return true;
      authBound = true;
      firebase.auth().onAuthStateChanged(function(user) {
        if (!user) {
          state.attached = false;
          state.uid = null;
          state.dynamic = [];
          renderList();
          return;
        }
        state.attached = false;
        attachListeners(user.uid);
      });
      return true;
    } catch (err) {
      console.warn('SGNotifications auth deferred:', err);
      authBound = false;
      return false;
    }
  }

  function scheduleAuthBind() {
    if (bindAuthWhenReady()) return;
    var tries = 0;
    var timer = setInterval(function() {
      tries += 1;
      if (bindAuthWhenReady() || tries >= 60) clearInterval(timer);
    }, 100);
  }

  function attachListeners(uid) {
    var db = getDb();
    if (!db || !uid) return;
    if (state.attached && state.uid === uid) return;
    state.attached = true;
    state.uid = uid;

    db.ref('users/' + uid + '/notifications').limitToLast(50).on('value', function(snap) {
      state.notifications = snap.val() || {};
      renderList();
    });

    db.ref('friendRequests/' + uid).on('value', function(snap) {
      state.friendRequests = snap.val() || {};
      renderList();
    });

    db.ref('nexus/creatorApplications/' + uid).on('value', function(snap) {
      state.creatorApp = snap.val();
      renderList();
    });

    db.ref('missionInvites/' + uid).on('value', function(snap) {
      state.missionInvites = snap.val() || {};
      renderList();
    });

    db.ref('users/' + uid).on('value', function(snap) {
      state.userData = snap.val() || {};
      refreshDynamic();
    });

    refreshDynamic();
    if (!state._refreshInterval) {
      state._refreshInterval = setInterval(refreshDynamic, 45000);
    }
  }

  var authBound = false;

  function init() {
    cleanupLegacyPanels();
    setupToggle();
    setTimeout(setupToggle, 200);
    setTimeout(setupToggle, 1000);
    scheduleAuthBind();
  }

  window.SGNotifications = {
    init: init,
    toggle: handleToggleClick,
    open: function() { openPanel(); },
    close: function() { closePanel(); },
    push: function(uid, payload) {
      var db = getDb();
      if (!db || !uid) return Promise.resolve();
      return db.ref('users/' + uid + '/notifications').push({
        text: payload.text || '',
        icon: payload.icon || 'fa-bell',
        timestamp: Date.now(),
        read: false,
        type: payload.type || 'general',
        link: payload.link || null
      });
    },
    refresh: function() { return refreshDynamic(); },
    render: renderList,
    markAsReviewed: markAsReviewed
  };

  if (window.StudiosGamesRS) {
    window.StudiosGamesRS.addNotification = function(uid, text, icon, link) {
      return window.SGNotifications.push(uid, { text: text, icon: icon, link: link, type: 'general' });
    };
  } else {
    window.StudiosGamesRS = {
      addNotification: function(uid, text, icon, link) {
        return window.SGNotifications.push(uid, { text: text, icon: icon, link: link, type: 'general' });
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
