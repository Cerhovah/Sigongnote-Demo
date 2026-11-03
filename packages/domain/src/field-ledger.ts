/** Shared, source-backed read model for the connected app and local customer demonstration.
 * This module never approves an order, posts an accounting entry, or executes a payment. */
export type FieldLedgerProject = {id:string;name:string};
export type FieldLedgerSource = {
 id:string;kind:string;label:string;locator?:string|null;sha256?:string|null;
 url?:string|null;version?:number;
};
export type FieldLedgerRecord = {
 id:string;projectId:string|null;projectName:string|null;
 occurredAt:string|null;receivedAt:string|null;type:string;party:string|null;
 item:string|null;quantity:string|null;amountMinor:string|null;request:string;
 change:string|null;status:string;attribution:'assigned'|'review';
 confirmation:'recorded'|'pending'|'confirmed';nextAction:string|null;
 previousIds:string[];sourceIds:string[];updatedAt:string|null;
 origin:'journal'|'event'|'business'|'import';revision?:number;
 transactionKey?:string|null;supersedes?:string|null;sourceVersions?:Record<string,number>;
};
export type FieldLedgerBundle = {
 schemaVersion:1;projects:FieldLedgerProject[];sources:FieldLedgerSource[];records:FieldLedgerRecord[];
};
export type FieldLedgerQuery = {projectId?:string|null;from?:string|null;to?:string|null;search?:string;attribution?:'assigned'|'review'|'all'};
export type FieldLedgerSnapshot = {
 schemaVersion:1;id:string;generatedAt:string;
 query:{projectId:string|null;from:string|null;to:string|null;search:string;attribution:'assigned'|'review'|'all'};
 project:FieldLedgerProject|null;projects:FieldLedgerProject[];
 records:FieldLedgerRecord[];sources:FieldLedgerSource[];
 summary:{recordCount:number;sourceCount:number;transactionCount:number;changeCount:number;
 attributionReviewCount:number;attributionReviewTotal:number;assignedTotal:number;pendingCount:number;lastReceivedAt:string|null};
};

