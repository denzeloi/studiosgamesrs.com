/**
 * Inicialización Firebase compartida.
 * App Check (reCAPTCHA) desactivado por defecto: no inyecta pruebas "no soy robot" en el sitio.
 * Para activarlo más adelante (consola Firebase + enforcement): window.SG_ENABLE_APP_CHECK = true antes de sgInitFirebaseApp().
 */
(function (global) {
  'use strict';

  var SG_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBiGoggMhj_yCE7NbmXKE9VqneG0uqyDrU',
    authDomain: 'studiosgamesrs.firebaseapp.com',
    databaseURL: 'https://studiosgamesrs-default-rtdb.firebaseio.com',
    projectId: 'studiosgamesrs',
    storageBucket: 'studiosgamesrs.firebasestorage.app',
    messagingSenderId: '113076073338',
    appId: '1:113076073338:web:87eeb06ede2761eb029cc3',
    measurementId: 'G-QEZMYESPRJ'
  };

  var SG_APP_CHECK_RECAPTCHA_SITE_KEY = '6LfxK9srAAAAAFPWFQXade8Zj0Vv5aVYpmqOfi4n';
  var DB_READY_TIMEOUT_MS = 3000;
  var dbReadyPromise = null;

  global.SG_FIREBASE_CONFIG = SG_FIREBASE_CONFIG;

  function appCheckEnabled() {
    return global.SG_ENABLE_APP_CHECK === true && !!SG_APP_CHECK_RECAPTCHA_SITE_KEY;
  }

  function activateAppCheckNow() {
    if (!appCheckEnabled()) return;
    if (global.__sgAppCheckActivated || global.__sgAppCheckDisabled) return;
    if (typeof firebase === 'undefined' || !firebase.appCheck) return;
    if (!document.body) return;

    try {
      firebase.appCheck().activate(
        new firebase.appCheck.ReCaptchaV3Provider(SG_APP_CHECK_RECAPTCHA_SITE_KEY),
        true
      );
      global.__sgAppCheckActivated = true;
    } catch (err) {
      console.warn('[SGRS] App Check:', err && err.message ? err.message : err);
      global.__sgAppCheckDisabled = true;
    }
  }

  function scheduleAppCheckActivation() {
    if (!appCheckEnabled()) return;
    if (global.__sgAppCheckScheduled || global.__sgAppCheckActivated || global.__sgAppCheckDisabled) {
      return;
    }
    global.__sgAppCheckScheduled = true;

    function run() {
      if (global.__sgAppCheckActivated || global.__sgAppCheckDisabled) return;
      if (!document.body) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', run, { once: true });
        } else {
          setTimeout(run, 0);
        }
        return;
      }
      activateAppCheckNow();
    }

    run();
  }

  function resolveDbReadyOnce(resolve) {
    resolve();
  }

  global.sgInitFirebaseApp = function sgInitFirebaseApp() {
    if (typeof firebase === 'undefined') {
      throw new Error('Firebase SDK no cargado');
    }
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(SG_FIREBASE_CONFIG);
    }
    if (!appCheckEnabled()) {
      global.__sgAppCheckDisabled = true;
    } else {
      scheduleAppCheckActivation();
    }
    return firebase.app();
  };

  global.sgWaitForDbReady = function sgWaitForDbReady() {
    if (!appCheckEnabled() || global.__sgAppCheckDisabled) {
      return Promise.resolve();
    }
    if (dbReadyPromise) return dbReadyPromise;

    dbReadyPromise = new Promise(function (resolve) {
      var start = Date.now();

      function attempt() {
        scheduleAppCheckActivation();

        if (global.__sgAppCheckDisabled) {
          resolveDbReadyOnce(resolve);
          return;
        }

        if (global.__sgAppCheckActivated) {
          resolveDbReadyOnce(resolve);
          return;
        }

        if (Date.now() - start >= DB_READY_TIMEOUT_MS) {
          resolveDbReadyOnce(resolve);
          return;
        }

        setTimeout(attempt, 50);
      }

      if (typeof firebase === 'undefined' || !firebase.appCheck) {
        resolve();
        return;
      }

      attempt();
    });

    return dbReadyPromise;
  };
})(typeof window !== 'undefined' ? window : this);
