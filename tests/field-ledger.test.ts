import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalFieldLedger,createFieldLedgerSnapshot,fieldLedgerCsv,fieldLedgerReportHtml,fieldLedgerTransactions,mergeFieldLedgerBundles,parseFieldLedgerBundle,type FieldLedgerBundle,type FieldLedgerRecord} from '../packages/domain/src/field-ledger.ts';

const record=(patch:Partial<FieldLedgerRecord>={}):FieldLedgerRecord=>({id:'record-1',projectId:'project-a',projectName:'시험 현장 A',occurredAt:'2026-01-03',receivedAt:'2026-01-04T01:00:00Z',type:'청구',party:'시험 공급사',item:'시험 자재',quantity:'2개',amountMinor:'12345',request:'시험 청구 자료',change:null,status:'청구 접수',attribution:'assigned',confirmation:'recorded',nextAction:null,previousIds:[],sourceIds:['source-1'],updatedAt:null,origin:'import',...patch});
const bundle=(records:FieldLedgerRecord[]=[record()]):FieldLedgerBundle=>({schemaVersion:1,projects:[{id:'project-a',name:'시험 현장 A'},{id:'project-b',name:'시험 현장 B'}],sources:[{id:'source-1',kind:'document',label:'시험 자료',locator:'sheet:1!A1',sha256:'a'.repeat(64)}],records});
const at='2026-01-05T00:00:00Z';

test('field ledger keeps unknown values and independent attribution/confirmation states',async()=>{
 const snapshot=await createFieldLedgerSnapshot(bundle([record({projectId:null,projectName:null,occurredAt:null,receivedAt:null,quantity:null,amountMinor:null,attribution:'review',confirmation:'pending'})]),{},at);
 assert.equal(snapshot.records[0]!.amountMinor,null);assert.equal(snapshot.records[0]!.occurredAt,null);
 assert.equal(snapshot.summary.attributionReviewCount,1);assert.equal(snapshot.summary.pendingCount,1);
 assert.equal(snapshot.summary.lastReceivedAt,null);assert.equal(snapshot.project,null);
 assert.equal((await createFieldLedgerSnapshot(bundle(snapshot.records),{from:'2026-01-01'},at)).records.length,0);
 assert(Object.isFrozen(snapshot.records[0]));
 const separated=await createFieldLedgerSnapshot(bundle([record(),record({id:'review-record',attribution:'review',confirmation:'pending'})]),{attribution:'assigned'},at);
 assert.equal(separated.records.length,1);assert.equal(separated.summary.attributionReviewTotal,1);assert.equal(separated.summary.attributionReviewCount,0);
 assert(!fieldLedgerCsv(separated).includes('review-record'));
});

test('field ledger repeated imports are idempotent, newer revisions win, stale writes cannot replace them',async()=>{
 const original=bundle(),same=mergeFieldLedgerBundles(original,original);assert.equal(same.records.length,1);
 const newer=bundle([record({revision:2,change:'시험 수량 변경',quantity:'3개',updatedAt:at})]);
 const changed=mergeFieldLedgerBundles(original,newer),again=mergeFieldLedgerBundles(changed,original);
 assert.equal(again.records[0]!.quantity,'3개');assert.equal(again.records[0]!.revision,2);
 assert.throws(()=>mergeFieldLedgerBundles(original,bundle([record({quantity:'99개'})])),/RECORD_VERSION_CONFLICT/);
 const before=await createFieldLedgerSnapshot(original,{},at),after=await createFieldLedgerSnapshot(changed,{},at);
 assert.notEqual(before.id,after.id);assert.match(before.id,/^[a-f0-9]{64}$/);
 assert.equal((await createFieldLedgerSnapshot(original,{},'2026-02-01T00:00:00Z')).id,before.id);
 assert.equal(before.records[0]!.quantity,'2개');
});

