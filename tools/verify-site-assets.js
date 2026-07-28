#!/usr/bin/env node
/**
 * Verificación de integridad del sitio, enganchada en firebase.json como
 * predeploy (modo "local") y postdeploy (modo "live").
 *
 * El 27/07/2026 el sitio se rompió porque un despliegue hecho desde una copia
 * antigua del proyecto publicó un dashboard/commander-panel sin el script del
 * overlay, sin el importmap de Three.js y sin los modelos .glb: el overlay 3D
 * dejó de cargar y los modelos devolvían 404. Este chequeo existe para que eso
 * no pueda volver a publicarse en silencio:
 *
 *   - modo local: aborta el despliegue si falta un archivo crítico o si los
 *     HTML dejaron de enlazar el overlay. Vive en firebase.json, así que
 *     cualquier copia del proyecto lo ejecuta, no solo esta carpeta.
 *   - modo live: después de publicar, comprueba contra el dominio real que
 *     todo se esté sirviendo de verdad.
 *
 * Uso: node tools/verify-site-assets.js [local|live]
 * SG_VERIFY_ROOT permite apuntar a otra carpeta (se usa para probar el script).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MODE = (process.argv[2] || 'local').toLowerCase();
const ROOT = process.env.SG_VERIFY_ROOT || path.resolve(__dirname, '..');
const LIVE_ORIGIN = process.env.SG_VERIFY_ORIGIN || 'https://studiosgamesrs.web.app';

/** Archivos que el sitio necesita, con su tamaño mínimo razonable en KB. */
const REQUIRED_FILES = [
  { file: 'welcome-overlay.js', minKB: 20 },
  { file: 'welcome-overlay.css', minKB: 4 },
  { file: 'overlay-volcano.jpg', minKB: 60 },
  { file: 'overlay-cs2-desert.jpg', minKB: 100 },
  { file: 'logo-studiosgamesrs.png', minKB: 100 },
  { file: 'badges/lealtad-320.png', minKB: 60 },
  { file: 'badges/lealtad-512.png', minKB: 150 },
  { file: 'dashboard.html', minKB: 20 },
  { file: 'commander-panel.html', minKB: 40 },
  { file: 'commander-panel.js', minKB: 150 },
  { file: 'models/golem-tortoise/golem-idle.glb', minKB: 4000 },
  { file: 'models/golem-tortoise/golem-awake.glb', minKB: 4000 },
  { file: 'models/golem-tortoise/golem-roar.glb', minKB: 4000 },
  { file: 'models/golem-tortoise/golem-walk.glb', minKB: 4000 },
  { file: 'models/golem-tortoise/golem-hurt.glb', minKB: 4000 },
  { file: 'models/golem-tortoise/golem-faint.glb', minKB: 4000 },
  // El soldado se exportó con Draco + texturas WebP: pesa la mitad que el
  // golem, de ahí el mínimo distinto.
  { file: 'models/soldier-specops/soldier-idle.glb', minKB: 1800 },
  { file: 'models/soldier-specops/soldier-rifle-pose.glb', minKB: 1800 },
  { file: 'models/soldier-specops/soldier-talk.glb', minKB: 1800 },
  { file: 'models/soldier-specops/soldier-walk.glb', minKB: 1800 },
  { file: 'models/soldier-specops/soldier-run.glb', minKB: 1800 },
  { file: 'models/soldier-specops/soldier-jump.glb', minKB: 1800 },
  { file: 'models/soldier-specops/soldier-crouch-walk.glb', minKB: 1800 },
  { file: 'models/soldier-specops/soldier-death.glb', minKB: 1800 }
];

/**
 * Marcas de contenido: lo que se perdió la última vez no fueron los archivos
 * sino las etiquetas dentro del HTML, así que se comprueban explícitamente.
 */
const REQUIRED_MARKERS = [
  { file: 'dashboard.html', url: '/dashboard', needle: 'welcome-overlay.js', why: 'el dashboard debe cargar el script del overlay' },
  { file: 'dashboard.html', url: '/dashboard', needle: 'type="importmap"', why: 'sin importmap, GLTFLoader no resuelve "three"' },
  { file: 'commander-panel.html', url: '/commander-panel', needle: 'welcome-overlay.js', why: 'el panel usa el visor 3D del overlay' },
  { file: 'commander-panel.html', url: '/commander-panel', needle: 'type="importmap"', why: 'sin importmap, la vista previa del panel no carga' },
  { file: 'welcome-overlay.js', url: '/welcome-overlay.js', needle: 'SGCreatureViewer', why: 'el visor 3D reutilizable debe estar presente' }
];

/**
 * Rutas que jamás deben quedar públicas. El patrón "**\/.*" de firebase.json
 * solo excluye archivos cuyo nombre empieza con punto, no el contenido de
 * carpetas con punto: por eso .git/ estuvo servido y el repositorio completo
 * era descargable desde el sitio. Se comprueba en cada despliegue.
 */
const MUST_NOT_BE_PUBLIC = [
  '/.git/HEAD',
  '/.git/config',
  '/.git/index',
  '/.firebase/hosting..cache',
  '/serviceAccountKey.json',
  '/steam-config.php',
  '/.env'
];

const failures = [];
const warnings = [];

