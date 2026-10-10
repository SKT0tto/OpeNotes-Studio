import fs from 'node:fs/promises';
import path from 'node:path';

const PNG = path.resolve('tests/fixtures/fake-assets/backgrounds/1.png');

/**
 * A hand-made package shaped like a site download: absolute `/runtime/...` texture paths, every motion in one
 * "Motion" group, textures stored away from the model directory. All content is synthetic.
 */
export async function writeSitePackage(root: string, id = '001_casual_spring_01', motionCount = 4): Promise<void> {
  const dir = path.join(root, 'live2d', id);
  await fs.mkdir(path.join(dir, 'motions'), { recursive: true });
  await fs.mkdir(path.join(dir, 'expressions'), { recursive: true });
  await fs.mkdir(path.join(root, 'unity', 'tex'), { recursive: true });
  const png = await fs.readFile(PNG);
  await fs.writeFile(path.join(root, 'unity', 'tex', `${id}_texture_00--Texture2D-1.png`), png);
  await fs.writeFile(path.join(root, 'unity', 'tex', `${id}_texture_01--Texture2D-2.png`), png);
  await fs.writeFile(path.join(dir, 'model.moc3'), Buffer.concat([Buffer.from('MOC3'), Buffer.from([5]), Buffer.alloc(40)]));
  await fs.writeFile(path.join(dir, 'physics3.json'), '{"Version":3}');
  const motions = Array.from({ length: motionCount }, (_, i) => `mtn_fake${i}`);
  for (const m of motions) await fs.writeFile(path.join(dir, 'motions', `${m}.motion3.json`), '{"Version":3,"Meta":{"Duration":1}}');
  await fs.writeFile(path.join(dir, 'expressions', 'exp_smile01.exp3.json'), '{"Type":"Live2D Expression"}');
  await fs.writeFile(
    path.join(dir, 'model3.json'),
    JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'model.moc3',
        Textures: [`/runtime/intl/unity/Assets/x/${id}_texture_00--Texture2D-1.png`, `/runtime/intl/unity/Assets/x/${id}_texture_01--Texture2D-2.png`],
        Physics: 'physics3.json',
        Expressions: [{ Name: 'exp_smile01', File: 'expressions/exp_smile01.exp3.json' }],
        Motions: { Motion: motions.map((m) => ({ File: `motions/${m}.motion3.json`, FadeInTime: 0.5 })) },
      },
    }),
  );
}

export async function writePng(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(PNG, file);
}
