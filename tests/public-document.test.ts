import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PublicDocumentSchema} from '../services/api/src/public-document.js';
import {localArtifactPlan} from '../services/api/src/agent-artifacts.js';
import {WorkRequestSchema} from '../packages/contracts/src/schemas.js';
const sample=()=>({document_number:'Q-0000001',revision:1,template_version:'kr-basic-v1',issuer:{name:'합성 시공업체'},recipient:{name:'합성 의뢰업체'},project:{id:'fixture',name:'합성현장'},date:'2030-01-01',type:'estimate',state:'approved',missing:[],lines:[{id:'1',description:'창틀',spec:'표준',unit:'개',quantity:'1',unit_price:'100',supply:'100',tax:'10'}],totals:{supply:'100',tax:'10',total:'110'},terms:[],disclosure_scope:'recipient',basis_hash:'a'.repeat(64),calculation_version:'document-draft-v1'});
test('N17 recipient boundary rejects internal nested fields and exact-total mismatches before render',()=>{
 assert.ok(PublicDocumentSchema.safeParse(sample()).success);
 for(const mutate of [(d:any)=>{d.margin_bps=2000;},(d:any)=>{d.totals.internal_cost='secret';},(d:any)=>{d.issuer.account='secret';},(d:any)=>{d.lines[0].purchaseRate='secret';},(d:any)=>{d.totals.total='111';},(d:any)=>{d.totals.supply='99';d.totals.total='109';},(d:any)=>{d.state='needs_inputs';}]){const d=sample();mutate(d);assert.equal(PublicDocumentSchema.safeParse(d).success,false);}
 assert.equal(localArtifactPlan('최근 견적서 PDF 보여줘')?.tool,'get_artifact');assert.equal(JSON.parse(localArtifactPlan('거래명세서 엑셀 찾아줘')!.input).type,'delivery_statement');assert.equal(localArtifactPlan('견적서 준비해줘'),null);
 assert.equal(localArtifactPlan('견적서 보여줘')?.tool,'get_artifact');assert.equal(JSON.parse(localArtifactPlan('견적서와 발주서 보여줘')!.input).type,undefined);assert.equal(localArtifactPlan('새로 견적서 만들어 보여줘'),null);
});

test('N17 v2 form whitelist and the shared native request accept only explicit public details',()=>{
 const form={issuer:{name:'합성업체',business_number:'000-00-00000',representative:'가상 대표'},recipient:{contact:'가상 담당'},payment_account:'가상 계좌',note:'가상시험'};
 const d={...sample(),template_version:'kr-business-v2',form};assert.ok(PublicDocumentSchema.safeParse(d).success);
 assert.ok(WorkRequestSchema.safeParse({route:'documents.complete',id:crypto.randomUUID(),client_command_id:crypto.randomUUID(),form}).success);
 for(const invalid of [{issuer:{internal_cost:'secret'}},{stamp_base64:'not-allowed'},{issuer:{business_number:'123'}},{delivery_date:'2030-02-30'}])assert.equal(PublicDocumentSchema.safeParse({...d,form:invalid}).success,false);
 assert.equal(PublicDocumentSchema.safeParse({...sample(),form}).success,false,'frozen v1 contract is unchanged');
});
