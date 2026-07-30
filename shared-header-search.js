/* Shared header user search — StudiosGamesRS
 *
 * Backs the #userSearchInput box on pages that carry the unified header but have
 * no page-specific search logic of their own (Dashboard, Competition Hub and
 * Commander Panel wire their own richer versions and are skipped).
 */
(function () {
  'use strict';

  var MIN_CHARS = 3;
  var DEBOUNCE_MS = 300;
  var MAX_RESULTS = 6;
  var FALLBACK_AVATAR = 'dragon_profile_studiosgamesrs.png';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function init() {
    var input = document.getElementById('userSearchInput');
    var results = document.getElementById('searchResults');
    if (!input || !results || input.dataset.searchWired) return;
    input.dataset.searchWired = '1';

    var timer = null;
    var token = 0;

    function close() {
      results.style.display = 'none';
      results.classList.remove('open');
    }

    function open(html) {
      results.innerHTML = html;
      results.style.display = 'block';
      results.classList.add('open');
    }

    function render(items) {
      if (!items.length) {
        open('<div class="search-result-item">Sin resultados.</div>');
        return;
      }
      open(items.map(function (u) {
        return '<div class="search-result-item" data-user-id="' + escapeHtml(u.uid) + '">' +
          '<img src="' + escapeHtml(u.photoURL) + '" alt="" class="search-result-img" style="border:2px solid #4bdfff;">' +
          '<div class="search-result-info">' +
            '<div class="search-result-nick">' + escapeHtml(u.nick) + '</div>' +
            '<div class="search-result-rank" style="color:#4bdfff;">Jugador</div>' +
          '</div></div>';
      }).join(''));

      results.querySelectorAll('.search-result-item[data-user-id]').forEach(function (row) {
        row.addEventListener('click', function () {
          window.location.href = '/dashboard?uid=' + encodeURIComponent(row.dataset.userId);
        });
      });
    }

    function search(query) {
      if (typeof firebase === 'undefined' || !firebase.database) return;
      var mine = ++token;
      open('<div class="search-result-item">Buscando...</div>');

      firebase.database().ref('publicProfiles').once('value').then(function (snap) {
        if (mine !== token) return;
        var found = [];
        snap.forEach(function (child) {
          if (found.length >= MAX_RESULTS) return true;
          var data = child.val() || {};
          var nick = data.nick || '';
          if (nick.toLowerCase().indexOf(query) !== -1) {
            found.push({ uid: child.key, nick: nick, photoURL: data.photoURL || FALLBACK_AVATAR });
          }
          return false;
        });
        render(found);
      }).catch(function () {
        if (mine !== token) return;
        open('<div class="search-result-item">Error en la b&uacute;squeda.</div>');
      });
    }

    input.addEventListener('input', function () {
      var query = input.value.trim().toLowerCase();
      if (timer) clearTimeout(timer);
      if (query.length < MIN_CHARS) {
        token++;
        close();
        return;
      }
      timer = setTimeout(function () { search(query); }, DEBOUNCE_MS);
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.header-search')) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