export class FieldLedgerError extends Error {
 constructor(public readonly code:string){super(code);this.name='FieldLedgerError';}
}
const fail=(code:string):never=>{throw new FieldLedgerError(code);};
const own=(o:Record<string,unknown>,key:string)=>Object.hasOwn(o,key)?o[key]:undefined;
function object(v:unknown):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v))return fail('FIELD_LEDGER_OBJECT_REQUIRED');
 const proto=Object.getPrototypeOf(v);if(proto!==Object.prototype&&proto!==null)return fail('FIELD_LEDGER_INVALID_OBJECT');
 return v as Record<string,unknown>;
}
function text(v:unknown,max=4000):string{
 if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))return fail('FIELD_LEDGER_INVALID_TEXT');
 return v;
}
function nullable(v:unknown,max=4000):string|null{return v===null||v===undefined?null:text(v,max);}
function array(v:unknown,max=100000):unknown[]{if(!Array.isArray(v)||v.length>max)return fail('FIELD_LEDGER_INVALID_ARRAY');return v;}
function strings(v:unknown):string[]{return [...new Set(array(v,500).map(x=>text(x,500)))].sort();}
function version(v:unknown):number{if(v===undefined)return 1;if(!Number.isSafeInteger(v)||Number(v)<1)return fail('FIELD_LEDGER_INVALID_VERSION');return Number(v);}
function member<T extends string>(v:unknown,values:readonly T[]):T{if(typeof v!=='string'||!values.includes(v as T))return fail('FIELD_LEDGER_INVALID_STATUS');return v as T;}
function date(v:unknown):string|null{
 if(v===null||v===undefined)return null;
 const value=text(v,60);
 if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return fail('FIELD_LEDGER_INVALID_DATE');
 const day=value.slice(0,10),parsed=Date.parse(day+'T00:00:00Z');
 if(!Number.isFinite(Date.parse(value))||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==day)return fail('FIELD_LEDGER_INVALID_DATE');
 return value;
}
function day(v:unknown):string|null{const value=date(v);if(value!==null&&value.length!==10)return fail('FIELD_LEDGER_DATE_FILTER_REQUIRED');return value;}
function safeUrl(v:unknown):string|null{
 const value=nullable(v,4096);if(value===null)return null;
 if(value.includes('\\')||Array.from(value).some(c=>c.charCodeAt(0)<=32||c.charCodeAt(0)===127))return fail('FIELD_LEDGER_INVALID_SOURCE_URL');
 if(value.startsWith('/')&&!value.startsWith('//'))return value;
 try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return fail('FIELD_LEDGER_INVALID_SOURCE_URL');return value;}catch{return fail('FIELD_LEDGER_INVALID_SOURCE_URL');}
}
/** Stable JSON supports consistent snapshot IDs regardless of object property ordering. */
export function canonicalFieldLedger(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonicalFieldLedger).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonicalFieldLedger(v)).join(',')+'}';
 return JSON.stringify(value);
}
function selectVersions<T extends {id:string}>(rows:T[],number:(v:T)=>number,kind:string):T[]{
 const selected=new Map<string,T>();
 for(const row of rows){const prior=selected.get(row.id);if(!prior||number(row)>number(prior)){selected.set(row.id,row);continue;}
  if(number(row)===number(prior)&&canonicalFieldLedger(row)!==canonicalFieldLedger(prior))fail('FIELD_LEDGER_'+kind+'_VERSION_CONFLICT');
 }
 return [...selected.values()].sort((a,b)=>a.id.localeCompare(b.id,'en'));
}
function source(raw:unknown):FieldLedgerSource{
 const s=object(raw),sha=nullable(own(s,'sha256'),64);if(sha!==null&&!/^[a-f0-9]{64}$/i.test(sha))fail('FIELD_LEDGER_INVALID_SOURCE_HASH');
 return {id:text(own(s,'id'),500),kind:text(own(s,'kind'),80),label:text(own(s,'label'),500),locator:nullable(own(s,'locator'),1000),sha256:sha?.toLowerCase()??null,url:safeUrl(own(s,'url')),version:version(own(s,'version'))};
}
function record(raw:unknown,projects:Map<string,FieldLedgerProject>,sources:Map<string,FieldLedgerSource>):FieldLedgerRecord{
 const r=object(raw),id=text(own(r,'id'),500),projectId=nullable(own(r,'projectId'),500),projectName=nullable(own(r,'projectName'),500),attribution=member(own(r,'attribution'),['assigned','review'] as const);
 if(projectId!==null&&!projects.has(projectId)||attribution==='assigned'&&projectId===null)fail('FIELD_LEDGER_UNKNOWN_PROJECT');
 if(projectId!==null&&projectName!==null&&projectName!==projects.get(projectId)!.name)fail('FIELD_LEDGER_PROJECT_NAME_CONFLICT');
 const sourceIds=strings(own(r,'sourceIds'));if(!sourceIds.length||sourceIds.some(s=>!sources.has(s)))fail('FIELD_LEDGER_MISSING_SOURCE');
 const inputVersions=own(r,'sourceVersions')===undefined?null:object(own(r,'sourceVersions'));
 if(inputVersions&&Object.keys(inputVersions).some(s=>!sourceIds.includes(s)))fail('FIELD_LEDGER_UNKNOWN_SOURCE_VERSION');
 const sourceVersions=Object.fromEntries(sourceIds.map(s=>[s,version(inputVersions?own(inputVersions,s):sources.get(s)!.version)]));
 if(sourceIds.some(s=>sourceVersions[s]!==sources.get(s)!.version))fail('FIELD_LEDGER_STALE_SOURCE_VERSION');
 const amountMinor=nullable(own(r,'amountMinor'),32);if(amountMinor!==null&&!/^-?(?:0|[1-9][0-9]{0,19})$/.test(amountMinor))fail('FIELD_LEDGER_INVALID_AMOUNT');
 const previousIds=strings(own(r,'previousIds')),supersedes=nullable(own(r,'supersedes'),500);if(previousIds.includes(id)||supersedes===id)fail('FIELD_LEDGER_SELF_REFERENCE');
 return {id,projectId,projectName:projectId!==null?projects.get(projectId)!.name:projectName,
  occurredAt:date(own(r,'occurredAt')),receivedAt:date(own(r,'receivedAt')),type:text(own(r,'type'),80),party:nullable(own(r,'party'),500),item:nullable(own(r,'item'),1000),quantity:nullable(own(r,'quantity'),500),amountMinor,
  request:text(own(r,'request')),change:nullable(own(r,'change')),status:text(own(r,'status'),200),attribution,confirmation:member(own(r,'confirmation'),['recorded','pending','confirmed'] as const),nextAction:nullable(own(r,'nextAction')),
  previousIds,sourceIds,updatedAt:date(own(r,'updatedAt')),origin:member(own(r,'origin'),['journal','event','business','import'] as const),revision:version(own(r,'revision')),transactionKey:nullable(own(r,'transactionKey'),500),supersedes,sourceVersions};
}
export function parseFieldLedgerBundle(input:unknown):FieldLedgerBundle{
 const raw=object(input);if(own(raw,'schemaVersion')!==1)fail('FIELD_LEDGER_UNSUPPORTED_SCHEMA');
 const projects=selectVersions(array(own(raw,'projects'),10000).map(v=>{const p=object(v);return {id:text(own(p,'id'),500),name:text(own(p,'name'),500)};}),()=>1,'PROJECT');
 const sources=selectVersions(array(own(raw,'sources')).map(source),s=>s.version??1,'SOURCE'),sourceMap=new Map(sources.map(s=>[s.id,s])),projectMap=new Map(projects.map(p=>[p.id,p]));
 const records=selectVersions(array(own(raw,'records')).map(v=>record(v,projectMap,sourceMap)),r=>r.revision??1,'RECORD');
 const byId=new Map(records.map(r=>[r.id,r]));
 for(const r of records){const seen=new Set([r.id]);let previous=r.supersedes;
  while(previous){if(seen.has(previous))fail('FIELD_LEDGER_SUPERSESSION_CYCLE');seen.add(previous);const p=byId.get(previous);if(p&&p.projectId!==r.projectId)fail('FIELD_LEDGER_CROSS_PROJECT_SUPERSESSION');previous=p?.supersedes;}
 }
 return {schemaVersion:1,projects,sources,records};
}
/** Later revisions replace the same ID; stale arrivals never overwrite a newer revision. */
export function mergeFieldLedgerBundles(base:FieldLedgerBundle,incoming:FieldLedgerBundle):FieldLedgerBundle{
 const left=parseFieldLedgerBundle(base),right=parseFieldLedgerBundle(incoming);
 const sources=selectVersions([...left.sources,...right.sources],s=>s.version??1,'SOURCE');
 const records=selectVersions([...left.records,...right.records],r=>r.revision??1,'RECORD');
 return parseFieldLedgerBundle({schemaVersion:1,projects:[...left.projects,...right.projects],sources,records});
}
const transactionTypes=new Set(['청구','입금','지급','정산','invoice','billing','payment','cash_receipt','cash_payment','settlement']);
export const isFieldLedgerTransaction=(r:FieldLedgerRecord)=>transactionTypes.has(r.type.toLowerCase());
export const isFieldLedgerChange=(r:FieldLedgerRecord)=>Boolean(r.change)||['변경','정정','change','correction'].includes(r.type.toLowerCase());
const authority:Record<FieldLedgerRecord['origin'],number>={journal:0,event:1,import:2,business:3};
/** Counts observations, not settled money. Raw journal receipts cannot become extra transactions. */
export function fieldLedgerTransactions(records:readonly FieldLedgerRecord[]):FieldLedgerRecord[]{
 const superseded=new Set(records.map(r=>r.supersedes).filter((x):x is string=>Boolean(x)));
 const rows=new Map<string,FieldLedgerRecord>();
 for(const r of records){if(!isFieldLedgerTransaction(r)||r.origin==='journal'||superseded.has(r.id))continue;
  const key=canonicalFieldLedger(r.transactionKey?[r.projectId,r.type.toLowerCase(),'key',r.transactionKey]:[r.projectId,r.type.toLowerCase(),r.party,r.item,r.quantity,r.amountMinor,[...r.sourceIds].sort()]);
  const previous=rows.get(key);if(!previous||authority[r.origin]>authority[previous.origin])rows.set(key,r);
 }
 return [...rows.values()];
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const value of Object.values(v))freeze(value);Object.freeze(v);}return v;}
const koreanDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
function workDay(value:string|null):string|null{return value===null?null:value.length===10?value:koreanDay.format(new Date(value));}
export async function createFieldLedgerSnapshot(input:FieldLedgerBundle,filter:FieldLedgerQuery={},generatedAt=new Date().toISOString()):Promise<FieldLedgerSnapshot>{
 const bundle=parseFieldLedgerBundle(input),query={projectId:nullable(filter.projectId,500),from:day(filter.from),to:day(filter.to),search:filter.search?.trim()??'',attribution:member(filter.attribution??'all',['assigned','review','all'] as const)};
 if(query.search.length>1000)fail('FIELD_LEDGER_SEARCH_TOO_LONG');
 const project=query.projectId===null?null:bundle.projects.find(p=>p.id===query.projectId);if(project===undefined)fail('FIELD_LEDGER_UNKNOWN_PROJECT');
 if(query.from&&query.to&&query.from>query.to)fail('FIELD_LEDGER_INVALID_DATE_RANGE');
 const created=date(generatedAt);if(!created||created.length===10)return fail('FIELD_LEDGER_TIMESTAMP_REQUIRED');
 const search=query.search.toLocaleLowerCase('ko-KR');
 const matching=bundle.records.filter(r=>{
  const occurred=workDay(r.occurredAt??r.receivedAt);
  return (query.projectId===null||r.projectId===query.projectId)&&(!query.from||occurred!==null&&occurred>=query.from)&&(!query.to||occurred!==null&&occurred<=query.to)&&(!search||[r.id,r.projectName,r.type,r.party,r.item,r.request,r.change,r.status,r.nextAction,...r.sourceIds].filter(Boolean).join(' ').toLocaleLowerCase('ko-KR').includes(search));
 });
 const records=matching.filter(r=>query.attribution==='all'||r.attribution===query.attribution).sort((a,b)=>(b.occurredAt??b.receivedAt??'').localeCompare(a.occurredAt??a.receivedAt??'')||b.id.localeCompare(a.id,'en'));
 const used=new Set(records.flatMap(r=>r.sourceIds)),sources=bundle.sources.filter(s=>used.has(s.id));
 const lastReceivedAt=records.map(r=>r.receivedAt).filter((s):s is string=>s!==null).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null;
 const summary={recordCount:records.length,sourceCount:sources.length,transactionCount:fieldLedgerTransactions(records).length,changeCount:records.filter(isFieldLedgerChange).length,attributionReviewCount:records.filter(r=>r.attribution==='review').length,attributionReviewTotal:matching.filter(r=>r.attribution==='review').length,assignedTotal:matching.filter(r=>r.attribution==='assigned').length,pendingCount:records.filter(r=>r.confirmation==='pending').length,lastReceivedAt};
 const content={schemaVersion:1 as const,query,project:project??null,projects:bundle.projects,records,sources,summary};
 const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalFieldLedger(content)));
 const id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
 return freeze({...content,id,generatedAt:created});
}

