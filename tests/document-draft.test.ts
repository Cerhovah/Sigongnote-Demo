import {partialDocument} from "../packages/domain/src/document-issue.js";
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {calculateDocument,remainingBillable,remainingQuantity,reusableOutcome,type DraftLine} from '../packages/domain/src/document-draft.js';
import {documentIntent,readDocumentSource} from '../packages/domain/src/document-source.js';
const line:DraftLine={id:'one',description:'보수 작업',spec:'',unit:'식',quantity:'1',purchaseRate:'1000000',salesRate:'1250000',ordered:'0',sourceRevision:'source',locator:'line:1',rateCurrent:true};
test('D14 margin, explicit VAT, residuals, unknowns and order/billing net are exact',()=>{
 assert.equal(calculateDocument('estimate',[{...line,quantity:'0.0'}],{marginBps:2000,taxBps:1000,taxMode:'exclusive'}).state,'needs_inputs');
 const result=calculateDocument('estimate',[line],{marginBps:2000,taxBps:1000,taxMode:'exclusive'});
 assert.deepEqual(result.totals,{supply:'1250000',tax:'125000',total:'1375000'});
 assert.equal(calculateDocument('estimate',[{...line,purchaseRate:'70000'}],{marginBps:3000,taxBps:0,taxMode:'not_applicable'}).totals.supply,'100000');
 const split=calculateDocument('estimate',[{...line,id:'a',purchaseRate:'1'},{...line,id:'b',purchaseRate:'1'},{...line,id:'c',purchaseRate:'1'}],{marginBps:3000,taxBps:1000,taxMode:'exclusive'});
 assert.equal(split.lines.reduce((s,l)=>s+BigInt(l.supply!),0n).toString(),split.totals.supply);
 assert.equal(split.lines.reduce((s,l)=>s+BigInt(l.tax!),0n).toString(),split.totals.tax);
 assert.equal(calculateDocument('estimate',[line],{marginBps:2000,taxBps:null,taxMode:'unknown'}).totals.total,null);
 assert.equal(calculateDocument('purchase_order',[{...line,quantity:'4',ordered:'1.5'}],{marginBps:9000,taxBps:1000,taxMode:'exclusive'}).totals.supply,'2500000');
 assert.equal(remainingQuantity('2.5','1.25'),'1.25');assert.throws(()=>remainingQuantity('1','2'),/OVER_ORDERED/);
 assert.equal(remainingBillable('100000','30000','20000'),'50000');assert.throws(()=>remainingBillable('100','90','20'),/OVER_BILLED/);
 const source={quantity:'2',actualCost:'100000',unknownCosts:0,completed:true,ownerLabor:true,observedOn:'2026-09-01',asOf:'2026-09-30',conditions:['실내'],targetConditions:['실내'],current:true};
 assert.equal(reusableOutcome(source),true);assert.equal(reusableOutcome({...source,current:false}),false);assert.equal(reusableOutcome({...source,targetConditions:[]}),false);assert.equal(reusableOutcome({...source,asOf:'2027-01-01'}),false);
});
test('D14 source parsing keeps ambiguous/missing values unresolved and search does not create',()=>{
 assert.equal(documentIntent('업체가 보내준 견적서 찾아줘'),null);assert.equal(documentIntent('견적서 준비해줘'),'estimate');assert.equal(documentIntent('견적서와 발주서 작성해줘'),null);
 const source={id:'a',sha256:'a'.repeat(64),created_at:'2026-09-30',partial:false,spans:['견적 준비','마진:20%','부가세:별도 10%','받는 곳:합성업체','품명 | 규격 | 수량 | 단위 | 매입단가','보수 | 창틀 | 2.5 | 개 | 미정'].map((text,i)=>({text,locator:`line:${i}`}))};
 const result=readDocumentSource('estimate',[source]);assert.equal(result.lines[0]?.purchaseRate,null);assert.equal(result.policy.marginBps,2000);assert.equal(result.lines[0]?.quantity,'2.5');
 assert.equal(readDocumentSource('estimate',[source,{...source,id:'b'}]).selected,null);
 const sheets={...source,spans:[{text:'견적 준비',locator:'sheet:0/cell:A1'},...['품명','수량','단위','매입단가'].map((text,i)=>({text,locator:`sheet:0/cell:${String.fromCharCode(65+i)}2`})),...['창틀','2','개','70000'].map((text,i)=>({text,locator:`sheet:0/cell:${String.fromCharCode(65+i)}3`}))]};
 assert.equal(readDocumentSource('estimate',[sheets]).lines[0]?.purchaseRate,'70000');
 assert.ok(readDocumentSource('estimate',[{...source,spans:[...source.spans,{text:'마진:30%',locator:'line:99'}]}]).issues.includes('마진의 서로 다른 조건'));
});

test('D15 no-tax partial/full preserve unknown-vs-zero and exact amount',()=>{
 const snapshot={lines:[{id:'a',supply:'100000',tax:null,quantity:'1',unit_price:'100000'}],totals:{supply:'100000',tax:null,total:'100000'}};
 assert.equal(partialDocument(snapshot,undefined,'not_applicable').totals.total,'100000');
 assert.deepEqual(partialDocument(snapshot,'30000','not_applicable').totals,{supply:'30000',tax:'0',total:'30000'});
 assert.throws(()=>partialDocument(snapshot,'30000','exclusive'),/UNKNOWN_ISSUE_AMOUNT/);
});
