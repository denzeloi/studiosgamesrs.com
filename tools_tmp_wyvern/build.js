/**
 * Wyvern rojo: FBX (UDIM) -> un solo GLB con todos los clips.
 *
 * Dos problemas que resuelve este script:
 *
 * 1) UDIM. El dragon viene con las UV del cuerpo repartidas en tres tiles
 *    (u de 0 a 3, tiles 1001/1002/1003) y glTF no sabe nada de UDIM: solo
 *    puede muestrear una imagen por canal. Se componen los tres tiles en un
 *    atlas 2x2 (1024 px por tile) y se reescriben las UV a la celda que le
 *    toca a cada vertice.
 *
 * 2) Un GLB por animacion era carisimo: cada archivo repetia la malla y las
 *    texturas enteras. Aqui las animaciones se trasplantan todas al mismo
 *    documento emparejando los nodos por nombre (todos los FBX salen del
 *    mismo rig), asi que las texturas se pagan una sola vez.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { NodeIO } = require('@gltf-transform/core');

const RAW = 'raw';
const TEX_UE = path.resolve('..', 'models', 'WyvernDragon', 'RedWyvern_Textures', 'RedWyvern_Textures', 'UE Textures');
const TEX_BL = path.resolve('..', 'models', 'WyvernDragon', 'RedWyvern_Textures', 'RedWyvern_Textures', 'Blender Textures');

// Clips que se publican. El pack no exporto todos los FBX con el mismo rig:
// unos traen 146 nodos y otros 154 (les faltan los huesos de torsion de codos
// y rodillas). La malla se toma del rig completo para que ninguna animacion
// pierda canales al trasplantarse.
const BASE = 'alert';
const CLIPS = [
  'idle', 'roar', 'alert', 'landing', 'takeoff', 'flying',
  'gliding', 'bite', 'die', 'walking', 'sleep_out'
];

// Atlas: 1024 px por tile en una rejilla 2x2. El cuarto cuadrante queda vacio
// (solo hay tres tiles) y en WebP no cuesta casi nada.
const TILE = 1024;
const ATLAS = TILE * 2;
const CELL = [
  { col: 0, row: 0 }, // tile 1001
  { col: 1, row: 0 }, // tile 1002
  { col: 0, row: 1 }  // tile 1003
];

async function buildAtlas(dir, prefix, ext, outFile, background) {
  const layers = [];
  for (let t = 0; t < 3; t += 1) {
    const src = path.join(dir, `${prefix}.100${t + 1}.${ext}`);
    const buf = await sharp(src).resize(TILE, TILE, { fit: 'fill' }).png().toBuffer();
    layers.push({ input: buf, left: CELL[t].col * TILE, top: CELL[t].row * TILE });
  }
  await sharp({ create: { width: ATLAS, height: ATLAS, channels: 3, background: background } })
    .composite(layers).png({ compressionLevel: 6 }).toFile(outFile);
  return fs.readFileSync(outFile);
}

/** Reescribe las UV de una primitiva del tile UDIM a su celda del atlas. */
function remapUdim(prim, stats) {
  const uv = prim.getAttribute('TEXCOORD_0');
  if (!uv) return;
  const arr = uv.getArray();
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 2) {
    let t = Math.floor(arr[i] + 1e-5);
    if (t < 0) t = 0;
    if (t > 2) t = 2;
    stats[t] = (stats[t] || 0) + 1;
    out[i] = (arr[i] - t) * 0.5 + CELL[t].col * 0.5;
    out[i + 1] = arr[i + 1] * 0.5 + CELL[t].row * 0.5;
  }
  uv.setArray(out);
}

function cloneAccessor(doc, src, buffer) {
  const arr = src.getArray();
  return doc.createAccessor()
    .setType(src.getType())
    .setNormalized(src.getNormalized())
    .setArray(new arr.constructor(arr))
    .setBuffer(buffer);
}

/** Copia la animacion de otro documento emparejando los nodos por nombre. */
function transplant(doc, animDoc, name, nodeByName, buffer) {
  const src = animDoc.getRoot().listAnimations()[0];
  if (!src) throw new Error('sin animacion: ' + name);
  const anim = doc.createAnimation(name);
  const samplers = new Map();
  let ok = 0;
  let lost = [];
  for (const ch of src.listChannels()) {
    const target = ch.getTargetNode();
    const dst = target ? nodeByName.get(target.getName()) : null;
    if (!dst) { lost.push(target ? target.getName() : '?'); continue; }
    const s = ch.getSampler();
    let ns = samplers.get(s);
    if (!ns) {
      ns = doc.createAnimationSampler()
        .setInput(cloneAccessor(doc, s.getInput(), buffer))
        .setOutput(cloneAccessor(doc, s.getOutput(), buffer))
        .setInterpolation(s.getInterpolation());
      anim.addSampler(ns);
      samplers.set(s, ns);
    }
    anim.addChannel(doc.createAnimationChannel()
      .setTargetNode(dst).setTargetPath(ch.getTargetPath()).setSampler(ns));
    ok += 1;
  }
  return { name: name, channels: ok, lost: lost };
}