const attributionLabel={assigned:'현장 연결',review:'귀속 검토'};
const confirmationLabel={recorded:'기록',pending:'확인 대기',confirmed:'확인 완료'};
function csvCell(value:string|null):string{
 const raw=value===null?'미확인':value;
 // Excel/LibreOffice treat leading whitespace plus these characters as formulas.
 const guarded=/^[\s\uFEFF]*[=+\-@]/u.test(raw)||/^[\t\r\n]/.test(raw)?"'"+raw:raw;
 return '"'+guarded.replaceAll('"','""')+'"';
}
export function fieldLedgerCsv(snapshot:FieldLedgerSnapshot):string{
 const headers=['기준 ID','보고서 기준 시각','기록 ID','현장 ID','현장명','업무 발생일','자료 접수일','업무 유형','상대 업체','품목','수량','금액(원)','요청 내용','변경 내용','현재 상태','현장 귀속','확인 상태','다음 행동','이전 기록','대체한 기록','원문 자료 ID','근거 판','마지막 확인 시각'];
 const lines=[headers,...snapshot.records.map(r=>[snapshot.id,snapshot.generatedAt,r.id,r.projectId,r.projectName,r.occurredAt,r.receivedAt,r.type,r.party,r.item,r.quantity,r.amountMinor,r.request,r.change,r.status,attributionLabel[r.attribution],confirmationLabel[r.confirmation],r.nextAction,r.previousIds.join(' | '),r.supersedes??null,r.sourceIds.join(' | '),r.sourceIds.map(s=>s+':v'+(r.sourceVersions?.[s]??1)).join(' | '),r.updatedAt])];
 return '\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
const escapeHtml=(v:string|number|null|undefined)=>String(v??'미확인').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const money=(v:string|null)=>v===null?'미확인':BigInt(v).toLocaleString('ko-KR')+'원';
/** No remote assets or scripts. The same frozen snapshot feeds HTML, PDF and CSV. */
export function fieldLedgerReportHtml(snapshot:FieldLedgerSnapshot):string{
 const title=(snapshot.project?.name??'전체 현장')+' 최신 업무현황',changes=snapshot.records.filter(isFieldLedgerChange),actions=snapshot.records.filter(r=>r.nextAction||r.attribution==='review'||r.confirmation==='pending');
 const ref=(r:FieldLedgerRecord)=>r.sourceIds.map(id=>'<a href="#source-'+encodeURIComponent(id)+'">'+escapeHtml(id)+'</a>').join(', ');
 const items=(rows:FieldLedgerRecord[],mode:'change'|'action')=>rows.length?'<ol>'+rows.map(r=>'<li><strong>'+escapeHtml(r.projectName??'현장 귀속 검토')+' · '+escapeHtml(r.request)+'</strong><p>'+escapeHtml(mode==='change'?r.change??r.request:r.nextAction??r.status)+'</p><small>'+escapeHtml(r.status)+' · '+escapeHtml(attributionLabel[r.attribution])+' · '+escapeHtml(confirmationLabel[r.confirmation])+' · '+ref(r)+'</small></li>').join('')+'</ol>':'<p class="muted">해당 기록 없음</p>';
 const rows=snapshot.records.map(r=>'<tr><td>'+escapeHtml(r.occurredAt)+'<small>접수 '+escapeHtml(r.receivedAt)+'</small></td><td>'+escapeHtml(r.type)+'<small>'+escapeHtml(r.id)+'</small></td><td><strong>'+escapeHtml(r.request)+'</strong>'+(r.item?'<small>'+escapeHtml(r.item)+(r.quantity?' · '+escapeHtml(r.quantity):'')+'</small>':'')+(r.change?'<small>변경: '+escapeHtml(r.change)+'</small>':'')+'</td><td>'+escapeHtml(r.party)+'</td><td class="money">'+escapeHtml(money(r.amountMinor))+'</td><td>'+escapeHtml(r.status)+'<small>'+escapeHtml(attributionLabel[r.attribution])+' · '+escapeHtml(confirmationLabel[r.confirmation])+'</small></td><td>'+ref(r)+(r.previousIds.length?'<small>이전 '+r.previousIds.map(escapeHtml).join(', ')+'</small>':'')+(r.supersedes?'<small>대체 '+escapeHtml(r.supersedes)+'</small>':'')+'</td></tr>').join('');
 const sourceRows=snapshot.sources.map(s=>'<li id="source-'+encodeURIComponent(s.id)+'"><strong>'+escapeHtml(s.id)+' · '+escapeHtml(s.label)+'</strong><p>'+escapeHtml(s.kind)+' · '+escapeHtml(s.locator??'위치 미기록')+' · 판 '+escapeHtml(s.version??1)+'</p>'+(s.sha256?'<code>'+escapeHtml(s.sha256)+'</code>':'')+'</li>').join('');
 return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>'+escapeHtml(title)+'</title><style>body{font:16px/1.6 system-ui,"Malgun Gothic",sans-serif;color:#18332b;margin:0;background:#fff}main{max-width:1200px;margin:32px auto;padding:0 24px}h1{font-size:30px;margin-bottom:8px}h2{font-size:21px;margin-top:30px}.meta,.muted,small{color:#52665d}small{display:block;font-size:12px}code{font-size:11px;overflow-wrap:anywhere}.metrics{display:flex;gap:24px;flex-wrap:wrap;border-block:1px solid #cbd6ce;padding:16px 0}.metrics strong{display:block;font-size:24px}table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}th,td{text-align:left;padding:10px 7px;border-bottom:1px solid #dce4de;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3ef}.money{white-space:normal}a{color:#1a6650}li{margin:14px 0}li p{margin:4px 0}.basis{font-size:11px;overflow-wrap:anywhere;border-top:1px solid #cbd6ce;padding-top:14px}@media print{@page{size:A4 landscape;margin:12mm}main{margin:0;padding:0}h1{font-size:24px}body{font-size:12px}table{font-size:10px}small{font-size:9px}thead{display:table-header-group}tr,li{break-inside:avoid}h2{break-after:avoid}}@media(max-width:700px){main{padding:0 12px}.table-wrap{overflow:auto}table{min-width:850px}}</style></head><body><main><header><p class="meta">시공노트 · 현장 업무원장</p><h1>'+escapeHtml(title)+'</h1><p class="meta">기준 시각 '+escapeHtml(snapshot.generatedAt)+(snapshot.query.from||snapshot.query.to?' · 업무일 '+escapeHtml(snapshot.query.from??'처음')+' ~ '+escapeHtml(snapshot.query.to??'마지막'):'')+'</p></header><section class="metrics"><div>업무 기록<strong>'+snapshot.summary.recordCount+'</strong></div><div>원문 자료<strong>'+snapshot.summary.sourceCount+'</strong></div><div>변경 기록<strong>'+snapshot.summary.changeCount+'</strong></div><div>귀속 검토<strong>'+snapshot.summary.attributionReviewCount+'</strong></div><div>확인 대기<strong>'+snapshot.summary.pendingCount+'</strong></div></section><section><h2>중요 변경</h2>'+items(changes,'change')+'</section><section><h2>대표 확인 및 다음 행동</h2>'+items(actions,'action')+'</section><section><h2>현장 업무원장</h2><div class="table-wrap"><table><thead><tr><th>업무일·접수일</th><th>업무 유형</th><th>내용</th><th>상대 업체</th><th>금액</th><th>현재 상태</th><th>원문·이전 기록</th></tr></thead><tbody>'+rows+'</tbody></table></div></section><section><h2>원문 근거</h2><ul>'+sourceRows+'</ul></section><footer class="basis">기준 ID '+escapeHtml(snapshot.id)+'<br>기록에 표시된 요청·승인·청구·입금은 각각의 업무 상태로 구분합니다.</footer></main></body></html>';
}
