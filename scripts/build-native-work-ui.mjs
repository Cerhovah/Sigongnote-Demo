import { createHash } from "node:crypto";
import { readFileSync,existsSync,readdirSync,writeFileSync } from "node:fs";
import { resolve,relative,join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const output=join(root,".work/native-assets/work");
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(f=>f.isDirectory()?files(join(dir,f.name)):[join(dir,f.name)]);}
const shared=['contracts','domain'];
const sources=[...files(join(root,"apps/web/src")),...shared.flatMap(p=>[...files(join(root,'packages',p,'src')),join(root,'packages',p,'package.json'),join(root,'packages',p,'tsconfig.build.json')]),join(root,"scripts/build-native-work-ui.mjs"),join(root,"apps/web/index.html"),join(root,"package-lock.json"),join(root,"tsconfig.json"),...readdirSync(join(root,"apps/web")).filter(n=>/^(vite\.config\.|tsconfig|package\.json)/.test(n)).map(n=>join(root,"apps/web",n)),...(existsSync(join(root,"apps/web/public"))?files(join(root,"apps/web/public")):[])].sort();
const digest=createHash("sha256");for(const file of sources)digest.update(relative(root,file)).update(readFileSync(file));const revision=digest.digest("hex");
const manifest=join(output,"build.json");
if(existsSync(manifest)&&existsSync(join(output,"index.html"))&&JSON.parse(readFileSync(manifest,"utf8")).sourceHash===revision){console.log("Shared work UI current");process.exit(0);}
for(const name of shared){
 const built=spawnSync(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"-p",join(root,'packages',name,'tsconfig.build.json')],{cwd:root,encoding:"utf8"});
 if(built.status!==0){console.error('Shared '+name+' build failed');process.exit(1);}
}
const built=spawnSync(process.execPath,[join(root,"node_modules/vite/bin/vite.js"),"build",join(root,"apps/web"),"--base","./","--outDir",output,"--emptyOutDir"],{cwd:root,encoding:"utf8"});
if(built.status!==0){console.error(built.stderr);process.exit(1);}
const index=join(output,"index.html");
writeFileSync(index,readFileSync(index,"utf8").replace("<head>",`<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://*.supabase.co/storage/v1/object/upload/sign/; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'">`));
writeFileSync(manifest,JSON.stringify({sourceHash:revision,bridgeVersion:1})+"\n");console.log("Shared work UI built");
