import {parseFieldLedgerBundle,type FieldLedgerBundle,type FieldLedgerRecord,type FieldLedgerSource} from '../../packages/domain/src/field-ledger.js';

export class LedgerCsvError extends Error {constructor(public readonly code='LEDGER_CSV_INVALID'){super(code);}}
const header=(value:string)=>value.replace(/^\uFEFF/,'').replace(/\s+/g,'').trim();
const aliases={id:['기록ID','업무ID'],projectId:['현장ID'],projectName:['현장명'],occurredAt:['업무발생일'],receivedAt:['자료접수일'],type:['업무유형'],party:['상대업체'],item:['품목'],quantity:['수량'],amountMinor:['금액(원)','금액'],request:['요청내용'],change:['변경내용'],status:['현재상태'],attribution:['현장귀속'],confirmation:['확인상태'],nextAction:['다음행동','확인필요사항'],previousIds:['이전기록','연결된이전기록'],supersedes:['대체한기록'],sourceIds:['원문자료ID'],updatedAt:['마지막확인시각','마지막수정확인일시'],revision:['기록판','기록버전','revision','버전'],sourceVersions:['근거판']} as const;
type Field=keyof typeof aliases;
const recognized=(headers:string[])=>['id','request','sourceIds'].every(field=>aliases[field as Field].some(name=>headers.includes(name)));
const unknown=new Set(['','미확인','미측정','없음','unknown','null','n/a','-']);
const nullable=(value:string)=>unknown.has(value.trim().toLowerCase())?null:value.trim();
const unguard=(value:string)=>value.startsWith("'")&&/^[=+\-@\t\r]/.test(value.slice(1))?value.slice(1):value;
const list=(value:string)=>nullable(value)===null?[]:[...new Set(value.split(/[|;,\n]/).map(v=>v.trim()).filter(Boolean))];

