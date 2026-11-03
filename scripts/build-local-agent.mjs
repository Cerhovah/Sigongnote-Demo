import { build } from 'esbuild';
import { resolve } from 'node:path';
const destination=process.argv[2];
if(!destination)throw new Error('Output file required');
await build({entryPoints:['services/local-agent/src/main.ts'],outfile:resolve(destination),bundle:true,platform:'node',target:'node24',format:'esm',
 banner:{js:'import { createRequire as __sigongnoteCreateRequire } from "node:module"; const require=__sigongnoteCreateRequire(import.meta.url);'},
 sourcemap:false,legalComments:'eof'});
