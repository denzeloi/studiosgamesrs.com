/**
 * Header unificado StudiosGamesRS — extras en todas las páginas
 * - Panel de notificaciones si falta
 * - Botón Commander para rangos autorizados
 * - Resalta sección activa en el menú
 */
(function() {
  'use strict';

  var NAV_PAGES = [
    { path: '/dashboard', label: 'Dashboard', icon: 'fa-th-large', key: 'dashboard' },
    { path: '/community', label: 'Comunidad', icon: 'fa-users', key: 'community' },
    { path: '/nexus', label: 'Nexus', icon: 'fa-bolt', key: 'nexus' },
    { path: '/playzone', label: 'PlayZone', icon: 'fa-flag-checkered', key: 'playzone' },
    { path: '/competition-hub', label: 'Competition', icon: 'fa-trophy', key: 'competition-hub' }
  ];

  function getDb() {
    return (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
  }

  function detectPageKey() {
    var p = (window.location.pathname || '').toLowerCase().replace(/\.html$/, '');
    if (p.indexOf('commander') !== -1) return 'commander-panel';
    if (p.indexOf('competition') !== -1) return 'competition-hub';
    if (p.indexOf('community') !== -1) return 'community';
    if (p.indexOf('nexus') !== -1) return 'nexus';
    if (p.indexOf('playzone') !== -1) return 'playzone';
    if (p.indexOf('dashboard') !== -1 || p === '/' || p === '') return 'dashboard';
    return '';
  }

  function ensureNotificationPanel() {
    if (document.getElementById('headerNotificationsPanel')) return;
    var btn = document.getElementById('notificationsToggleBtn');
    if (!btn) return;

    var wrap = btn.closest('.header-notifications-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'header-notifications-wrap';
      btn.parentNode.insertBefore(wrap, btn);
      wrap.appendChild(btn);
    }

    if (!document.getElementById('headerNotifBadge')) {
      var badge = document.createElement('span');
      badge.id = 'headerNotifBadge';
      badge.className = 'header-notif-badge';
      badge.style.display = 'none';
      badge.textContent = '0';
      btn.appendChild(badge);
    }

    var panel = document.createElement('div');
    panel.id = 'headerNotificationsPanel';
    panel.className = 'header-notifications-panel';
    panel.style.display = 'none';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Notificaciones');
    panel.innerHTML =
      '<div class="header-notif-head">' +
        '<span><i class="fas fa-bell"></i> Notificaciones</span>' +
        '<button type="button" class="header-notif-refresh" id="headerNotifRefreshBtn" title="Actualizar"><i class="fas fa-sync-alt"></i></button>' +
      '</div>' +
      '<div id="headerNotificationsList" class="header-notifications-list">' +
        '<p class="header-notif-empty">No tienes notificaciones.</p>' +
      '</div>';
    wrap.appendChild(panel);
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'true');
  }

  function ensureCommanderButton() {
    var actions = document.querySelector('.unified-header .header-actions, .header-actions');
    if (!actions) return;

    var btn = document.getElementById('commanderPanelBtn');
    if (!btn) {
      btn = document.createElement('a');
      btn.href = '/commander-panel';
      btn.className = 'icon-btn commander-panel-btn';
      btn.id = 'commanderPanelBtn';
      btn.title = 'Panel de Commander';
      btn.setAttribute('aria-label', 'Panel de Commander');
      btn.style.display = 'none';
      btn.innerHTML = '<i class="fas fa-user-shield"></i>';
      var themeBtn = actions.querySelector('#theme-icon, [onclick*="toggleTheme"]');
      var anchor = themeBtn ? themeBtn.closest('button, .icon-btn') || themeBtn : null;
      if (anchor && anchor.parentNode === actions) {
        actions.insertBefore(btn, anchor);
      } else {
        var accountEnd = actions.querySelector('.header-account-end');
        if (accountEnd) actions.insertBefore(btn, accountEnd);
        else actions.appendChild(btn);
      }
    }

    var db = getDb();
    if (!db || typeof firebase.auth === 'undefined') return;

    firebase.auth().onAuthStateChanged(function(user) {
      if (!user) {
        btn.style.display = 'none';
        return;
      }
      db.ref('users/' + user.uid + '/rango').once('value').then(function(snap) {
        var r = String(snap.val() || '').toLowerCase().replace(/\s/g, '_');
        var show = r === 'commander' || r === 'divisional_commander' || r === 'boss_of_the_state';
        btn.style.display = show ? 'inline-flex' : 'none';
      }).catch(function() { btn.style.display = 'none'; });
    });
  }

  function syncNavDropdown() {
    var menu = document.querySelector('.nav-dropdown-menu');
    var currentLabel = document.querySelector('.nav-dropdown-current');
    if (!menu) return;

    var pageKey = detectPageKey();
    var paths = {};
    NAV_PAGES.forEach(function(p) { paths[p.path] = p; });

    var hasCompetition = menu.querySelector('a[href*="competition"]');
    if (!hasCompetition) {
      var playzoneLink = menu.querySelector('a[href*="playzone"]');
      if (playzoneLink) {
        var comp = document.createElement('a');
        comp.href = '/competition-hub';
        comp.setAttribute('role', 'menuitem');
        comp.innerHTML = '<i class="fas fa-trophy"></i> Competition';
        playzoneLink.parentNode.insertBefore(comp, playzoneLink.nextSibling);
      }
    }

    menu.querySelectorAll('a[role="menuitem"]').forEach(function(a) {
      a.classList.remove('current');
      var href = (a.getAttribute('href') || '').toLowerCase();
      NAV_PAGES.forEach(function(p) {
        if (pageKey === p.key && href.indexOf(p.key.replace('-hub', '')) !== -1) {
          a.classList.add('current');
        }
      });
      if (pageKey === 'competition-hub' && href.indexOf('competition') !== -1) a.classList.add('current');
      if (pageKey === 'commander-panel' && href.indexOf('commander') !== -1) a.classList.add('current');
    });

    if (currentLabel) {
      if (pageKey === 'commander-panel') currentLabel.textContent = 'Commander';
      else if (pageKey === 'competition-hub') currentLabel.textContent = 'Competition';
      else {
        var match = NAV_PAGES.find(function(p) { return p.key === pageKey; });
        if (match) currentLabel.textContent = match.label;
      }
    }
  }

  function init() {
    ensureNotificationPanel();
    ensureCommanderButton();
    syncNavDropdown();
    if (window.SGNotifications && typeof window.SGNotifications.init === 'function') {
      window.SGNotifications.init();
    }
  }

  window.SGUnifiedHeader = { init: init, detectPageKey: detectPageKey };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