function ok(msg) { console.log('  OK   ' + msg); }
function bad(msg) { console.log('  FALLA ' + msg); failures.push(msg); }
/**
 * Un corte de red al comprobar no es lo mismo que un archivo ausente: se avisa
 * pero no se marca el despliegue como fallido, para no dar falsas alarmas.
 */
function warn(msg) { console.log('  AVISO ' + msg); warnings.push(msg); }

function checkLocal() {
  console.log('Verificando archivos del sitio en ' + ROOT);
  for (const { file, minKB } of REQUIRED_FILES) {
    const full = path.join(ROOT, file);
    let stat = null;
    try { stat = fs.statSync(full); } catch (e) { /* no existe */ }
    if (!stat) { bad(file + ' no existe'); continue; }
    const kb = Math.round(stat.size / 1024);
    if (kb < minKB) bad(file + ' pesa ' + kb + ' KB, se esperaban al menos ' + minKB + ' KB');
    else ok(file + ' (' + kb + ' KB)');
  }
  for (const { file, needle, why } of REQUIRED_MARKERS) {
    const full = path.join(ROOT, file);
    let text = null;
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) { /* ya reportado arriba */ }
    if (text === null) { bad(file + ' no se pudo leer para buscar "' + needle + '"'); continue; }
    if (text.includes(needle)) ok(file + ' contiene "' + needle + '"');
    else bad(file + ' ya no contiene "' + needle + '" — ' + why);
  }
}

async function fetchWithRetry(url, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 200) return res;
      // httpStatus distingue "el servidor contestó que no está" (falla real)
      // de "no hubo respuesta" (problema de red de quien despliega).
      lastErr = Object.assign(new Error('HTTP ' + res.status), { httpStatus: res.status });
    } catch (e) {
      lastErr = Object.assign(e, { httpStatus: null });
    }
    // El CDN puede tardar un instante en servir la versión recién publicada.
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastErr || Object.assign(new Error('sin respuesta'), { httpStatus: null });
}

function reportFetchProblem(what, err) {
  if (err && err.httpStatus) bad(what + ' responde HTTP ' + err.httpStatus + ' — no se está sirviendo');
  else warn(what + ': no se pudo comprobar (' + ((err && err.message) || err) + '), revisa tu conexión');
}

async function checkLive() {
  console.log('Verificando lo que se está sirviendo en ' + LIVE_ORIGIN);
  for (const { file, minKB } of REQUIRED_FILES) {
    const url = LIVE_ORIGIN + '/' + file;
    try {
      const res = await fetchWithRetry(url);
      const kb = Math.round((await res.arrayBuffer()).byteLength / 1024);
      if (kb < minKB) bad(file + ' se sirve con ' + kb + ' KB, se esperaban al menos ' + minKB + ' KB');
      else ok(file + ' (' + kb + ' KB)');
    } catch (e) {
      reportFetchProblem(file, e);
    }
  }
  const seen = new Set();
  for (const { url } of REQUIRED_MARKERS) seen.add(url);
  const bodies = {};
  for (const url of seen) {
    try {
      const res = await fetchWithRetry(LIVE_ORIGIN + url);
      bodies[url] = await res.text();
    } catch (e) {
      reportFetchProblem(url, e);
    }
  }
  for (const { url, needle, why } of REQUIRED_MARKERS) {
    const body = bodies[url];
    if (body === undefined) continue;
    if (body.includes(needle)) ok(url + ' contiene "' + needle + '"');
    else bad(url + ' publicado sin "' + needle + '" — ' + why);
  }
  for (const url of MUST_NOT_BE_PUBLIC) {
    try {
      const res = await fetch(LIVE_ORIGIN + url + '?cb=' + Date.now(), { cache: 'no-store' });
      if (res.status === 200) bad('EXPUESTO: ' + url + ' se está sirviendo públicamente y no debería');
      else ok(url + ' no es público (HTTP ' + res.status + ')');
    } catch (e) {
      ok(url + ' no es público (sin respuesta)');
    }
  }
}

(async () => {
  if (MODE !== 'local' && MODE !== 'live') {
    console.error('Modo desconocido: ' + MODE + ' (usa "local" o "live")');
    process.exit(2);
  }
  if (MODE === 'local') checkLocal(); else await checkLive();

  if (failures.length === 0) {
    console.log('Verificación (' + MODE + ') correcta: el sitio está completo.');
    if (warnings.length) console.log('(' + warnings.length + ' comprobación(es) no se pudieron completar por red)');
    return;
  }
  console.error('');
  console.error('Verificación (' + MODE + ') FALLIDA con ' + failures.length + ' problema(s):');
  for (const f of failures) console.error('  - ' + f);
  console.error('');
  if (MODE === 'local') {
    console.error('Este despliegue se abortó a propósito: esta copia del proyecto está');
    console.error('incompleta y publicarla dejaría el sitio sin el overlay 3D o sin sus');
    console.error('modelos. Trae la versión buena antes de reintentar:');
    console.error('    git pull origin main');
  } else {
    console.error('El sitio se publicó pero no está sirviendo todo. Vuelve a desplegar:');
    console.error('    firebase deploy --only hosting');
  }
  process.exit(1);
})().catch((e) => {
  console.error('Error inesperado en la verificación: ' + (e && e.stack || e));
  process.exit(1);
});
