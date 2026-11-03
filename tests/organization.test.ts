import assert from "node:assert/strict";
import {test} from "node:test";
import {organizeEvidence,type OrganizationInput} from "../packages/domain/src/organization.js";
const input:OrganizationInput={tenantId:"company",revisionId:"rev",spans:[],projects:[{id:"one",display_name:"햇살현장"},{id:"two",display_name:"별빛현장"}],bindings:[{project_id:"one",scope_mode:"project"}],bundles:[]};
const run=(lines:string[],overrides:Partial<OrganizationInput>={})=>organizeEvidence({...input,...overrides,spans:lines.map((text,i)=>({text,locator:`line:${i+1}`}))});
test("D08 categories preserve assertion and folder conflicts without inventing transactions",()=>{
 const r=run(["햇살현장 납품","작업: 주방 시공","발주 예정","도면 규격 12mm","청구 100원 미확인","하자 조치해주세요"]);
 assert.equal(r.project_id,"one");assert.equal(r.work_label,"주방 시공");assert.equal(r.categories.length,5);assert.equal(r.facts[2]?.assertion_kind,"plan");assert.equal(r.facts[4]?.assertion_kind,"observation");
 const conflict=run(["별빛현장 납품"]);assert.equal(conflict.state,"conflict");assert.equal(conflict.project_id,null);
 assert.equal(run(["햇살현장 규격"],{bindings:[{project_id:null,scope_mode:"company_common"}]}).state,"common");
 assert.equal(run(["숫자 12"]).work_label,null);assert.deepEqual(run(["알 수 없는 자료"]).categories,[]);
 assert.equal(run(["발주 25개면 되나?"]).facts[0]?.assertion_kind,"proposal");
 assert.equal(run(["납품하면 지급"]).facts[0]?.assertion_kind,"condition");
 assert.equal(run(["작업: a "]).work_label,null);
 assert.equal(run(["납품하지 않으면 지급하지 않음"]).facts[0]?.assertion_kind,"condition");
 assert.equal(run(["금액은 모릅니다"]).facts[0]?.value.kind,"text");
});

import {isUnsupportedAction,searchTerms} from "../services/api/src/conversations.js";
test("D09 finds existing documents described with creation or sending verbs",()=>{
 for(const text of ["업체가 보내준 견적서 찾아줘","지난번 만든 발주서 찾아줘","작성된 명세서 찾아줘","공유받은 도면 찾아줘","지급해준 내역 찾아줘"]){
  assert.equal(isUnsupportedAction(text),false);assert.equal(searchTerms(text,[]).length,1);
 }
 assert.equal(isUnsupportedAction("견적서 만들어줘"),true);
});
