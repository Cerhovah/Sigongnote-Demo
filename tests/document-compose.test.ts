import assert from 'node:assert/strict';
import {test} from 'node:test';
import {composeDocumentEvidence,type DocumentFact} from '../packages/domain/src/document-compose.js';
import {calculateDocument} from '../packages/domain/src/document-draft.js';
import type {DraftSource} from '../packages/domain/src/document-source.js';
const source=(id:string,text:string):DraftSource=>({id,sha256:'a'.repeat(64),created_at:'2030-01-01',partial:false,spans:text.split('\n').map((text,i)=>({text,locator:'line:'+i}))});
const quote=source('quote','견적서\n부가세:별도 10%\n마진:80%\n받는 곳:합성업체\n현장조건:실내\n운반비:포함\n단가 기준일:2030-01-01\n품명 | 규격 | 수량 | 단위 | 매입단가 | 단가\n창틀 | 표준 | 30 | 개 | 100 | 125');
const prices=source('prices','매입 단가표\n부가세:별도 10%\n현장조건:실내\n단가 기준일:2030-01-02\n품명 | 규격 | 단위 | 단가\n창틀 | 표준 | 개 | 120');
const fact=(value='35',name='창틀'):DocumentFact=>({id:'change',revision:'sms',version:'a'.repeat(64),semantic:{subject:{kind:'item_type',mention:name},eventKind:'acceptance',assertionStatus:'asserted',entityCoverage:'complete',quantity:{value,unitCode:'ea'},entityLinks:[{mentionId:'item_type:'+name,status:'linked',targetId:name}],observedAt:'2030-01-03T00:00:00Z',evidence:[{quote:`${name} 최종 ${value}개 합의`,locator:'line:0'}]}});
test('new ordinary contact uses validated semantic/event candidates while raw prose and conflicting quantities stay unresolved',()=>{
 const contact=source('sms','문틀 100개 견적 부탁드립니다.'),validated=fact('100','문틀');validated.semantic.eventKind='request';
 assert.equal(composeDocumentEvidence('estimate',[contact],[],'2030-01-04').lines.length,0,'raw prose is never interpreted by a replacement regular expression');
 const fromFact=composeDocumentEvidence('estimate',[contact],[validated],'2030-01-04');assert.equal(fromFact.lines[0]?.description,'문틀');assert.equal(fromFact.lines[0]?.quantity,'100');assert.equal(fromFact.lines[0]?.purchaseRate,null);
 const observation={id:'event',revision:'sms',description:'문틀',quantity:'100',unit:'개'};assert.equal(composeDocumentEvidence('estimate',[contact],[],'2030-01-04',[observation]).lines[0]?.quantity,'100');
 const conflict=composeDocumentEvidence('estimate',[contact],[],'2030-01-04',[observation,{...observation,id:'other',quantity:'200'}]);assert.equal(conflict.lines.length,0);assert.ok(conflict.issues.some(i=>i.includes('서로 다른 요청 수량')));
 assert.equal(composeDocumentEvidence('estimate',[contact],[],'2030-01-04',[{...observation,revision:'other-company'}]).lines.length,0);
 assert.equal(composeDocumentEvidence('invoice',[contact],[],'2030-01-04',[observation]).lines.length,0,'request quantities are never treated as received or billable');
});
test('N15 ordinary quote + current supplier price + change use 35 rather than 65 with explicit owner margin',()=>{
 const r=composeDocumentEvidence('estimate',[quote,prices],[fact()],'2030-01-04');assert.deepEqual(r.issues,[]);assert.equal(r.lines[0]!.quantity,'35');assert.equal(r.lines[0]!.purchaseRate,'120');assert.equal(r.policy.marginBps,null,'source margin cannot set owner business policy');
 assert.deepEqual(new Set(r.references),new Set(['quote','prices','sms']));assert.equal(calculateDocument('estimate',r.lines,{...r.policy,marginBps:2000}).totals.total,'5775');
 const newItem=composeDocumentEvidence('estimate',[quote],[fact('2','문짝')],'2030-01-04');assert.equal(newItem.lines[1]!.quantity,'2');assert.equal(newItem.lines[1]!.purchaseRate,null);assert.equal(calculateDocument('estimate',newItem.lines,{...newItem.policy,marginBps:2000}).totals.total,null);
});
test('N15 ambiguous chronology/unit/cancellation/prices/coverage cannot silently finalize',()=>{
 assert.ok(composeDocumentEvidence('estimate',[quote,prices,{...prices,id:'price2'}],[],'2030-01-04').issues.some(x=>x.includes('충돌')));
 assert.ok(composeDocumentEvidence('estimate',[quote],[fact(),fact('40')],'2030-01-04').issues.some(x=>x.includes('순서')));
 const bad=fact();bad.semantic.quantity.unitCode='kg';assert.ok(composeDocumentEvidence('estimate',[quote],[bad],'2030-01-04').issues.some(x=>x.includes('단위')));
 bad.semantic.eventKind='cancellation';assert.ok(composeDocumentEvidence('estimate',[quote],[bad],'2030-01-04').issues.some(x=>x.includes('취소')));
 const old=composeDocumentEvidence('estimate',[quote,prices],[],'2031-01-04');assert.equal(old.lines[0]!.rateCurrent,false);
 const foreignCondition={...prices,spans:prices.spans.map(s=>({...s,text:s.text.replace('현장조건:실내','현장조건:옥외')}))};assert.ok(composeDocumentEvidence('estimate',[quote,foreignCondition],[],'2030-01-04').issues.some(x=>x.includes('조건')));
 assert.ok(composeDocumentEvidence('estimate',[{...quote,partial:true}],[],'2030-01-04').issues.length);
 const conditional=fact();conditional.semantic.assertionStatus='unasserted';assert.equal(composeDocumentEvidence('estimate',[quote],[conditional],'2030-01-04').lines[0]!.quantity,'30');
});

