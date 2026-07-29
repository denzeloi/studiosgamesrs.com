#!/usr/bin/env node
/**
 * Comprueba que la curva de 100 niveles no degrada a nadie respecto al sistema
 * de 5 niveles que había antes: ni el nivel ni el multiplicador de EXP pueden
 * bajar para una misma cantidad de XP. Se ejecuta a mano tras tocar sg-levels.js.
 */
'use strict';

const path = require('path');
const SGLevels = require(path.resolve(__dirname, '..', 'sg-levels.js'));

const OLD_THRESHOLDS = [0, 500, 1500, 3000, 6000];

function oldRankIndex(xp) {
  let rank = 0;
  for (let i = OLD_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= OLD_THRESHOLDS[i]) { rank = i; break; }
  }
  return rank;
}

let levelDrops = 0;
let multiplierDrops = 0;
let firstFailure = null;

for (let xp = 0; xp <= 8000; xp++) {
  const newLevel = SGLevels.levelFromXp(xp);
  const oldLevel = oldRankIndex(xp) + 1;
  const newMultiplier = SGLevels.xpMultiplier(newLevel, xp);
  const oldMultiplier = 1 + oldRankIndex(xp) * 0.05;

  if (newLevel < oldLevel) {
    levelDrops++;
    if (firstFailure === null) firstFailure = xp;
  }
  if (newMultiplier < oldMultiplier - 1e-9) {
    multiplierDrops++;
    if (firstFailure === null) firstFailure = xp;
  }
}

console.log('XP comprobadas: 0 a 8.000 (todo el rango del sistema viejo)');
console.log('  bajadas de nivel:         ' + levelDrops);
console.log('  bajadas de multiplicador: ' + multiplierDrops);
console.log('  primer fallo:             ' + (firstFailure === null ? 'ninguno' : firstFailure));

console.log('');
console.log('Muestras:');
[0, 499, 500, 1499, 6000, 8500, 44500, 254500, 9999999].forEach((xp) => {
  const level = SGLevels.levelFromXp(xp);
  const tier = SGLevels.tierForLevel(level);
  console.log(
    '  xp ' + String(xp).padStart(8) +
    ' -> nivel ' + String(level).padStart(3) +
    ' | ' + tier.name.padEnd(11) +
    ' | mult x' + SGLevels.xpMultiplier(level, xp).toFixed(2)
  );
});

if (levelDrops || multiplierDrops) {
  console.error('');
  console.error('FALLA: la curva nueva degrada a jugadores existentes.');
  process.exit(1);
}
console.log('');
console.log('Correcto: nadie baja de nivel ni pierde multiplicador.');
