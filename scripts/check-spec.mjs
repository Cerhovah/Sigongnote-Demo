// Explicit active-document allowlist. Archived prose is never read by this gate.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { checkExecutionState } from './execution-state.mjs';
export const ACTIVE_DOCS=['docs/AGENT_SPEC.md','docs/ENVIRONMENT.md','docs/EXECUTION_STATE.md'];
const ENTRY_DOCS=['README.md','AGENTS.md','CLAUDE.md','HANDOFF.md','.claude/agents/flow-reviewer.md'];
export function validateActiveLinks(body,file,root=process.cwd()) {
 const errors=[];
 if (/\b(?:PLAN|ARCHITECTURE|OPERATIONS|V0_1|ACCEPTANCE)\.md/.test(body)) errors.push(`${file}: retired document reference`);
 if (/0\.2(?: |%20)ver[\\/][\p{L}\p{N}_.%]/iu.test(body))errors.push(`${file}: forbidden archive path`);
 for(const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
  const target=match[1].replace(/^<|>$/g,'').split('#')[0];
  if(!target||/^(https?:|mailto:|codex:)/i.test(target))continue;
  let decoded;try {decoded=decodeURIComponent(target);}catch {errors.push(`${file}: invalid encoded link`);continue;}
  const absolute=path.resolve(root,path.dirname(file),decoded);
  const relative=path.relative(root,absolute).replaceAll('\\','/');
  if(relative.toLowerCase()==='0.2 ver'||relative.toLowerCase().startsWith('0.2 ver/')) errors.push(`${file}: forbidden archive link`);
  else if(!fs.existsSync(absolute))errors.push(`${file}: missing link ${target}`);
 }
 return errors;
}
function listDocs(dir) {
 return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const p=path.posix.join(dir,entry.name);
  return entry.isDirectory()?listDocs(p):[p];
 });
}
export function checkSpec() {
 const errors=[];
 if(JSON.stringify(listDocs('docs').sort())!==JSON.stringify([...ACTIVE_DOCS].sort()))errors.push('Only three active docs are allowed');
 const files=[...ACTIVE_DOCS,...ENTRY_DOCS];
 for(const file of files)errors.push(...validateActiveLinks(fs.readFileSync(file,'utf8'),file));
 const spec=fs.readFileSync(ACTIVE_DOCS[0],'utf8');
 for(const [prefix,count] of [['U',15],['H',10],['R',13]]) {
  const ids=[...spec.matchAll(new RegExp(`^\\| (${prefix}\\d{2}) `,'gm'))].map(m=>m[1]);
  const expected=Array.from({length:count},(_,i)=>`${prefix}${String(i+1).padStart(2,'0')}`);
  if(ids.join(',')!==expected.join(','))errors.push(`Expected unique ${prefix}01-${prefix}${count}`);
 }
 try {checkExecutionState();}catch(error){errors.push(error.message);}
 const {rows}=JSON.parse(fs.readFileSync('fixtures/synthetic/frozen-acceptance-rows.json','utf8'));
 const index=JSON.parse(fs.readFileSync('handoff/CASE_INDEX.json','utf8'));
 if(rows.length!==78||new Set(rows.map(r=>r.id)).size!==78)errors.push('Expected 78 unique acceptance rows');
 const hash=createHash('sha256').update(rows.map(r=>r.text).join('\n')).digest('hex');
 if(hash!=='3048e362c6f0f0a868ce453d317546789c4280507a1401ee4c113f0614f4cb8c')errors.push('Frozen T01-T78 row text changed');
 for(const c of index.cases){const row=rows.find(r=>r.id===c.id)?.text;if(!row||![c.label,c.input,c.expected,c.forbidden].filter(Boolean).every(v=>row.includes(v)))errors.push(`Acceptance oracle drift: ${c.id}`);}
 if(errors.length)throw new Error(errors.join('\n'));
 return `PASS: three active docs, entry links, U15/H10/R13, N dependencies/state, frozen T78. Archive not consulted; runtime acceptance NOT RUN.`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(checkSpec());}catch(error){console.error(error.message);process.exitCode=1;}}
