import {test} from 'node:test';import assert from 'node:assert/strict';
import {evaluationEqual,partitionLearning,proposeImprovement,interpretImprovement,scoreImprovement,withinImprovementScope,type LearningDatum} from '../packages/domain/src/improvement.js';
const datum=(id:string,group=id):LearningDatum=>({id,version:1,tenant:'one',project:'site-'+group,group,period:'2026-10',sourceHashes:[id],sourceText:'조치: 문틀 재설치. 임시 방문 대신 문틀 재설치로 합의.',proposal:[{kind:'quality',action:'임시 방문'}],expected:[{kind:'quality',action:'문틀 재설치'}],state:'correction',createdAt:'2026-10-04T00:00:00Z'});
const criteria={version:'work-eval-v1' as const,min_test_groups:1,min_shadow_groups:1,max_errors:0 as const,max_protected_changes:0 as const,max_high_confidence_errors:0 as const,min_improvement:1};
test('evaluation preserves nested array order, unknown values and exact money despite object key order',()=>{
 const before={effects:[{amount:'99999999999999999999',detail:{unit:'piece',quantity:null}},{amount:'0'}]};
 const reordered={effects:[{detail:{quantity:null,unit:'piece'},amount:'99999999999999999999'},{amount:'0'}]};
 const snapshot=JSON.stringify(before);
 assert.equal(evaluationEqual(before,reordered),true);
 assert.equal(evaluationEqual(before,{effects:[...reordered.effects].reverse()}),false);
 assert.equal(evaluationEqual(before,{effects:[{amount:'99999999999999999998',detail:{unit:'piece',quantity:null}},{amount:'0'}]}),false);
 assert.equal(evaluationEqual({quantity:null},{quantity:'0'}),false);
 assert.equal(JSON.stringify(before),snapshot);
});
test('N28 business/source union prevents train-test leakage across sites and periods',()=>{
 const data=[datum('a'),{...datum('b','a'),period:'2027-01'},datum('c'),{...datum('d'),sourceHashes:['c']},datum('e')];const split=partitionLearning(data);
 assert.equal(split[0]?.split,split.find(x=>x.id==='b')?.split);assert.equal(split.find(x=>x.id==='c')?.split,split.find(x=>x.id==='d')?.split);assert.ok(split.some(x=>x.split==='test')&&split.some(x=>x.split==='train'));
 assert.throws(()=>partitionLearning([datum('a'),datum('b','a')]),/INDEPENDENT_GROUPS/);assert.throws(()=>partitionLearning([datum('a'),{...datum('b'),tenant:'other'}]),/DATASET_SCOPE/);
});
test('N28 train-only evidence rules improve held-out cases without inventing policy or monetary effects',()=>{
 const spec=proposeImprovement([datum('train')]);assert.equal(spec.rules.length,1);const held=datum('test'),prediction=interpretImprovement(held,spec);assert.equal(scoreImprovement([held],[prediction],criteria).passed,true);
 const noSource={...held,sourceText:'새 현장에는 다른 조치만 적힘'};assert.deepEqual(interpretImprovement(noSource,spec).effects,noSource.proposal);
 assert.equal(proposeImprovement([{...datum('train'),sourceText:'새 정책 근거 없음'}]).rules.length,0);
 const money={sourceText:'100원',proposal:[{kind:'charge_adjustment' as const,charge_id:'11111111-1111-4111-8111-111111111111',version:1,amount_minor:'100',liability:'company' as const,reason:'change' as const}]};
 assert.equal(withinImprovementScope(money,{effects:[{...money.proposal[0]!,amount_minor:'200'}],confidence:1}),false);
 assert.equal(scoreImprovement([],[],criteria).passed,false,'zero samples is not zero errors');
 const failed=scoreImprovement([held],[{effects:held.proposal,confidence:1}],criteria);assert.deepEqual(failed.high_confidence_errors,['test']);assert.equal(failed.passed,false);
});
