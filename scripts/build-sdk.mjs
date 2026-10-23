import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const sdkPath = require.resolve('@cloudbase/js-sdk');
const sdkRoot = resolve(dirname(sdkPath), '..');
await mkdir(resolve(root, 'private/vendor'), {recursive:true});
await build({
  stdin:{contents:'export { default } from "@cloudbase/js-sdk";', resolveDir:root, sourcefile:'cloudbase-browser-entry.js'},
  outfile:resolve(root, 'private/vendor/cloudbase.js'),
  bundle:true, format:'esm', platform:'browser', target:['safari16','chrome110'],
  minify:true, sourcemap:false, legalComments:'eof'
});
// Preserve license text while normalizing trailing whitespace in generated files.
await writeFile(resolve(root, 'private/vendor/CLOUDBASE-LICENSE.txt'),(await readFile(resolve(sdkRoot,'LICENSE'),'utf8')).replace(/[\t ]+$/gm,''));
const bundle=resolve(root,'private/vendor/cloudbase.js');
await writeFile(bundle,(await readFile(bundle,'utf8')).replace(/[\t ]+$/gm,''));
await writeFile(resolve(root, 'private/vendor/README.md'), '# Generated official SDK bundle\n\nCloudBase JS SDK 3.10.3, bundled with esbuild 0.28.2. Run `pnpm install --frozen-lockfile && pnpm build:sdk` to reproduce. No CDN runtime dependency. Do not hand-edit generated output.\n');