(async () => {
  fs.mkdirSync('atlas', { recursive: true });
  fs.mkdirSync('tmp', { recursive: true });

  console.log('-- atlas de texturas (UDIM 3 tiles -> 2x2 de ' + ATLAS + 'px)');
  const bcBuf = await buildAtlas(TEX_UE, 'DragonMaterial_BaseColor', 'png', 'atlas/basecolor.png', { r: 20, g: 12, b: 10 });
  const nmBuf = await buildAtlas(TEX_BL, 'DragonMaterial_Normal', 'png', 'atlas/normal.png', { r: 128, g: 128, b: 255 });
  const ormBuf = await buildAtlas(TEX_UE, 'DragonMaterial_OcclusionRoughnessMetallic', 'png', 'atlas/orm.png', { r: 255, g: 128, b: 0 });
  const eyesBuf = fs.readFileSync(path.join(TEX_UE, 'DragonEyes_BaseColor.1001.png'));
  console.log('   basecolor ' + (bcBuf.length / 1048576).toFixed(1) + ' MB, normal ' +
    (nmBuf.length / 1048576).toFixed(1) + ' MB, orm ' + (ormBuf.length / 1048576).toFixed(1) + ' MB');

  const io = new NodeIO();
  const doc = await io.read(path.join(RAW, `a_${BASE}.glb`));
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  console.log('-- base: ' + BASE + ' (' + root.listNodes().length + ' nodos, skin de ' +
    root.listSkins().map((s) => s.listJoints().length).join('/') + ' huesos)');

  // Las texturas que dejo FBX2glTF son marcadores de 70 bytes: fuera.
  for (const tex of root.listTextures()) tex.dispose();

  const nodeByName = new Map();
  for (const n of root.listNodes()) nodeByName.set(n.getName(), n);

  console.log('-- texturas y materiales');
  const texBC = doc.createTexture('dragon_basecolor').setMimeType('image/png').setImage(bcBuf);
  const texNM = doc.createTexture('dragon_normal').setMimeType('image/png').setImage(nmBuf);
  const texORM = doc.createTexture('dragon_orm').setMimeType('image/png').setImage(ormBuf);
  const texEyes = doc.createTexture('dragon_eyes').setMimeType('image/png').setImage(eyesBuf);

  for (const mat of root.listMaterials()) {
    const name = mat.getName();
    if (/eyes/i.test(name)) {
      mat.setBaseColorTexture(texEyes)
        .setBaseColorFactor([1, 1, 1, 1])
        .setMetallicFactor(0.1)
        .setRoughnessFactor(0.18)
        // Un punto de brasa en la pupila: el dragon casi siempre sale a
        // contraluz en el overlay y sin esto los ojos se pierden en negro.
        .setEmissiveFactor([0.55, 0.16, 0.03]);
      mat.setEmissiveTexture(texEyes);
      console.log('   ' + name + ' -> ojos');
    } else {
      mat.setBaseColorTexture(texBC)
        .setBaseColorFactor([1, 1, 1, 1])
        .setNormalTexture(texNM)
        .setMetallicRoughnessTexture(texORM)
        .setOcclusionTexture(texORM)
        .setMetallicFactor(1)
        .setRoughnessFactor(1);
      console.log('   ' + name + ' -> atlas UDIM');
    }
  }

  console.log('-- remapeo de UV');
  const stats = {};
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat && /eyes/i.test(mat.getName())) continue; // los ojos ya son un solo tile
      remapUdim(prim, stats);
    }
  }
  console.log('   vertices por tile: ' + JSON.stringify(stats));

  console.log('-- animaciones');
  // La animacion que venia en el FBX base se descarta: se vuelve a traer con
  // el mismo camino que las demas para que todas pasen por el mismo filtro.
  for (const a of root.listAnimations()) a.dispose();
  for (const clip of CLIPS) {
    const animDoc = await io.read(path.join(RAW, `a_${clip}.glb`));
    const rep = transplant(doc, animDoc, clip, nodeByName, buffer);
    console.log('   ' + rep.name + ': ' + rep.channels + ' canales' +
      (rep.lost.length ? ' PERDIDOS ' + rep.lost.length + ' -> ' + rep.lost.slice(0, 5).join(',') : ''));
  }

  await io.write('tmp/wyvern-dragon.glb', doc);
  const size = fs.statSync('tmp/wyvern-dragon.glb').size;
  console.log('-- escrito tmp/wyvern-dragon.glb: ' + (size / 1048576).toFixed(1) + ' MB');
})().catch((e) => { console.error(e); process.exit(1); });
