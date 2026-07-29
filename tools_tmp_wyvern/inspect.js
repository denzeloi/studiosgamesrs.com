const { NodeIO } = require('@gltf-transform/core');

(async () => {
  const io = new NodeIO();
  const doc = await io.read(process.argv[2] || 'raw/a_roar.glb');
  const root = doc.getRoot();

  console.log('== animaciones ==');
  for (const a of root.listAnimations()) {
    let max = 0;
    for (const s of a.listSamplers()) {
      const inp = s.getInput();
      if (!inp) continue;
      const arr = inp.getArray();
      if (arr && arr.length) max = Math.max(max, arr[arr.length - 1]);
    }
    console.log(`  "${a.getName()}" canales=${a.listChannels().length} dur=${max.toFixed(2)}s`);
  }

  console.log('== materiales ==');
  for (const m of root.listMaterials()) {
    console.log(`  "${m.getName()}" base=${JSON.stringify(m.getBaseColorFactor())} rough=${m.getRoughnessFactor()} metal=${m.getMetallicFactor()}`);
  }

  console.log('== mallas / primitivas / UV ==');
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const uv = prim.getAttribute('TEXCOORD_0');
      const mat = prim.getMaterial();
      let uvInfo = 'sin UV';
      if (uv) {
        const a = uv.getArray();
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (let i = 0; i < a.length; i += 2) {
          if (a[i] < uMin) uMin = a[i];
          if (a[i] > uMax) uMax = a[i];
          if (a[i + 1] < vMin) vMin = a[i + 1];
          if (a[i + 1] > vMax) vMax = a[i + 1];
        }
        uvInfo = `u[${uMin.toFixed(3)}..${uMax.toFixed(3)}] v[${vMin.toFixed(3)}..${vMax.toFixed(3)}]`;
      }
      console.log(`  malla "${mesh.getName()}" verts=${pos.getCount()} mat="${mat ? mat.getName() : '-'}" ${uvInfo}`);
    }
  }

  console.log('== texturas embebidas ==');
  for (const t of root.listTextures()) {
    const img = t.getImage();
    console.log(`  "${t.getName()}" ${t.getMimeType()} ${img ? img.byteLength : 0}B`);
  }

  console.log('== escenas / nodos raiz ==');
  for (const s of root.listScenes()) {
    console.log(`  escena "${s.getName()}": ${s.listChildren().map((c) => c.getName()).join(', ')}`);
  }
  console.log('  nodos totales:', root.listNodes().length);
  console.log('  skins:', root.listSkins().length, root.listSkins().map((s) => s.listJoints().length));
})();