test('N15 reviewed quantity ambiguity and rate freshness remain explicit',()=>{
 const implied=fact();implied.semantic.evidence[0].quote='창틀 35개 하기로 했어요';
 assert.ok(composeDocumentEvidence('estimate',[quote],[implied],'2030-01-04').issues.some(x=>x.includes('전체 수량')));
 implied.semantic.quantity.value='30';assert.deepEqual(composeDocumentEvidence('estimate',[quote],[implied],'2030-01-04').issues,[]);
 const extra=fact('5');extra.semantic.evidence[0].quote='창틀 추가 5개';assert.ok(composeDocumentEvidence('estimate',[quote],[fact(),extra],'2030-01-04').issues.length);
 const noDate={...quote,spans:quote.spans.filter(p=>!p.text.startsWith('단가 기준일'))};
 const alias={...prices,spans:prices.spans.map(p=>({...p,text:p.text.replace('품명','품목')}))};
 assert.equal(composeDocumentEvidence('estimate',[noDate,alias],[],'2030-01-04').lines[0]!.rateCurrent,true);
 const old={...prices,spans:prices.spans.map(p=>({...p,text:p.text.replace('2030-01-02','2029-01-01')}))};
 assert.equal(composeDocumentEvidence('estimate',[quote,old],[],'2030-01-04').lines[0]!.rateCurrent,false);
 assert.ok(composeDocumentEvidence('estimate',[{...quote,spans:quote.spans.map(p=>({...p,text:p.text.replace('운반비:포함','운반비:별도')}))}],[],'2030-01-04').issues.includes('운반비 포함 범위'));
});

test('N16 shared quote supplies orders and actual transaction receipts supply invoices/statements',()=>{
 const order=composeDocumentEvidence('purchase_order',[quote],[],'2030-01-04');assert.equal(order.lines[0]!.quantity,'30');assert.equal(order.recipient,null,'customer recipient is not supplier');
 const r=fact('8');r.semantic.eventKind='receipt';r.transaction_key='delivery-1';r.semantic.subject.kind='item_instance';r.semantic.entityLinks[0].mentionId='item_instance:창틀';
 for(const type of ['invoice','delivery_statement'] as const){
  const drafted=composeDocumentEvidence(type,[quote],[r,{...r,id:'duplicate'}],'2030-01-04');assert.deepEqual(drafted.issues,[]);assert.equal(drafted.lines[0]!.quantity,'8');assert.equal(calculateDocument(type,drafted.lines,drafted.policy).totals.total,'1100');
  const reduced=fact('5');assert.ok(composeDocumentEvidence(type,[quote],[r,reduced],'2030-01-04').issues.some(x=>x.includes('넘은 인수')));
  assert.equal(composeDocumentEvidence(type,[quote],[],'2030-01-04').lines.length,0,'planned quote is not delivered');
  const conflict=structuredClone(r);conflict.semantic.quantity.value='9';assert.ok(composeDocumentEvidence(type,[quote],[r,conflict],'2030-01-04').issues.length);
  assert.ok(composeDocumentEvidence(type,[quote],[{...r,transaction_key:null}],'2030-01-04').issues.length);
  const cancelled=structuredClone(r);cancelled.semantic.eventKind='cancellation';assert.ok(composeDocumentEvidence(type,[quote],[r,cancelled],'2030-01-04').issues.length);
 }
});
