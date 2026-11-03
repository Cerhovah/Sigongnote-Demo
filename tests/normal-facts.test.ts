import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {normalFactEligibility,relatedNormalFacts,type OperationalFact} from '../services/api/src/normal-facts.js';
import {semanticWorkSignals} from '../services/api/src/semantic-issues.js';
const item=randomUUID();
const fact=(quantity='28',transaction='delivery-1'):OperationalFact=>({id:randomUUID(),revision:randomUUID(),version:'a'.repeat(64),transaction_key:transaction,organization_version:1,context_id:randomUUID(),project_id:randomUUID(),semantic:{eventKind:'receipt',assertionStatus:'asserted',quantity:{value:quantity,unitCode:'ea'},subject:{kind:'item_instance',mention:'합성 납품물'},entityCoverage:'complete',entityLinks:[{mentionId:'item_instance:합성 납품물',status:'linked',targetId:item}]}});
const qualification={evaluation_id:randomUUID(),approved_by:randomUUID(),approved_at:'2026-10-03T00:00:00Z',event_kinds:['receipt','acceptance','dispatch'],effect_kinds:['acceptance','charge_adjustment']};
test('N11 partial receipts deduplicate proven copies and preserve unknown/dispatch/type boundaries',()=>{
 const effect={kind:'acceptance' as const,quantity:'30',ordered:'30',unit:'개'},one=fact(),copy={...one,id:randomUUID()},two=fact('2','delivery-2'),order=fact('30','order-1');
 order.semantic={...order.semantic,eventKind:'acceptance',evidence:[{quote:'발주 30개 합의'}]};
 assert.equal(normalFactEligibility([effect],[order,one,copy,two],qualification).state,'auto_apply');
 assert.equal(normalFactEligibility([effect],[order,one],qualification).reason,'receipt_total_changed');
 assert.equal(normalFactEligibility([effect],[order,one,two],null).reason,'type_not_qualified');
 const mutations=[{v:{eventKind:'dispatch'},reason:'receipt_total_changed'},{v:{assertionStatus:'unasserted'},reason:'fact_not_qualified'},{v:{quantity:null},reason:'receipt_not_proven'},{v:{subject:{kind:'item_type',mention:'합성 납품물'}},reason:'item_identity_not_unique'}];
 for(const {v,reason} of mutations)assert.equal(normalFactEligibility([effect],[order,{...one,semantic:{...one.semantic,...v}},two],qualification).reason,reason);
 assert.equal(normalFactEligibility([effect],[order,{...one,transaction_key:null},two],qualification).reason,'fact_not_qualified');
 assert.equal(normalFactEligibility([effect],[order,one,fact('29'),two],qualification).reason,'receipt_conflict');
 assert.equal(normalFactEligibility([effect],[one,two],qualification).reason,'order_not_proven');
 assert.equal(normalFactEligibility([{...effect,quantity:'bad'}],[order,one,two],qualification).reason,'invalid_effect');
 const basis=[order,one,two],cancel={...one,id:randomUUID(),semantic:{...one.semantic,eventKind:'cancellation'}};
 assert.equal(relatedNormalFacts(basis,[...basis,cancel]).length,4);
 assert.equal(normalFactEligibility([effect],relatedNormalFacts(basis,[...basis,cancel]),qualification).reason,'fact_not_qualified');
 const correction={...cancel,transaction_key:null,semantic:{...cancel.semantic,eventKind:'correction'}};
 assert.equal(normalFactEligibility([effect],relatedNormalFacts(basis,[...basis,correction]),qualification).reason,'fact_not_qualified');
});
test('N11 monetary effects require known agreed amount; model request and unknown never become zero or approval',()=>{
 const effect={kind:'charge_adjustment' as const,charge_id:randomUUID(),version:1,amount_minor:'50000',liability:'company' as const,reason:'change' as const},one=fact();
 one.semantic={...one.semantic,eventKind:'acceptance',amount:{minor:'50000',currency:'KRW',knowledge:'known'}};
 assert.equal(normalFactEligibility([effect],[one],qualification).state,'auto_apply');
 for(const v of [{eventKind:'request'},{amount:{minor:null,currency:'KRW',knowledge:'unknown'}},{amount:{minor:'50001',currency:'KRW',knowledge:'known'}}])assert.equal(normalFactEligibility([effect],[{...one,semantic:{...one.semantic,...v}}],qualification).state,'candidate_only');
});

test('N11 liability labels cannot match inside another party name or select one of conflicting parties',()=>{
 const q={...qualification,effect_kinds:['liability']};
 const evidence=(quote:string)=>{const f=fact();f.semantic={...f.semantic,eventKind:'acceptance',evidence:[{quote}]};return f;};
 for(const [party,label] of [['company','회사'],['customer','고객'],['supplier','공급처']] as const){
  const effect={kind:'liability' as const,party};
  assert.equal(normalFactEligibility([effect],[evidence(`${label} 부담으로 합의`)],q).state,'auto_apply');
  assert.equal(normalFactEligibility([effect],[evidence(`합의: ${label} 부담`)],q).state,'auto_apply');
  assert.equal(normalFactEligibility([effect],[evidence(`원청${label} 부담으로 합의`)],q).reason,'liability_agreement_not_proven');
 }
 const effect={kind:'liability' as const,party:'company' as const};
 assert.equal(normalFactEligibility([effect],[evidence('회사 부담, 고객 부담을 함께 합의')],q).reason,'liability_party_conflict');
 assert.equal(normalFactEligibility([effect],[evidence('회사 부담 합의'),evidence('공급처 부담 합의')],q).state,'needs_answer');
 assert.equal(normalFactEligibility([effect],[evidence('고객 부담 합의')],q).state,'candidate_only');
 const change=evidence('변경 추가비 50000원 원청회사 부담으로 합의');change.semantic.amount={knowledge:'known',minor:'50000',currency:'KRW'};
 assert.deepEqual(semanticWorkSignals([change],'2026-10-04'),[],'question must not suggest our company either');
 change.semantic.evidence=[{quote:'변경 추가비 50000원 고객 부담으로 합의'}];
 assert.deepEqual(semanticWorkSignals([change],'2026-10-04')[0]?.effects,[{kind:'liability',party:'customer'}]);
});
