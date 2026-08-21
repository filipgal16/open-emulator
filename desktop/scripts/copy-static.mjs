import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const staticFiles = [['src/renderer/index.html', 'dist/renderer/index.html']];

for (const [from, to] of staticFiles) {
  const src = join(root, from);
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
