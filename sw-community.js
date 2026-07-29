/* Service Worker - El Nexo Community PWA (v3)
 * Solo cachea la sección Community. No intercepta login/Steam/dashboard.
 * Al subir la versión se descarta el caché anterior (activate borra las que no
 * coinciden), necesario cuando cambia community.js o community.html.
 */
const CACHE_NAME = 'nexus-community-v3';

const COMMUNITY_ASSETS = [
  'community.html',
  'community.css',
  'community.js',
  'dashboard-styles.css'
];

function isCommunityPath(pathname) {
  const p = (pathname || '').toLowerCase();
  return p === '/community.html'
    || p.endsWith('/community.html')
    || p.endsWith('/community.css')
    || p.endsWith('/community.js');
}

function isAuthPath(pathname) {
  const p = (pathname || '').toLowerCase();
  return /\/(login\.html?|steam-login-handler\.html?|steam_login\.php|steam-callback\.html?|steam_bridge\.html?)/.test(p)
    || p.includes('/auth/');
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(COMMUNITY_ASSETS).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (isAuthPath(url.pathname)) return;

  const isNav = e.request.mode === 'navigate';
  const isAsset = /\.(css|js|png|jpg|ico|woff2?)$/i.test(url.pathname);
  if (!isCommunityPath(url.pathname) && !(isAsset && url.pathname.toLowerCase().includes('community'))) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        if (isNav) {
          const fallback = await caches.match('community.html') || await caches.match('/community.html');
          if (fallback) return fallback;
        }
        return Response.error();
      })
  );
});