test('field ledger refuses missing evidence, stale source links, malformed values and cross-project replacement',()=>{
 assert.throws(()=>parseFieldLedgerBundle(bundle([record({sourceIds:['missing']})])),/MISSING_SOURCE/);
 assert.throws(()=>parseFieldLedgerBundle(bundle([record({sourceIds:[]})])),/MISSING_SOURCE/);
 assert.throws(()=>parseFieldLedgerBundle(bundle([record({amountMinor:'12.50'})])),/INVALID_AMOUNT/);
 assert.throws(()=>parseFieldLedgerBundle(bundle([record({occurredAt:'2026-02-30'})])),/INVALID_DATE/);
 assert.throws(()=>parseFieldLedgerBundle(bundle([record({projectId:'missing'})])),/UNKNOWN_PROJECT/);
 assert.throws(()=>parseFieldLedgerBundle(bundle([record(),record({id:'replacement',projectId:'project-b',projectName:'시험 현장 B',supersedes:'record-1'})])),/CROSS_PROJECT/);
 const old=parseFieldLedgerBundle(bundle()),updated=bundle([record({revision:2})]);updated.sources[0]!.version=2;updated.sources[0]!.sha256='b'.repeat(64);
 assert.equal(mergeFieldLedgerBundles(old,updated).records[0]!.sourceVersions?.['source-1'],2);
 assert.throws(()=>mergeFieldLedgerBundles(old,{...updated,records:[]}),/STALE_SOURCE_VERSION/);
 for(const url of ['javascript:alert(1)','file:///private','//external.test/','/\\external.test/'])assert.throws(()=>parseFieldLedgerBundle({...bundle(),sources:[{...bundle().sources[0]!,url}]}),/INVALID_SOURCE_URL/);
});

test('field ledger transaction projection coalesces source representations and keeps stages separate',async()=>{
 const records=[record({id:'journal',origin:'journal'}),record({id:'event',origin:'event'}),record({id:'business',origin:'business'}),record({id:'payment',type:'입금',origin:'business'})];
 const snapshot=await createFieldLedgerSnapshot(bundle(records),{},at);
 assert.equal(snapshot.summary.recordCount,4);assert.equal(snapshot.summary.transactionCount,2);
 assert.deepEqual(fieldLedgerTransactions(records).map(r=>r.id),['business','payment']);
 const replaced=[record(),record({id:'new',supersedes:'record-1',previousIds:['record-1'],amountMinor:'15000'})];
 assert.deepEqual(fieldLedgerTransactions(replaced).map(r=>r.id),['new']);
 assert.throws(()=>parseFieldLedgerBundle(bundle([record({supersedes:'record-2'}),record({id:'record-2',supersedes:'record-1'})])),/SUPERSESSION_CYCLE/);
});

test('field ledger filters by project and business date, and hashes stable normalized input',async()=>{
 const a=record(),b=record({id:'record-2',projectId:'project-b',projectName:'시험 현장 B',occurredAt:null,receivedAt:'2026-01-06T01:00:00Z'});
 const data=bundle([b,a]);const snapshot=await createFieldLedgerSnapshot(data,{projectId:'project-a',from:'2026-01-03',to:'2026-01-03',search:'청구'},at);
 assert.deepEqual(snapshot.records.map(r=>r.id),['record-1']);assert.equal(snapshot.project?.name,'시험 현장 A');
 assert.equal(snapshot.id,(await createFieldLedgerSnapshot(bundle([a,b]),snapshot.query,at)).id);
 const midnight=bundle([record({occurredAt:null,receivedAt:'2026-01-03T16:00:00Z'})]);
 assert.equal((await createFieldLedgerSnapshot(midnight,{from:'2026-01-04',to:'2026-01-04'},at)).records.length,1);
 assert.equal(canonicalFieldLedger({b:2,a:1}),canonicalFieldLedger({a:1,b:2}));
 await assert.rejects(()=>createFieldLedgerSnapshot(data,{from:'2026-02-01',to:'2026-01-01'},at),/INVALID_DATE_RANGE/);
});

test('field ledger CSV and self-contained report share exact snapshot rows, escape cells and preserve evidence',async()=>{
 const text='=HYPERLINK("https://example.invalid")\r\n<script>alert(1)</script>, 다음';
 const snapshot=await createFieldLedgerSnapshot(bundle([record({request:text,party:' @SUM(1,2)',change:'규격 A → B',type:'변경',nextAction:'변경 내용 확인',amountMinor:null})]),{},at);
 const csv=fieldLedgerCsv(snapshot),html=fieldLedgerReportHtml(snapshot);
 assert(csv.startsWith('\uFEFF'));assert(csv.includes('"\'=HYPERLINK(""https://example.invalid"")'));
 assert(csv.includes('"\' @SUM(1,2)"'));assert(csv.includes('"미확인"'));assert(csv.includes(snapshot.id));assert(csv.includes('source-1:v1'));
 assert(html.includes(snapshot.id));assert(html.includes('규격 A → B'));assert(html.includes('sheet:1!A1'));
 assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert(!html.includes('<script>'));
 assert(!html.includes('src="http'));assert(html.includes('Content-Security-Policy'));
 assert(html.includes('업무일·접수일'));assert(html.includes('귀속 검토'));
});
