/**
 * Site-wide config — Steam auth runs on PHP hosting (studiosgamesrs.com), not Firebase Hosting.
 */
(function (global) {
  'use strict';

  var host = global.location ? global.location.hostname : '';
  var onFirebaseHosting = host.indexOf('web.app') !== -1 || host.indexOf('firebaseapp.com') !== -1;

  // PHP + Steam OpenID live on the main domain (cPanel)
  var MAIN_SITE = 'https://studiosgamesrs.com';

  global.SITE_CONFIG = {
    mainSite: MAIN_SITE,
    steamAuthBase: onFirebaseHosting ? MAIN_SITE : '',
    dashboardPath: '/dashboard',
    getSteamAuthUrl: function (intent) {
      var base = onFirebaseHosting ? MAIN_SITE : '';
      var returnTo = encodeURIComponent(global.location.origin + '/dashboard');
      return base + '/steam_login.php?intent=' + encodeURIComponent(intent) + '&return_to=' + returnTo;
    },
  };
})(typeof window !== 'undefined' ? window : this);
