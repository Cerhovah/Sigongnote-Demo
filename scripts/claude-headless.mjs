#!/usr/bin/env node
// Login-account runner. Usage and permission boundaries: docs/ENVIRONMENT.md.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectContent } from "./check-staged.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const hash=v=>createHash("sha256").update(v).digest("hex");
export function allocateRun(cwd,mode,sessionId){
 const name=[new Date().toISOString().replace(/[:.]/g,"-"),mode,sessionId,randomUUID().slice(0,8)].join("-");
 const relative=path.join(".work","claude-runs",name);
 fs.mkdirSync(path.dirname(path.join(cwd,relative)),{recursive:true});fs.mkdirSync(path.join(cwd,relative));return relative;
}
export function summarizeEvents(events,requestedModel,exitCode){
 const result=events.findLast(e=>e.type==="result");
 const models=[...new Set([...events.filter(e=>e.type==="system"&&e.subtype==="init").map(e=>e.model),...events.filter(e=>e.type==="assistant").map(e=>e.message?.model),...Object.entries(result?.modelUsage??{}).map(([key,v])=>v.canonicalModel??key)].filter(Boolean))];
 const tools={};for(const e of events)for(const block of e.message?.content??[])if(block.type==="tool_use")tools[block.name]=(tools[block.name]??0)+1;
 const permissionDenials=(result?.permission_denials??[]).map(d=>({tool:d.tool_name??d.toolName??"unknown",id:d.tool_use_id??null}));
 const actualModels=[...new Set([...events.filter(e=>e.type==="assistant").map(e=>e.message?.model),...Object.entries(result?.modelUsage??{}).map(([key,v])=>v.canonicalModel??key)].filter(Boolean))];
 const modelVerified=actualModels.length>0&&actualModels.every(model=>model===requestedModel);
 return {status:exitCode===0&&result&&!result.is_error&&modelVerified?"RESPONSE_RECEIVED":"BLOCKED",models,modelVerified,tools,permissionDenials};
}
export function reserveReview(cwd,base,sessionId){
 const directory=path.join(cwd,".work","claude-runs","reviews");fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,base+".json");
 try{fs.writeFileSync(file,JSON.stringify({sessionId,base,pid:process.pid}),{flag:"wx"});}
 catch(error){if(error.code!=="EEXIST")throw error;const previous=JSON.parse(fs.readFileSync(file,"utf8"));throw new Error("A review session already exists for this base: "+previous.sessionId+"; inspect its receipt and resume that session if needed");}
}
export function findBinary(){
 if(process.env.SIGONGNOTE_CLAUDE_BIN)return process.env.SIGONGNOTE_CLAUDE_BIN;
 const desktop=path.join(process.env.APPDATA??"","Claude","claude-code");
 if(fs.existsSync(desktop)){
  const versions=fs.readdirSync(desktop).filter(v=>/^\d+\.\d+\.\d+$/.test(v)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  for(const version of versions){
   const dir=path.join(desktop,version),candidates=[path.join(dir,"claude.exe"),...fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(dir,e.name,"claude.exe"))];
   const found=candidates.find(p=>fs.existsSync(p));if(found)return found;
  }
 }
 const cache=path.join(process.env.LOCALAPPDATA??"","npm-cache","_npx");
 if(fs.existsSync(cache)){
  const candidates=fs.readdirSync(cache).map(e=>path.join(cache,e,"node_modules","@anthropic-ai","claude-code","bin","claude.exe")).filter(p=>fs.existsSync(p)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  if(candidates[0])return candidates[0];
 }
 return "claude";
}
export function parseOptions(argv){
 const result={allow:[]},flags=new Set(["dry-run","probe","no-mcp"]),values=new Set(["mode","request","resume","follow","model","effort","name","max-turns","allow","worktree"]);
 for(let i=0;i<argv.length;i++){
  const key=argv[i].replace(/^--/,"");
  if(argv[i]!=="--"+key||(!flags.has(key)&&!values.has(key)))throw new Error("Unknown option: "+argv[i]);
  if(flags.has(key))result[key]=true;else{const value=argv[++i];if(!value||value.startsWith("--"))throw new Error("--"+key+" needs a value");if(key==="allow")result.allow.push(value);else result[key]=value;}
 }return result;
}
const shellRules=commands=>["Bash","PowerShell"].flatMap(tool=>commands.map(command=>tool+"("+command+")"));
const commands=["git status --short*","git diff *","git show *","git log *","git ls-files *","git rev-parse *","git merge-base *","npm run typecheck","npm.cmd run typecheck","node --test tests/agent-tools.test.mjs","node --import tsx --test *","node scripts/ui-shots.mjs *","node scripts/check-staged.mjs","node scripts/check-spec.mjs"];
const profiles={
 review:{agent:"flow-reviewer",tools:["Read","Grep","Glob","Bash","PowerShell"],allowed:[]},
 ui:{tools:["Read","Grep","Glob","Edit","Write","Bash","PowerShell","ToolSearch"],allowed:["ToolSearch","Edit(./apps/web/src/**)","Write(./apps/web/src/**)","Edit(./tests/**)","Write(./tests/**)"]}
};
async function main(){
 const opt=parseOptions(process.argv.slice(2)),cwd=opt.worktree?fs.realpathSync(path.resolve(root,opt.worktree)):root,bin=findBinary(),env={...process.env};
 for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL","CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_VERTEX","CLAUDE_CODE_USE_FOUNDRY"])delete env[key];
 const cli=args=>execFileSync(bin,args,{cwd,env,encoding:"utf8",windowsHide:true,timeout:60000});
 if(opt.probe){
  const auth=JSON.parse(cli(["auth","status","--json"]));
  const mcp=cli(["mcp","list"]).split(/\r?\n/).filter(l=>/Connected|authentication|Failed|Pending/.test(l)).map(l=>l.replace(/https?:\/\/\S+/g,"[endpoint]"));
  console.log(JSON.stringify({cliVersion:cli(["--version"]).trim(),loggedIn:auth.loggedIn,authMethod:auth.authMethod,subscriptionType:auth.subscriptionType,apiProvider:auth.apiProvider,mcp,modelCalled:false},null,2));
  if(!auth.loggedIn||auth.authMethod!=="claude.ai"||auth.apiProvider!=="firstParty")process.exitCode=1;return;
 }
 const resume=opt.resume;if(resume&&!/^[0-9a-f-]{36}$/i.test(resume))throw new Error("Invalid session ID");
 const manifestPath=id=>path.join(cwd,".work","claude-runs","sessions",id+".json");
 const previous=resume?JSON.parse(fs.readFileSync(manifestPath(resume),"utf8")):null;
 const mode=opt.mode??previous?.mode??"review",profile=profiles[mode];if(!profile)throw new Error("Use --mode review or ui");
 const model=opt.model??previous?.model??"claude-fable-5-1",effort=opt.effort??previous?.effort??"high";
 if(previous&&(previous.mode!==mode||previous.model!==model||previous.effort!==effort))throw new Error("Resume must preserve role/model/effort");
 const prompt=resume?opt.follow:opt.request&&fs.readFileSync(path.resolve(cwd,opt.request),"utf8");
 if(!prompt)throw new Error("Provide --request <file>, or --resume <id> --follow <instruction>");
 if(inspectContent("prompt.md",Buffer.from(prompt)).length)throw new Error("Privacy check rejected prompt");
 const sessionId=resume??randomUUID(),base=execFileSync("git",["rev-parse","HEAD"],{cwd,encoding:"utf8"}).trim();
 if(opt["dry-run"]){console.log(JSON.stringify({mode,sessionId,resume:!!resume,model,effort,cli:path.basename(bin),base,promptHash:hash(prompt),authChecked:false,modelCalled:false},null,2));return;}
 const version=cli(["--version"]).trim(),auth=JSON.parse(cli(["auth","status","--json"]));
 if(!auth.loggedIn||auth.authMethod!=="claude.ai"||auth.apiProvider!=="firstParty")throw new Error("Requires firstParty claude.ai login");
 if(mode==="review"&&!resume)reserveReview(cwd,base,sessionId);
 const runDir=allocateRun(cwd,mode,sessionId),full=path.join(cwd,runDir),sessions=path.dirname(manifestPath(sessionId));
 fs.mkdirSync(sessions,{recursive:true});if(!resume)fs.writeFileSync(manifestPath(sessionId),JSON.stringify({mode,model,effort}),{flag:"wx"});
 const lock=path.join(sessions,sessionId+".lock");fs.writeFileSync(lock,JSON.stringify({pid:process.pid,runDir}),{flag:"wx"});
 const write=(name,data)=>fs.writeFileSync(path.join(full,name),typeof data==="string"?data:JSON.stringify(data,null,2),{flag:"wx"});
 const args=["--print","--model",model,"--effort",effort,"--output-format","stream-json","--verbose",...(resume?["--resume",sessionId]:["--session-id",sessionId,"--name",opt.name??"시공노트 "+mode]),...(profile.agent?["--agent",profile.agent]:[]),"--tools",profile.tools.join(","),"--allowedTools","Read","Grep","Glob",...profile.allowed,...(mode==="ui"?["Edit(./"+runDir.replaceAll("\\","/")+"/**)","Write(./"+runDir.replaceAll("\\","/")+"/**)"]:[]),...shellRules(commands),...opt.allow,"--permission-mode","dontAsk",...(mode==="review"?["--disallowedTools","Edit","Write"]:[]),...(opt["no-mcp"]?["--strict-mcp-config","--mcp-config",'{"mcpServers":{}}']:[]),...(opt["max-turns"]?["--max-turns",opt["max-turns"]]:[])];
 let stream,stderr;
 try{
  write("invocation.json",{mode,sessionId,resume:!!resume,model,effort,cliVersion:version,args,promptHash:hash(prompt),base,authMethod:auth.authMethod,subscriptionType:auth.subscriptionType,apiProvider:auth.apiProvider});write("prompt.md",prompt);
  stream=fs.createWriteStream(path.join(full,"events.jsonl"),{flags:"wx"});stderr=fs.createWriteStream(path.join(full,"stderr.txt"),{flags:"wx"});
  const events=[];let buffer="";const line=s=>{try{events.push(JSON.parse(s));}catch{}};
  const child=spawn(bin,args,{cwd,env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
  child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>{stream.write(chunk);buffer+=chunk;let n;while((n=buffer.indexOf("\n"))>=0){line(buffer.slice(0,n));buffer=buffer.slice(n+1);}});child.stderr.pipe(stderr);child.stdin.on("error",()=>{});child.stdin.end(prompt);
  console.log(JSON.stringify({started:true,sessionId,mode,model,effort,runDir,cliVersion:version}));
  const code=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",resolve);});
  if(buffer.trim())line(buffer);
  const result=events.findLast(e=>e.type==="result");if(result){write("result.json",result);if(typeof result.result==="string")write("result.md",result.result);}
  const summary={...summarizeEvents(events,model,code),sessionId,exitCode:code,runDir,turns:result?.num_turns??events.filter(e=>e.type==="assistant").length,durationMs:result?.duration_ms??null,costUsdListPrice:result?.total_cost_usd??null,billedAmountVerified:false,authMethod:auth.authMethod,subscriptionType:auth.subscriptionType,apiProvider:auth.apiProvider};
  write("exit.json",summary);console.log(JSON.stringify(summary));if(summary.status!=="RESPONSE_RECEIVED")process.exitCode=1;
 }catch(error){write("failure.json",{sessionId,message:error.message,status:"UNKNOWN_NO_AUTO_RETRY"});throw error;}
 finally{stream?.end();stderr?.end();fs.unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
