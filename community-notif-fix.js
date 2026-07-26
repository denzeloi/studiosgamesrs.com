/**
 * Community — integración con header y notificaciones unificadas.
 * Cargar DESPUÉS de community.js si la página aún tiene initNotificationsToggle legacy.
 */
(function() {
  'use strict';

  function patchCommunityBell() {
    if (!/\/community/i.test(window.location.pathname)) return;

    var btn = document.getElementById('notificationsToggleBtn');
    if (!btn || btn.dataset.sgFixed === '1') return;

    if (document.getElementById('headerNotificationsPanel')) {
      var clone = btn.cloneNode(true);
      clone.dataset.sgFixed = '1';
      clone.id = 'notificationsToggleBtn';
      btn.parentNode.replaceChild(clone, btn);
      clone._sgNotifBound = false;
      if (window.SGNotifications && typeof window.SGNotifications.init === 'function') {
        window.SGNotifications.init();
      }
    }
  }

  function run() {
    setTimeout(patchCommunityBell, 120);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
