import { build } from 'esbuild';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, 'src/renderer/main.tsx')],
  outfile: join(root, 'dist/renderer/bundle.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  logLevel: 'info',
});
