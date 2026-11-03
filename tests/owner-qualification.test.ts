import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {policyCondition} from '../services/api/src/owner-qualification.js';
test('N13 typed policy conditions ignore source wording but retain subject, quantity, amount and legacy boundaries',()=>{
 const base={category:'material',prompt:'원래 표현',proposal:{semantic_basis:[{id:randomUUID()}],semantic_subject:randomUUID(),effects:[{kind:'acceptance' as const,quantity:'28',ordered:'30',unit:'개'}]}};
 assert.equal(policyCondition(base),policyCondition({...base,prompt:'새로운 표현'}));
 assert.notEqual(policyCondition(base),policyCondition({...base,proposal:{...base.proposal,semantic_subject:randomUUID()}}));
 assert.notEqual(policyCondition(base),policyCondition({...base,proposal:{...base.proposal,effects:[{...base.proposal.effects[0]!,quantity:'29'}]}}));
 const legacy={category:'material',prompt:'기존 질문',proposal:{effects:base.proposal.effects}};assert.notEqual(policyCondition(legacy),policyCondition({...legacy,prompt:'다른 질문'}));assert.notEqual(policyCondition(base),policyCondition(legacy));
 const money={category:'change',prompt:'변경',proposal:{...base.proposal,effects:[{kind:'charge_adjustment' as const,charge_id:randomUUID(),version:1,amount_minor:'50000',liability:'company' as const,reason:'change' as const}]}};
 assert.equal(policyCondition(money),policyCondition({...money,proposal:{...money.proposal,effects:[{...money.proposal.effects[0]!,charge_id:randomUUID(),version:2}]}}));
 assert.notEqual(policyCondition(money),policyCondition({...money,proposal:{...money.proposal,effects:[{...money.proposal.effects[0]!,amount_minor:'50001'}]}}));
});
