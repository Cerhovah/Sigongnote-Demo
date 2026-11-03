import assert from 'node:assert/strict';
import {test} from 'node:test';
import {partitionStrategy,proposeStrategy,predictStrategy,applyStrategyCalls,strategyScore,type StrategyDatum} from '../packages/domain/src/strategy-improvement.js';
import {EvidenceSearchSchema} from '../packages/domain/src/evidence-search-input.js';
const datum=(id:string):StrategyDatum=>({id,tenant:'t',project:'p',group:id,sourceHashes:[id],createdAt:'2026-10-04',instruction:'확인할 일을 보여줘',baseline:{tool:'search_evidence',query:'별칭'},expected:{tool:'search_evidence',query:'문틀'},relevant:[id]});
test('strategy training groups forbid source/work leakage and predictions never consume held-out labels',()=>{
 const a=datum('a'),b=datum('b');assert.throws(()=>partitionStrategy([a,{...b,sourceHashes:['a']}]),/INDEPENDENT_GROUPS/);assert.throws(()=>partitionStrategy([a,{...b,group:'a'}]),/INDEPENDENT_GROUPS/);
 assert.equal(partitionStrategy([a,b]).length,2);const spec=proposeStrategy('search',[a])!;
 assert.deepEqual(predictStrategy(b.instruction,b.baseline,spec),a.expected);
 assert.equal(proposeStrategy('search',[a,{...b,expected:{tool:'search_evidence',query:'다른 정답'}}]),null);
 assert.equal(strategyScore([b],[{value:a.expected,ids:['b']}],'search',[[]]).passed,true);
 assert.equal(strategyScore([b],[{value:a.expected,ids:['a']}],'search',[[]]).passed,false,'matching query alone is not correct retrieval');
 assert.equal(strategyScore([],[],'search',[]).passed,false);
});
test('strategy application preserves filters, skips effect tools and refuses lossy read-tool routing',()=>{
 const search=proposeStrategy('search',[datum('a')])!,input={query:'별칭',context_id:'c',project_id:'p',event_kinds:['receipt'],quantity:'100',versions:'history'};
 const calls=[{tool:'search_evidence',input:JSON.stringify(input)},{tool:'request_delivery',input:'{"query":"별칭"}'}];const changed=applyStrategyCalls('',calls,search);
 assert.deepEqual(JSON.parse(changed[0]!.input),{...input,query:'문틀'});assert.deepEqual(changed[1],calls[1]);
 const routing=proposeStrategy('tool_selection',[{...datum('a'),expected:{tool:'list_exceptions',query:''}}])!;
 assert.equal(applyStrategyCalls('확인할 일을 보여줘',[{tool:'search_evidence',input:'{"query":"별칭"}'}],routing)[0]!.tool,'list_exceptions');
 const defaults=EvidenceSearchSchema.parse({query:'별칭'});
 assert.equal(applyStrategyCalls('확인할 일을 보여줘',[{tool:'search_evidence',input:JSON.stringify(defaults)}],routing)[0]!.tool,'list_exceptions','schema defaults remain routable');
 for(const extra of [{versions:'history'},{event_kinds:['receipt']},{asserted_only:false},{limit:5}]){
  const call={tool:'search_evidence',input:JSON.stringify({...defaults,...extra})};assert.deepEqual(applyStrategyCalls('확인할 일을 보여줘',[call],routing),[call]);
 }
 for(const input of [{query:'별칭',context_id:'c'},{query:'별칭',project_id:'foreign'},{id:'artifact'},{query:'별칭',limit:5}])assert.deepEqual(applyStrategyCalls('확인할 일을 보여줘',[{tool:'search_evidence',input:JSON.stringify(input)}],routing,'p'),[{tool:'search_evidence',input:JSON.stringify(input)}]);
 assert.deepEqual(applyStrategyCalls('확인할 일을 보여줘',calls,routing),calls);
});
