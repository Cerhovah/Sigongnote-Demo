import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reduceBusinessEvents,stableBusinessEventKey,type BusinessEvent} from '../packages/domain/src/business-events.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={tenantId:id(1),contextId:id(2)};
function event(n:number,patch:Partial<BusinessEvent>={}):BusinessEvent{return {id:id(n),...scope,sequence:n,kind:'receipt',subject:'board',transactionKey:'delivery-'+n,quantity:{value:'10',unitCode:'piece'},amount:null,mode:'observed',asserted:true,existingEffect:null,evidenceIds:['source-'+n],evidenceWithdrawn:false,effectiveAt:'2026-10-01T00:00:00Z',recordedAt:'2026-10-03T00:00:00Z',supersedes:null,reverses:null,...patch};}
const replay=(...events:BusinessEvent[])=>reduceBusinessEvents(events,scope);
test('persisted business event identity survives canonical helper extraction',()=>{
 assert.equal(stableBusinessEventKey(event(10)),'030a9c68fe53fb21cbf8c0febfdc444aabcc22dcc52021b4428e6fe2838661f2');
 const original=event(10),reordered={...original,quantity:{unitCode:'piece',value:'10'}};
 assert.equal(stableBusinessEventKey(reordered),stableBusinessEventKey(original));
});
test('identified XLSX/PDF copies count once; distinct deliveries sum exact decimal strings',()=>{
 const a=event(10,{quantity:{value:'0.1',unitCode:'piece'}}),b=event(11,{transactionKey:a.transactionKey,quantity:{value:'0.100000',unitCode:'piece'}}),c=event(12,{quantity:{value:'0.2',unitCode:'piece'}});
 assert.equal(stableBusinessEventKey(a),stableBusinessEventKey(b));assert.equal(replay(a,b,c).observed_state.receipt[0]!.quantity,'0.3');
 assert.equal(replay(a,b,c).coverage.duplicateCount,1);
});
test('ambiguous identity, unasserted and unknown quantities never become zero or approved effects',()=>{
 const r=replay(event(10,{transactionKey:null}),event(11,{kind:'ordered',asserted:false}),event(12,{kind:'payment',quantity:null,amount:{minor:null,knowledge:'unknown',currency:'KRW'}}));
 assert.equal(r.observed_state.receipt[0]!.quantity,null);assert.equal(r.observed_state.payment[0]!.quantity,null);assert.deepEqual(r.observed_state.ordered,[]);
 assert.equal(r.coverage.unassertedCount,1);assert.equal(r.coverage.ambiguousIdentityCount,1);
});
test('same ID replay is idempotent and immutable; tenant/context mismatches fail',()=>{
 const e=event(10);assert.equal(replay(e,e).coverage.auditCount,1);assert.equal(replay(e,e).observed_state.receipt[0]!.quantity,'10');
 assert.throws(()=>replay(e,{...e,subject:'other'}),/EVENT_ID_CONFLICT/);
 assert.throws(()=>replay(event(11,{tenantId:id(3)})),/EVENT_SCOPE_MISMATCH/);assert.throws(()=>replay(event(11,{contextId:id(3)})),/EVENT_SCOPE_MISMATCH/);
});
test('correction and explicit reversal replay deterministically through late effective facts',()=>{
 const a=event(10),b=event(11,{kind:'correction',supersedes:a.id,quantity:{value:'8',unitCode:'piece'},effectiveAt:'2026-09-30T00:00:00Z'}),c=event(12,{quantity:{value:'2',unitCode:'piece'}});
 const before=JSON.stringify([a,b,c]);assert.deepEqual(replay(c,a,b),replay(b,c,a));assert.equal(replay(c,a,b).observed_state.receipt[0]!.quantity,'10');assert.equal(JSON.stringify([a,b,c]),before);
 const cancel=event(13,{kind:'cancellation',reverses:b.id,quantity:null});assert.equal(replay(a,b,c,cancel).observed_state.receipt[0]!.quantity,'2');assert.equal(replay(a,b,c,cancel).watermark,13);
});
test('fork corrections, missing references, cycles and conflicting transaction copies stay uncertain',()=>{
 const a=event(10),b=event(11,{kind:'correction',supersedes:a.id}),c=event(12,{kind:'correction',supersedes:a.id,quantity:{value:'8',unitCode:'piece'}});
 assert.equal(replay(a,b,c).observed_state.receipt[0]!.quantity,null);assert.ok(replay(a,b,c).coverage.conflictCount>0);
 assert.ok(replay(event(14,{kind:'correction',supersedes:id(99)})).coverage.conflictCount>0);
 assert.ok(replay(event(15,{kind:'correction',supersedes:id(16)}),event(16,{kind:'correction',supersedes:id(15)})).coverage.conflictCount>0);
 assert.equal(replay(a,event(17,{transactionKey:a.transactionKey,quantity:{value:'12',unitCode:'piece'}})).observed_state.receipt[0]!.quantity,null);
});
test('withdrawal excludes observed effects and preserves audit; duplicate live evidence remains usable',()=>{
 const a=event(10),b=event(11,{transactionKey:a.transactionKey,evidenceWithdrawn:true});assert.equal(replay(a,b).observed_state.receipt[0]!.quantity,'10');assert.equal(replay(a,b).coverage.withdrawnCount,1);
 assert.deepEqual(replay({...a,evidenceWithdrawn:true}).observed_state.receipt,[]);
 const correction=event(12,{kind:'correction',supersedes:a.id,evidenceWithdrawn:true});assert.deepEqual(replay(a,correction).observed_state.receipt,[]);assert.equal(replay(a,correction).coverage.auditCount,2);
 const masked={...correction,quantity:null,amount:null,evidenceIds:[]};assert.deepEqual(replay(a,masked).observed_state,replay(a,correction).observed_state);
 assert.ok(replay(a,masked).coverage.conflictCount>0);
});
test('imported applied pointers never reapply or add observed money; categories and units stay separate',()=>{
 const applied=event(10,{mode:'applied',existingEffect:{kind:'charge_adjustment',id:id(30)}});const r=replay(applied,event(11,{kind:'dispatch'}),event(12,{kind:'ordered'}),event(13,{quantity:{value:'1',unitCode:'box'}}));
 assert.equal(r.coverage.appliedCount,1);assert.equal(r.observed_state.receipt.length,1);assert.equal(r.observed_state.dispatch[0]!.quantity,'10');assert.equal(r.observed_state.ordered[0]!.quantity,'10');
 assert.throws(()=>replay(event(14,{mode:'applied'})),/INVALID_EVENT_AUTHORITY/);
 const units=replay(event(15),event(16,{transactionKey:'delivery-15',quantity:{value:'2',unitCode:'box'}}));
 assert.deepEqual(units.observed_state.receipt.map(r=>[r.unitCode,r.quantity]),[['box','2'],['piece','10']]);
});
