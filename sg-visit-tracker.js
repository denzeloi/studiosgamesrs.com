/*
 * sg-visit-tracker.js — Rastreador ligero de visitas y sesiones para Studiosgamesrs.
 *
 * Qué hace (solo con usuario autenticado):
 *   1) Marca al usuario como "activo hoy" en visits/daily/{fecha}/{uid}  -> sirve para
 *      contar cuántos usuarios han iniciado sesión / entrado hoy (en tiempo real).
 *   2) Suma una visita a la página actual en visits/pages/{fecha}/{pageKey} -> sirve para
 *      contar visitas a TODAS las páginas (incluyendo home).
 *   3) Mantiene la presencia con marca de tiempo (presence/{uid}.since) para poder medir
 *      la permanencia media (tiempo que la gente pasa en el sitio).
 *
 * Cómo usarlo: incluye este script DESPUÉS de firebase-app/-auth/-database en cualquier página
 *   (dashboard, playzone, commander-panel, home, etc.). No requiere configuración extra:
 *   reutiliza la app de Firebase ya inicializada en la página.
 *
 *   <script src="sg-visit-tracker.js"></script>
 */
(function () {
  'use strict';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dateKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // Convierte la ruta actual en una clave válida para Firebase (sin . # $ [ ] /).
  function pageKey() {
    try {
      var p = (location.pathname || '/').toLowerCase();
      p = p.replace(/index\.html?$/, '').replace(/\.html?$/, '');
      p = p.replace(/^\/+|\/+$/g, ''); // quita barras al inicio/fin
      if (!p) return 'home';
      var key = p.replace(/[.#$\[\]\/]+/g, '_');
      return key || 'home';
    } catch (e) { return 'unknown'; }
  }

  function track(user) {
    if (!user) return;
    var db, srv;
    try {
      db = firebase.database();
      srv = firebase.database.ServerValue.TIMESTAMP;
    } catch (e) { return; }

    var date = dateKey();
    var uid = user.uid;

    // 1) Usuario activo hoy (+ contador de visitas del propio usuario).
    try {
      db.ref('visits/daily/' + date + '/' + uid).transaction(function (cur) {
        cur = cur || {};
        cur.count = (cur.count || 0) + 1;
        cur.lastAt = Date.now();
        if (!cur.firstAt) cur.firstAt = Date.now();
        return cur;
      });
    } catch (e) {}

    // 2) Contador de visitas por página (incluye home).
    try {
      db.ref('visits/pages/' + date + '/' + pageKey()).transaction(function (c) {
        return (c || 0) + 1;
      });
    } catch (e) {}

    // 3) Presencia con marca de tiempo para medir permanencia.
    //    Solo se establece si aún no hay 'since' de esta sesión, para no reiniciar el contador
    //    cuando el usuario navega entre páginas del sitio en la misma pestaña.
    try {
      var presRef = db.ref('presence/' + uid);
      presRef.child('since').once('value').then(function (snap) {
        var since = snap.exists() ? snap.val() : Date.now();
        presRef.onDisconnect().remove();
        presRef.update({ online: true, since: since, lastPage: pageKey(), lastAt: Date.now() });
      }).catch(function () {});
    } catch (e) {}
  }

  function start() {
    if (typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length || !firebase.auth) {
      // Firebase aún no está listo; reintenta poco después.
      return setTimeout(start, 600);
    }
    try {
      firebase.auth().onAuthStateChanged(function (user) {
        if (user) track(user);
      });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
