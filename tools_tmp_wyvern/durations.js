// Duracion real de cada clip ya publicado: hace falta para saber cuales sirven
// como animacion de entrada y cuales se cortan demasiado rapido.
const fs = require('fs');
const path = require('path');

function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
}

function durations(file) {
  const gltf = readGlbJson(file);
  const out = [];
  for (const anim of gltf.animations || []) {
    let max = 0;
    for (const s of anim.samplers || []) {
      const acc = gltf.accessors[s.input];
      if (acc && acc.max && acc.max.length) max = Math.max(max, acc.max[0]);
    }
    out.push({ name: anim.name, dur: max });
  }
  return out;
}

for (const dir of ['../models/soldier-specops', '../models/golem-tortoise', '../models/wyvern-dragon']) {
  console.log('== ' + path.basename(dir));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.glb'))) {
    const kb = (fs.statSync(path.join(dir, f)).size / 1048576).toFixed(2);
    const d = durations(path.join(dir, f));
    console.log('  ' + f.padEnd(28) + kb + ' MB  ' +
      d.map((x) => `"${x.name}" ${x.dur.toFixed(2)}s`).join(' | '));
  }
}
