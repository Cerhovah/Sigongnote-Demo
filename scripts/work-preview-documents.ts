/** Explicit synthetic fixtures for the local lab. Never called by the production API. */
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Sql} from 'postgres';
import {parseTradePack} from '../packages/domain/src/trade-pack.js';
export function addDocumentFixtures(folder:string){
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 for(const title of ['견적 준비','발주 준비','청구 준비','거래명세 준비']){
  const text=`합성 햇살현장 ${title}\n작업: 주방 보수\n${title}\n마진:20%\n부가세:별도 10%\n받는 곳:합성 의뢰업체\n단가 기준일:${today}\n품명 | 규격 | 수량 | 단위 | 매입단가 | 판매단가\n주방 보수 | 표준 | 1 | 식 | 1000000 | 1250000\n개발 확인용 합성자료이며 실제 계약·납품·금액이 아닙니다.`;
  writeFileSync(join(folder,`sample-${Date.now()}-${randomUUID().slice(0,6)}.txt`),text,'utf8');
 }
}
export async function seedDocumentAgreement(admin:Sql,state:{tenant:string;user:string;project?:string},workName="주방 보수"){
 if(!state.project)return;
 const [existing]=await admin`select * from app.billing_agreements where tenant_id=${state.tenant}::uuid limit 1`;
 if(existing){await admin.begin(async tx=>{
  await tx`update app.evidence_index set category='agreement' where tenant_id=${state.tenant}::uuid and id=${existing.source_evidence_id}::uuid and category<>'agreement'`;
  await tx`insert into app.evidence_attributions(tenant_id,evidence_index_id,bundle_id,state,version,decision_id) select ${state.tenant}::uuid,${existing.source_evidence_id}::uuid,${existing.bundle_id}::uuid,'confirmed',2,${existing.decision_id}::uuid where not exists(select 1 from app.evidence_attributions where tenant_id=${state.tenant}::uuid and evidence_index_id=${existing.source_evidence_id}::uuid)`;
 });return;}
 const [source]=await admin`select e.id from app.evidence_index e where e.tenant_id=${state.tenant}::uuid and e.project_id=${state.project}::uuid and e.display_title like '%청구 준비%' order by e.recorded_at limit 1`;if(!source)return;
 const pack=parseTradePack(JSON.parse(readFileSync('trade-packs/generic/1.0.0.json','utf8'))),order=randomUUID(),bundle=randomUUID(),agreement=randomUUID(),decision=randomUUID(),outcome=randomUUID(),observed=randomUUID();
 await admin.begin(async tx=>{
  await tx`insert into app.work_orders(tenant_id,id,project_id,display_name) values(${state.tenant}::uuid,${order}::uuid,${state.project!}::uuid,'합성 주방 보수')`;
  await tx`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,trade_pack_id,trade_pack_version,trade_pack_hash) values(${state.tenant}::uuid,${bundle}::uuid,${order}::uuid,${workName},${pack.packId},${pack.version},${pack.contentHash})`;
  for(const [id,scope,target] of [[decision,'billing_agreement',agreement],[observed,'outcome_record',outcome]])await tx`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${state.tenant}::uuid,${id!}::uuid,${state.user}::uuid,${scope!},'synthetic_fixture',array[${target!}::uuid],array[1]::bigint[],array[${source.id}::uuid],'개발 확인용 합성 완료 및 청구 기준. 실제 계약 아님.',${'d'.repeat(64)})`;
  await tx`update app.evidence_index set category='agreement' where tenant_id=${state.tenant}::uuid and id=${source.id}::uuid`;
  await tx`insert into app.evidence_attributions(tenant_id,evidence_index_id,bundle_id,state,version,decision_id) values(${state.tenant}::uuid,${source.id}::uuid,${bundle}::uuid,'confirmed',2,${decision}::uuid)`;
  await tx`insert into app.billing_agreements(tenant_id,id,bundle_id,source_evidence_id,approved_gross_minor,decision_id) values(${state.tenant}::uuid,${agreement}::uuid,${bundle}::uuid,${source.id}::uuid,1375000,${decision}::uuid)`;
  await tx`insert into app.outcomes(tenant_id,id,bundle_id,version,decision_id,source_charge_revision_ids,source_allocation_batch_ids,source_state_sha256,actual_cost_minor,unknown_cost_cases,settlement_state,scope_completed,quantity_value,unit_code,owner_labor_included,revisit_count,transport_count,defect_count,condition_tags,learning_eligible) values(${state.tenant}::uuid,${outcome}::uuid,${bundle}::uuid,1,${observed}::uuid,'{}','{}',${'e'.repeat(64)},1000000,0,'unknown',true,'1','lump',true,0,0,0,'{}',true)`;
 });
}

export function addWorkDecisionFixtures(folder:string){
 for(const fields of ['약속일: 2020-01-01\n다음 일정: 2030-01-01','발주수량: 10 개\n인수수량: 8 개','하자: 도장 보완\n조치: 다시 방문','변경합의: 추가 운반\n부담: 회사\n추가비: 50000원'])writeFileSync(join(folder,`sample-${Date.now()}-${randomUUID().slice(0,6)}.txt`),`합성 햇살현장 업무 확인\n작업: 주방 보수\n${fields}\n개발 확인용 합성자료입니다.`,'utf8');
}
