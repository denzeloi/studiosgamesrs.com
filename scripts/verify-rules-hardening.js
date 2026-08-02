#!/usr/bin/env node
'use strict';

/**
 * Las tres puertas que estaban abiertas y no tienen prueba en ningún otro sitio.
 *
 * Son reglas y rutas: no hay forma de ejecutarlas en local contra Firebase, así
 * que lo que se comprueba es que el texto de las reglas y el de los clientes
 * sigan diciendo lo mismo. Es poco, pero es justo lo que se rompe cuando alguien
 * "arregla" una subida cambiando la ruta y deja la regla vieja detrás.
 *
 *   1. Portada de torneo y emblema de equipo: cada quien escribe en su carpeta.
 *   2. La campana ajena ya no se abre con un texto mágico.
 *   3. Un aviso solo puede llevar a una ruta de la propia página.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = 0;

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function ok(msg) {
  console.log('OK  ', msg);
}

function check(label, condition) {
  if (condition) ok(label);
  else {
    console.error('FAIL', label);
    failed += 1;
  }
}

console.log('\n--- Storage: nadie escribe encima de nadie ---');
const storage = read('storage.rules');

function blockFor(pattern) {
  const at = storage.indexOf(pattern);
  if (at === -1) return '';
  const body = at + pattern.length;
  return storage.slice(body, storage.indexOf('\n    }', body));
}

const bannerOwn = blockFor('match /tournament_banners/{tournamentId}/{userId}/{fileName}');
const bannerLegacy = blockFor('match /tournament_banners/{tournamentId}/{fileName}');
const emblemOwn = blockFor('match /team_emblems/{teamId}/{userId}/{fileName}');
const emblemLegacy = blockFor('match /team_emblems/{teamId}/{fileName}');

check('la portada se sube dentro de la carpeta de quien sube',
  /request\.auth\.uid == userId/.test(bannerOwn));
check('la portada sigue siendo pública', /allow read: if true/.test(bannerOwn));
check('las portadas antiguas ya no se pueden reemplazar',
  /allow write: if false/.test(bannerLegacy));
check('el emblema se sube dentro de la carpeta de quien sube',
  /request\.auth\.uid == userId/.test(emblemOwn));
check('los emblemas antiguos ya no se pueden reemplazar',
  /allow write: if false/.test(emblemLegacy));

const details = read('tournament-details.js');
check('la sala sube la portada a su carpeta',
  /tournament_banners\/' \+ tournamentId \+ '\/' \+ uploaderUid/.test(details));
const hub = read('competition-hub-logic.js');
check('el emblema se sube a la carpeta del capitán',
  /team_emblems\/\$\{teamId\}\/\$\{uploaderUid\(\)\}\//.test(hub));
check('y el fondo del equipo también',
  (hub.match(/team_emblems\/\$\{teamId\}\/\$\{uploaderUid\(\)\}\//g) || []).length >= 2);

console.log('\n--- la campana ajena ---');
const rules = JSON.parse(read('database.rules.json'));
const notifications = rules.rules.users.$uid.notifications.$notificationId;

check('ya no hay texto mágico que abra la campana de cualquiera',
  notifications['.write'].indexOf('visited your profile') === -1);
check('solo escriben el dueño y el mando',
  /auth\.uid == \$uid/.test(notifications['.write']) &&
  /rango/.test(notifications['.write']));
check('el aviso de visita ya no se escribe desde el cliente',
  read('dashboard-logic.js').indexOf('visited your profile') === -1);
// La visita se sigue viendo: la sección Visitas se arma leyendo profileVisitors.
check('pero la visita se sigue viendo en la campana',
  /profileVisitors/.test(read('shared-notifications.js')));

console.log('\n--- el enlace de un aviso ---');
const link = notifications.link['.validate'];
check('el enlace tiene que ser una ruta de la página', /beginsWith\('\/'\)/.test(link));
check('y no un sitio de fuera con doble barra', /!newData\.val\(\)\.beginsWith\('\/\/'\)/.test(link));
check('ni con barra invertida', /beginsWith\('\/\\\\'\)/.test(link));
check('un aviso sin enlace sigue valiendo', /!newData\.exists\(\)/.test(link));

const sharedNotifs = read('shared-notifications.js');
check('el panel valida el enlace antes de pintarlo', /function safeLink/.test(sharedNotifs));
check('y antes de navegar', /safeLink\(el\.getAttribute\('data-notif-link'\)\)/.test(sharedNotifs));
check('el aviso emergente también', /var dest = safeLink\(n\.link\)/.test(sharedNotifs));
const header = read('shared-header.js');
check('la campana antigua valida igual', /function safeNotifLink/.test(header));
check('y no navega sin validar', /safeNotifLink\(n\.link\)/.test(header));
check('ya no queda ningún salto directo sin validar',
  !/if \(n\.link\) window\.location\.href = n\.link/.test(header + sharedNotifs));

if (failed) {
  console.error('\n[verify-rules-hardening]', failed, 'comprobación(es) fallaron');
  process.exit(1);
}
console.log('\n[verify-rules-hardening] Todas las comprobaciones pasaron.');
