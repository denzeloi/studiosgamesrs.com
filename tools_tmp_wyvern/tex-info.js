const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const roots = [
  path.resolve('..', 'models', 'WyvernDragon', 'RedWyvern_Textures', 'RedWyvern_Textures', 'UE Textures'),
  path.resolve('..', 'models', 'WyvernDragon', 'RedWyvern_Textures', 'RedWyvern_Textures', 'Blender Textures'),
  path.resolve('..', 'models', 'WyvernDragon', 'DragonSkin23_Textures')
];

(async () => {
  for (const dir of roots) {
    console.log('== ' + dir);
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(png|jpg|tga)$/i.test(f)) { console.log('   (omitido) ' + f); continue; }
      try {
        const m = await sharp(path.join(dir, f)).metadata();
        console.log(`   ${f} ${m.width}x${m.height} ch=${m.channels} ${m.format}`);
      } catch (e) {
        console.log(`   ${f} ERROR ${e.message}`);
      }
    }
  }
})();
