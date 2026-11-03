import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {inspectContent} from './check-staged.mjs';

const unit=process.argv[2],prepareOnly=process.argv.includes('--prepare-only');
if(!/^[A-Za-z0-9_-]+$/.test(unit??''))throw Error('Expected review unit');
const root=process.cwd(),dir='.work/'+unit.toLowerCase();
if(fs.existsSync(dir+'/review-invocation.json'))throw Error('One review session already requested');
const config=JSON.parse(fs.readFileSync(dir+'/review-config.json','utf8'));
if(!Array.isArray(config.reviewCommands)||!config.reviewCommands.length)throw Error('Provide scoped reviewCommands for Claude Code to execute');
const hash=b=>createHash('sha256').update(b).digest('hex');
const scopedPath=p=>{
 if(typeof p!=='string'||p.includes('\\')||path.isAbsolute(p)||p.split('/').includes('..')||p.startsWith('0.2 ver/')||p==='0.2 ver')throw Error('Invalid review path');
 if(p.startsWith('.work/')&&!p.startsWith(dir+'/'))throw Error('Unrelated private review input');
 return p;
};
const files=[...new Set([...(config.files??[]),...(config.context??[])])].map(p=>{
 scopedPath(p);const b=fs.readFileSync(p);
 if(inspectContent(p,b).length)throw Error('Privacy check: '+p);
 return {path:p,sha256:hash(b)};
});
if(!files.length)throw Error('Provide current review files');
for(const command of config.reviewCommands){
 if(typeof command!=='string'||!command.trim()||/[\r\n;&|`<>*()]/.test(command)||inspectContent('review-command.txt',Buffer.from(command)).length)throw Error('Expected a single scoped local test command');
}
const base=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const prompt=[
 '시공노트 '+unit+' 커밋의 유일한 독립 검수자 + 디자인 조정/구현 제안자다. 실제 Claude Code flow-reviewer/Fable 5.1 high 한 세션으로 수행한다.',
 'Read/Grep/Glob/Bash/PowerShell 도구로 아래 변경 파일과 관련 호출 경로를 직접 읽고 필요한 국소시험 명령을 실행하라. 전달된 결과만 재요약하지 말고 직접 확인한 근거를 제시하라. 같은 세션에서 탐색→시험→추론을 이어가되 추가 에이전트/별도 모델 요청/검수 세션은 시작하지 않는다.',
 'AGENTS.md와 현재 AGENT_SPEC 관련 계약을 따른다. 0.2 ver/, 환경 비밀파일, 개인 원문, 무관한 사용자 미커밋 파일을 읽거나 검색하지 않는다. .work는 아래 명시한 이번 검수 파일만 읽는다. 검색은 관련 소스 폴더로 좁히고 이 제외 범위를 유지한다. 코드 수정·commit/push·유료 제품 API 호출·실제 자료 전송은 하지 않는다. 시험 환경값을 출력하지 않는다.',
 '기준 SHA: '+base,
 '현재 요구: '+(config.requirements??''),
 '작성자 실행 결과(검수자의 직접 실행과 구별): '+(config.verification??''),
 '변경/관련 파일과 hash: '+JSON.stringify(files),
 '국소시험 명령: '+JSON.stringify(config.reviewCommands),
 '셸 권한은 위 명령 문자열 각각에만 허용된다. 첫 셸 도구 호출은 위 첫 시험 명령을 문자 그대로 단독 실행하라. cd, git -c, 세미콜론, 명령 연결, 리다이렉션, 명령 치환을 붙이지 않는다. 결합 명령이 거부돼도 셸 전체가 차단됐다고 판단하지 말고 허용된 단일 명령을 실행하라. 저장소 위치는 이미 현재 작업 디렉터리다.',
 'P0/P1 위치·재현·최소수정, P2 최대3개, 디자인/설계 제안 최대3개, 읽은 파일·직접 실행한 명령/결과·미실행을 한국어 1400단어 이내로 보고하라. 권한/환경 실패를 PASS로 쓰지 않는다. CODE_DONE/실연결/실사용을 구별한다.'
].join('\n');
if(inspectContent('review-input.txt',Buffer.from(prompt)).length)throw Error('Private content in prompt');
const toolNames=['Read','Grep','Glob','Bash','PowerShell'];
const readCommands=['git status --short','git diff *','git show *','git log *','git ls-files *','git rev-parse HEAD'];
const allowed=['Read','Grep','Glob',...['Bash','PowerShell'].flatMap(tool=>[...readCommands,...config.reviewCommands].map(cmd=>tool+'('+cmd+')'))];
const sessionId=randomUUID();
const args=['--print','--agent','flow-reviewer','--model','claude-fable-5-1','--effort','high',
 '--output-format','stream-json','--verbose','--session-id',sessionId,'--name','시공노트 '+unit+' Fable 검수',
 '--tools',toolNames.join(','),'--allowedTools',...allowed,'--permission-mode','dontAsk',
 '--strict-mcp-config','--mcp-config','{"mcpServers":{}}'];
const plan={unit,base,sessionId,requestedModel:'claude-fable-5-1',effort:'high',agent:'flow-reviewer',tools:toolNames,
 reviewCommands:config.reviewCommands,files,inputHash:hash(prompt),args};
fs.writeFileSync(dir+'/review-input.txt',prompt);
if(prepareOnly){
 fs.writeFileSync(dir+'/review-plan.json',JSON.stringify({...plan,modelRequested:false},null,2));
 console.log(JSON.stringify({unit,prepared:true,modelRequested:false,tools:toolNames}));
}else{
 const cache=path.join(process.env.LOCALAPPDATA??'', 'npm-cache','_npx');
 const candidates=fs.existsSync(cache)?fs.readdirSync(cache).map(entry=>path.join(cache,entry,'node_modules','@anthropic-ai','claude-code','bin','claude.exe')).filter(p=>fs.existsSync(p)):[];
 const bin=process.env.SIGONGNOTE_CLAUDE_BIN??candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]??'claude';
 const cliVersion=execFileSync(bin,['--version'],{encoding:'utf8',windowsHide:true}).trim();
 const auth=JSON.parse(execFileSync(bin,['auth','status','--json'],{encoding:'utf8',windowsHide:true}));
 if(!auth.loggedIn||auth.authMethod!=='claude.ai'||(config.expectedAccount&&auth.email!==config.expectedAccount))throw Error('CLAUDE_ACCOUNT_MISMATCH');
 fs.writeFileSync(dir+'/review-invocation.json',JSON.stringify({...plan,cliVersion,authMethod:auth.authMethod,
  accountHash:hash(String(auth.email??'')),subscriptionType:auth.subscriptionType},null,2),{flag:'wx'});
 const child=spawn(bin,args,{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const transcript=fs.createWriteStream(dir+'/review-events.jsonl'),err=fs.createWriteStream(dir+'/review-stderr.txt');
 child.stdout.setEncoding('utf8');
 let buffer='',result=null;
 const parseLine=line=>{try{const event=JSON.parse(line);if(event.type==='result')result=event;}catch{}};
 child.stdout.on('data',chunk=>{transcript.write(chunk);buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){parseLine(buffer.slice(0,n));buffer=buffer.slice(n+1);}});
 child.stderr.pipe(err);child.stdin.on('error',()=>{});child.stdin.end(prompt);
 child.on('error',()=>{process.exitCode=1;});
 child.on('close',code=>{
  if(buffer.trim())parseLine(buffer);transcript.end();err.end();
  if(result)fs.writeFileSync(dir+'/review-result.json',JSON.stringify(result,null,2));
  const canonical=Object.values(result?.modelUsage??{}).map(m=>m.canonicalModel).filter(Boolean);
  const complete=code===0&&result?.session_id===sessionId&&!result?.is_error&&canonical.length>0&&canonical.every(m=>m==='claude-fable-5-1');
  fs.writeFileSync(dir+'/review-exit.json',JSON.stringify({sessionId,exitCode:code,status:complete?'RESPONSE_RECEIVED':'REVIEW_BLOCKED'},null,2));
  console.log(JSON.stringify({unit,exitCode:code,sessionId,responseReceived:complete}));
  process.exitCode=complete?0:1;
 });
}
