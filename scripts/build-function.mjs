import { build } from 'esbuild';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.env.MDW_FUNCTION_OUTPUT||resolve(root,'dist/mdwPrivateApi'));
if(out!==resolve(root,'dist/mdwPrivateApi'))throw new Error('Refusing to clean an unexpected generated directory');
await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(root,'backend/index.js')],outfile:resolve(out,'index.js'),bundle:true,platform:'node',target:'node20',format:'cjs',sourcemap:false,minify:false,legalComments:'eof'});
await writeFile(resolve(out,'package.json'),JSON.stringify({name:'mdw-private-api-bundle',private:true,version:'0.2.0',main:'index.js',type:'commonjs'},null,2)+'\n');
await copyFile(resolve(root,'node_modules/@cloudbase/js-sdk/LICENSE'),resolve(out,'CLOUDBASE-LICENSE.txt'));
// The official Node SDK dynamically requires its TC3 signature implementation.
// Build only dynamic runtime modules as real packages. Copying pnpm symlinks can
// embed local absolute paths; copying the whole SDK also exceeds ZIP limits.
await rm(resolve(out,'node_modules'),{recursive:true,force:true});
const requireBackend=createRequire(resolve(root,'backend/package.json'));
for(const name of ['@cloudbase/signature-nodejs','ws']){
  const target=resolve(out,'node_modules',name);await mkdir(target,{recursive:true});
  await build({entryPoints:[requireBackend.resolve(name)],outfile:resolve(target,'index.js'),bundle:true,platform:'node',target:'node20',format:'cjs',minify:true,legalComments:'eof',external:['bufferutil','utf-8-validate']});
  await writeFile(resolve(target,'package.json'),JSON.stringify({name,main:'index.js',type:'commonjs'}));
}
console.log('Built standalone Event function; no credentials included.');
