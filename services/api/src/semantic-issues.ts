import {randomUUID} from 'node:crypto';
import type {Tx} from './auth.js';
import type {CapturePolicy} from './capture-scope.js';
import {explicitLiabilityParties,operationalFacts,type OperationalFact} from './normal-facts.js';
import {workHash} from './work-decisions.js';
import type {WorkEffect,WorkSignal} from '@sigongnote/domain';
type Signal=WorkSignal&{facts:OperationalFact[];subject:string;automatic:boolean;blocked?:string};
const unitNames:Record<string,string>={ea:'개',sheet:'장',m:'미터',m2:'㎡',kg:'kg'};
const quote=(f:OperationalFact)=>(f.semantic.evidence??[]).map((e:any)=>e.quote).join('\n');
const number=(v:string)=>{const [n='0',d='']=v.split('.');return BigInt(n)*1000000n+BigInt(d.padEnd(6,'0'));};
const decimal=(v:bigint)=>`${v/1000000n}${v%1000000n?'.'+(v%1000000n).toString().padStart(6,'0').replace(/0+$/,''):''}`;
export function factSubject(f:OperationalFact){const s=f.semantic,links=(s.entityLinks??[]).filter((l:any)=>l.mentionId===`${s.subject?.kind}:${s.subject?.mention}`&&l.status==='linked');return s.entityCoverage==='complete'&&links.length===1?String(links[0].targetId):null;}
/** Model facts provide typed source observations. State/amount effects still use existing domain commands. */
export function semanticWorkSignals(all:OperationalFact[],today:string):Signal[]{
 const stopped=new Set(all.filter(f=>['correction','cancellation'].includes(f.semantic.eventKind)).map(factSubject).filter(Boolean));
 const scheduleCandidate=(f:OperationalFact)=>f.semantic.eventKind==='acceptance'&&f.semantic.effectiveAt&&f.semantic.assertion?.polarity==='positive'&&f.semantic.assertion?.speech==='direct'&&['actual','planned'].includes(f.semantic.assertion?.modality)&&(f.semantic.uncertaintyReasons??[]).every((r:string)=>['future_effective_time','source_plan'].includes(r));
 const facts=all.filter(f=>(f.semantic.assertionStatus==='asserted'||scheduleCandidate(f))&&!['proposal','correction','cancellation','dispatch'].includes(f.semantic.eventKind)&&factSubject(f)&&!stopped.has(factSubject(f)));
 const groups=new Map<string,OperationalFact[]>();for(const f of facts){const id=factSubject(f)!;groups.set(id,[...(groups.get(id)??[]),f]);}
 const signals:Signal[]=[];
 for(const subject of stopped){const related=all.filter(f=>factSubject(f)===subject);signals.push({category:'material',subject:subject!,facts:related,automatic:false,prompt:'같은 업무에 정정·취소 기록이 있어요. 현재 유효한 내용을 확인해 주세요.',blocked:'원문에서 정정 범위를 확인하고 연결 내용을 수정하면 다시 판단해요.',effects:[],indices:[],due:null,cost:null});}

 for(const [subject,group]of groups){
  const orders=group.filter(f=>f.semantic.eventKind==='acceptance'&&f.semantic.assertionStatus==='asserted'&&f.semantic.quantity&&!f.semantic.amount&&!f.semantic.effectiveAt);
  const receipts=group.filter(f=>f.semantic.eventKind==='receipt'&&f.semantic.quantity&&f.transaction_key);
  if(orders.length===1&&receipts.length&&orders[0]!.semantic.subject?.kind==='item_instance'){
   const o=orders[0]!,unit=o.semantic.quantity.unitCode,byTransaction=new Map<string,OperationalFact>();let conflict=false;
   for(const f of receipts){if(f.semantic.quantity.unitCode!==unit||!/^\d+(?:\.\d{1,3})?$/.test(f.semantic.quantity.value)){conflict=true;break;}const prior=byTransaction.get(f.transaction_key!);if(prior&&number(prior.semantic.quantity.value)!==number(f.semantic.quantity.value))conflict=true;byTransaction.set(f.transaction_key!,f);}
   if(conflict)signals.push({category:'material',subject,facts:[o,...receipts],automatic:false,prompt:'같은 인수 기록의 수량이나 단위가 서로 달라요. 받은 내용을 확인해 주세요.',blocked:'서로 다른 수량·단위의 원문을 확인해 주세요. 수량을 합쳐서 반영하지 않았어요.',effects:[],indices:[],due:null,cost:null});
   if(!conflict&&unitNames[unit]&&/^\d{1,9}(?:\.\d{1,3})?$/.test(o.semantic.quantity.value)){
    const amount=decimal([...byTransaction.values()].reduce((sum,f)=>sum+number(f.semantic.quantity.value),0n));
    if(/^\d{1,9}(?:\.\d{1,3})?$/.test(amount)){const automatic=number(amount)===number(o.semantic.quantity.value);signals.push({category:'material',subject,facts:[o,...receipts],automatic,prompt:automatic?`합의·인수 ${amount}${unitNames[unit]} 기록이 일치해요.`:`합의 수량 ${o.semantic.quantity.value}${unitNames[unit]}, 인수 기록 ${amount}${unitNames[unit]}예요. 받은 수량으로 반영할까요?`,effects:[{kind:'acceptance',quantity:amount,ordered:o.semantic.quantity.value,unit:unitNames[unit]!}],indices:[],due:null,cost:null});}
   }
  }
  const schedules=group.filter(f=>f.semantic.eventKind==='acceptance'&&f.semantic.effectiveAt&&/일정|약속|마감일|마감 기한/u.test(quote(f))&&quote(f).includes(new Date(Date.parse(f.semantic.effectiveAt)+9*3600000).toISOString().slice(0,10)));
  const day=(f:OperationalFact)=>new Date(Date.parse(f.semantic.effectiveAt)+9*3600000).toISOString().slice(0,10);
  const past=schedules.filter(f=>day(f)<today),next=schedules.filter(f=>day(f)>=today);
  if(past.length===1&&next.length===1){const date=day(next[0]!);signals.push({category:'schedule',subject,facts:[past[0]!,next[0]!],automatic:false,prompt:`약속한 일정이 지났어요. 새로 합의한 ${date}로 반영할까요?`,effects:[{kind:'schedule',date}],indices:[],due:day(past[0]!),cost:null});}
  const defects=group.filter(f=>f.semantic.eventKind==='inspection'&&/하자|보완/u.test(quote(f))&&f.semantic.object?.role==='remedy'&&quote(f).includes(f.semantic.object.mention));
  if(defects.length){
   let chosen=defects;const remedies=new Set(defects.map(f=>String(f.semantic.object.mention)));
   if(remedies.size>1){const dated=defects.every(f=>Number.isFinite(Date.parse(f.semantic.observedAt??'')));if(dated){const newest=Math.max(...defects.map(f=>Date.parse(f.semantic.observedAt)));chosen=defects.filter(f=>Date.parse(f.semantic.observedAt)===newest);}if(!dated||new Set(chosen.map(f=>f.semantic.object.mention)).size>1){signals.push({category:'defect',subject,facts:defects,automatic:false,prompt:'점검 조치 기록이 여러 개예요. 현재 필요한 조치를 확인해 주세요.',blocked:'서로 다른 조치의 시간 관계가 분명하지 않아요. 원문을 확인한 뒤 연결 내용을 정리해 주세요.',effects:[],indices:[],due:null,cost:null});chosen=[];}}
   if(chosen.length){const action=String(chosen[0]!.semantic.object.mention);if(action.length<=200)signals.push({category:'defect',subject,facts:chosen,automatic:false,prompt:`점검 기록에 ${action} 조치가 있어요. 보완할 일로 반영할까요?`,effects:[{kind:'quality',action}],indices:[],due:null,cost:null});}
  }
  const changes=group.filter(f=>f.semantic.eventKind==='acceptance'&&/변경|추가비/u.test(quote(f))&&f.semantic.amount?.knowledge==='known'&&/^[1-9][0-9]{0,14}$/.test(f.semantic.amount.minor));
  if(changes.length===1){const f=changes[0]!,parties=explicitLiabilityParties([quote(f)]);
   if(parties.length===1)signals.push({category:'change',subject,facts:[f],automatic:false,prompt:`변경 추가비 ${BigInt(f.semantic.amount.minor).toLocaleString('ko-KR')}원, ${parties[0]![0]} 부담 합의가 있어요. 기존 비용에 반영할까요?`,effects:[{kind:'liability',party:parties[0]![1] as 'company'|'customer'|'supplier'}],indices:[],due:null,cost:f.semantic.amount.minor});
  }
 }
 return signals;
}
export async function refreshSemanticIssues(tx:Tx,tenant:string,policy:CapturePolicy|undefined){
 const contexts=await tx`select w.*,p.display_name project_name from app.work_contexts w join app.projects p on p.tenant_id=w.tenant_id and p.id=w.project_id where w.tenant_id=${tenant}::uuid order by w.id limit 201`;let partial=0;
 const [clock]=await tx`select (now() at time zone 'Asia/Seoul')::date::text today`;
 for(const w of contexts.slice(0,200)){const input=await operationalFacts(tx,tenant,w.id,policy);if(!input||input.partial){partial++;continue;}
  for(const signal of semanticWorkSignals(input.facts,clock!.today)){
   const basis=signal.facts.map(f=>({id:f.id,version:f.version})).sort((a,b)=>a.id.localeCompare(b.id)),effects=[...signal.effects];let blocked:string|null=signal.blocked??null;
   if(signal.cost){const charges=w.bundle_id?await tx`select id,version from app.charge_cases where tenant_id=${tenant}::uuid and bundle_id=${w.bundle_id}::uuid and category='change' and status in ('confirmed','adjusted') order by id limit 2`:[];const liability=effects.find(e=>e.kind==='liability');
    if(charges.length===1&&liability?.kind==='liability')effects.push({kind:'charge_adjustment',charge_id:charges[0]!.id,version:Number(charges[0]!.version),amount_minor:signal.cost,liability:liability.party,reason:'change'});else blocked='추가비를 반영할 기존 비용을 하나로 연결하지 못했어요. 비용 연결을 확인해 주세요.';
   }
   const revisions=[...new Set(signal.facts.map(f=>f.revision))];
   // A typed legacy question from the same source already owns this decision; don't ask it twice.
   if((await tx`select 1 from app.work_decision_cases c where c.tenant_id=${tenant}::uuid and c.context_id=${w.id}::uuid and c.category=${signal.category} and not(c.proposal?'semantic_basis') and exists(select 1 from jsonb_array_elements(c.source_refs) r where r->>'revision'=any(${revisions}::text[])) limit 1`).length)continue;
   const key=workHash(['semantic-work-v1',w.id,signal.subject,signal.category]),basisHash=workHash([basis,effects.map(e=>e.kind==='charge_adjustment'?{...e,version:0}:e),blocked]);
   if((await tx`select id from app.work_decision_cases where tenant_id=${tenant}::uuid and issue_key=${key} and basis_hash=${basisHash}`).length)continue;
   const refs=new Map<string,{revision:string;span:number;organization_version:number}>(),evidence:string[]=[];
   for(const f of signal.facts)for(const ref of f.semantic.evidence){const k=f.revision+':'+ref.ordinal;if(refs.has(k))continue;
    const [chunk]=await tx`select text from app.evidence_chunks where tenant_id=${tenant}::uuid and revision_id=${f.revision}::uuid and job_id=${ref.indexJobId}::uuid and ordinal=${ref.ordinal} and content_hash=${ref.contentHash}`;if(!chunk)continue;
    await tx`insert into app.evidence_index(tenant_id,revision_id,project_id,scope,category,display_title,search_text,locator,source_kind,organization_span) values(${tenant}::uuid,${f.revision}::uuid,${w.project_id}::uuid,'project',${signal.category==='material'?'delivery_work':signal.category==='defect'?'inspection_defect':'agreement'},${String(chunk.text).slice(0,180)},${chunk.text},${tx.json({kind:'parsed',position:{span:ref.ordinal,locator:ref.locator}})},'original',${ref.ordinal}) on conflict do nothing`;
    const [e]=await tx`select id from app.evidence_index where tenant_id=${tenant}::uuid and revision_id=${f.revision}::uuid and organization_span=${ref.ordinal} and source_kind='original'`;if(e){evidence.push(e.id);refs.set(k,{revision:f.revision,span:ref.ordinal,organization_version:Number(f.organization_version)});}
   }
   if(!refs.size||refs.size>100)continue;const id=randomUUID();
   await tx`insert into app.exception_cases(tenant_id,id,bundle_id,cause_key,cause,state,due_at) values(${tenant}::uuid,${id}::uuid,${w.bundle_id}::uuid,${key},${signal.category==='schedule'?'today_blocked':'other'},'awaiting_decision',${signal.due?signal.due+'T23:59:59+09:00':null}::timestamptz)`;
   await tx`insert into app.work_decision_cases(tenant_id,id,context_id,project_id,category,issue_key,basis_hash,source_refs,evidence_ids,prompt,proposal,automatic_only) values(${tenant}::uuid,${id}::uuid,${w.id}::uuid,${w.project_id}::uuid,${signal.category},${key},${basisHash},${tx.json([...refs.values()])},${evidence}::uuid[],${signal.prompt},${tx.json({effects,blocked,bundle_id:w.bundle_id,cost_options:{},semantic_basis:basis,semantic_subject:signal.subject,semantic_category:signal.category})},${signal.automatic})`;
   await tx`insert into app.work_projections(tenant_id,context_id) values(${tenant}::uuid,${w.id}::uuid) on conflict do nothing`;
  }
 }
 return {partial_contexts:partial,limited:contexts.length>200};
}
export async function semanticIssueCurrent(tx:Tx,tenant:string,issue:any,policy:CapturePolicy|undefined){
 if(!issue.proposal.semantic_basis)return true;const input=await operationalFacts(tx,tenant,issue.context_id,policy);if(!input||input.partial)return false;
 const [clock]=await tx`select (now() at time zone 'Asia/Seoul')::date::text today`;
 return semanticWorkSignals(input.facts,clock!.today).some(s=>s.subject===issue.proposal.semantic_subject&&s.category===issue.category&&workHash(s.facts.map(f=>({id:f.id,version:f.version})).sort((a,b)=>a.id.localeCompare(b.id)))===workHash(issue.proposal.semantic_basis));
}