/** RFC 4180 records: quoted commas, escaped quotes and multiline fields are preserved. */
export function parseCsvRecords(value:string,firstOnly=false):string[][]{
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 const push=()=>{row.push(field);field='';closed=false;};
 const end=()=>{push();if(row.some(v=>v.trim()))rows.push(row);row=[];};
 const input=value.replace(/^\uFEFF/,'');
 for(let i=0;i<input.length;i++){
  const character=input[i];
  if(quoted){if(character==='"'){if(input[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=character;continue;}
  if(closed&&character!==','&&character!=='\r'&&character!=='\n'){if(character===' '||character==='\t')continue;throw new LedgerCsvError();}
  if(character==='"'){if(field.length)throw new LedgerCsvError();quoted=true;continue;}
  if(character===','){push();continue;}
  if(character==='\r'||character==='\n'){end();if(character==='\r'&&input[i+1]==='\n')i++;if(firstOnly&&rows.length)return rows;continue;}
  field+=character;
 }
 if(quoted)throw new LedgerCsvError();
 if(field.length||row.length||closed)end();return rows;
}

function amount(value:string):string|null{
 const raw=nullable(value);if(raw===null)return null;
 const formatted=raw.replace(/^₩\s*/,'').replace(/\s*원$/,'');
 if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(formatted))throw new LedgerCsvError('LEDGER_CSV_AMOUNT_INVALID');
 return BigInt(formatted.replaceAll(',','').replace(/\.0+$/,'')).toString();
}
function confirmation(value:string):FieldLedgerRecord['confirmation']{
 const normalized=value.trim();if(!normalized)return 'recorded';
 if(['recorded','기록','기록됨'].includes(normalized))return 'recorded';
 if(['pending','확인 대기','미확정','미확인'].includes(normalized))return 'pending';
 if(['confirmed','확인 완료','확정','확인됨'].includes(normalized))return 'confirmed';
 throw new LedgerCsvError('LEDGER_CSV_CONFIRMATION_INVALID');
}
function attribution(value:string,projectId:string|null):FieldLedgerRecord['attribution']{
 const normalized=value.trim();if(!normalized)return projectId===null?'review':'assigned';
 if(['assigned','현장 연결','현장귀속','확정'].includes(normalized))return 'assigned';
 if(['review','귀속 검토','귀속검토','미확인','현장 확인 전'].includes(normalized))return 'review';
 throw new LedgerCsvError('LEDGER_CSV_ATTRIBUTION_INVALID');
}

/** Only explicit ledger schemas become typed rows. Other CSV files remain ordinary receipts. */
export function importLedgerCsv(bytes:Buffer,current:FieldLedgerBundle,csvSource:FieldLedgerSource,selectedProjectId:string|null):FieldLedgerBundle|null{
 const text=bytes[0]===0xff&&bytes[1]===0xfe?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8');
 let first:string[][];try{first=parseCsvRecords(text,true);}catch{return null;}
 const headers=(first[0]??[]).map(header);if(!recognized(headers))return null;
 if(new Set(headers).size!==headers.length)throw new LedgerCsvError('LEDGER_CSV_DUPLICATE_HEADER');
 const rows=parseCsvRecords(text);if(rows.length<2)throw new LedgerCsvError('LEDGER_CSV_EMPTY');
 const columns=new Map<Field,number>();for(const [field,names] of Object.entries(aliases)){
  const found=names.map(name=>headers.indexOf(name)).filter(index=>index>=0);if(found.length>1)throw new LedgerCsvError('LEDGER_CSV_DUPLICATE_HEADER');if(found.length===1)columns.set(field as Field,found[0] as number);
 }
 const knownSources=new Map(current.sources.map(source=>[source.id,source])),missing=new Set<string>(),usedSources=new Set<string>();
 const records=rows.slice(1).map((cells):FieldLedgerRecord=>{
  if(cells.length!==headers.length)throw new LedgerCsvError('LEDGER_CSV_COLUMNS_INVALID');
  const get=(field:Field)=>unguard(cells[columns.get(field)??-1]??'');
  const id=nullable(get('id')),request=nullable(get('request'));if(!id||!request)throw new LedgerCsvError('LEDGER_CSV_REQUIRED_FIELD');
  let projectId=nullable(get('projectId'));const projectName=nullable(get('projectName'));
  if(projectId===null&&projectName!==null){const matches=current.projects.filter(project=>project.name===projectName);if(matches.length!==1)throw new LedgerCsvError('LEDGER_CSV_PROJECT_INVALID');projectId=matches[0]?.id??null;}
  if(projectId===null&&projectName===null)projectId=selectedProjectId;
  const project=current.projects.find(value=>value.id===projectId);if(projectId!==null&&!project||projectName!==null&&project?.name!==projectName)throw new LedgerCsvError('LEDGER_CSV_PROJECT_INVALID');
  const sourceIds=list(get('sourceIds')).filter(source=>{if(knownSources.has(source)){usedSources.add(source);return true;}missing.add(source);return false;});
  sourceIds.push(csvSource.id);
  const sourceVersions:Record<string,number>=Object.fromEntries(sourceIds.map(source=>[source,knownSources.get(source)?.version??1]));
  const suppliedVersions=list(get('sourceVersions'));
  for(const supplied of suppliedVersions){const match=/^(.+):v([1-9]\d*)$/.exec(supplied);if(!match?.[1]||!match[2])throw new LedgerCsvError('LEDGER_CSV_SOURCE_VERSION_INVALID');if(sourceIds.includes(match[1])&&knownSources.has(match[1]))sourceVersions[match[1]]=Number(match[2]);}
  const rawRevision=nullable(get('revision'));if(rawRevision!==null&&!/^[1-9]\d*$/.test(rawRevision))throw new LedgerCsvError('LEDGER_CSV_REVISION_INVALID');
  return {id,projectId,projectName:project?.name??null,occurredAt:nullable(get('occurredAt')),receivedAt:nullable(get('receivedAt')),type:nullable(get('type'))??'기타',party:nullable(get('party')),item:nullable(get('item')),quantity:nullable(get('quantity')),amountMinor:amount(get('amountMinor')),request,change:nullable(get('change')),status:nullable(get('status'))??'기록',attribution:attribution(get('attribution'),projectId),confirmation:confirmation(get('confirmation')),nextAction:nullable(get('nextAction')),previousIds:list(get('previousIds')),sourceIds:[...new Set(sourceIds)],updatedAt:nullable(get('updatedAt')),origin:'import',revision:rawRevision===null?1:Number(rawRevision),sourceVersions,transactionKey:null,supersedes:nullable(get('supersedes'))};
 });
 const unavailable=[...missing].join(', '),locator=`CSV 데이터 행 2~${rows.length}; 업무ID/기록ID로 행 연결${unavailable?`; 미등록 원문 ID: ${unavailable}`:''}`;
 const source={...csvSource,locator:locator.length>1000?`${locator.slice(0,950)}… 전체 참조는 원본 CSV에 보관`:locator};
 try{return parseFieldLedgerBundle({schemaVersion:1,projects:current.projects,sources:[...current.sources.filter(value=>usedSources.has(value.id)),source],records});}catch{throw new LedgerCsvError('LEDGER_CSV_ROW_INVALID');}
}
