import { proposeAttribution } from "./attribution.js";
export const ORGANIZER_VERSION="field-rules-v1";
export const categories=["agreement","drawing_material","delivery_work","billing_payment","inspection_defect"] as const;
export type Category=typeof categories[number];
export type OrganizationInput={tenantId:string;revisionId:string;spans:{text:string;locator:string}[];projects:{id:string;display_name:string}[];bindings:{project_id:string|null;scope_mode:string}[];bundles:{id:string;project_id:string;display_name:string}[]};
const rules:Record<Category,RegExp>={agreement:/견적|계약|발주|합의|변경 요청/,drawing_material:/도면|실측|규격|색상|자재 제출|자재 승인/,delivery_work:/운송|납품|인수|출역|시공|작업|배송/,billing_payment:/청구|기성|매입|매출|계산서|수금|지급|정산|입금/,inspection_defect:/점검|검수|보완|하자|조치|불량/};
function assertion(text:string){if(/정정|수정|바꿉|변경합니다/.test(text))return "correction";if(/(?:하면|않으면|경우|조건|라면)/.test(text))return "condition";if(/미확인|모릅|알 수 없/.test(text))return "observation";if(/아니|않|취소|거절/.test(text))return "denial";if(/합의|승낙|승인|수락/.test(text))return "acceptance";if(/어떨|할까|되나|제안|\?/.test(text))return "proposal";if(/해주세요|해 주세요|요청|부탁/.test(text))return "request";if(/예정|계획|하기로/.test(text))return "plan";return "observation";}
/** Bounded deterministic candidates. No transaction, receipt or amount is confirmed here. */
export function organizeEvidence(input:OrganizationInput){
 const spans=input.spans.slice(0,1000);const clues=spans.filter(s=>s.text.trim()).slice(0,100).map(s=>({source:"body" as const,...s}));
 const common=input.bindings.some(b=>b.scope_mode==="company_common");
 const attribution=proposeAttribution({tenantId:input.tenantId,revisionId:input.revisionId,observedAt:null,documentScope:common?"common":"project",clues,projects:input.projects.map(p=>({tenantId:input.tenantId,id:p.id,displayName:p.display_name,aliases:[]})),bundles:[],parties:[],itemTypes:[]});
 const candidates=[...new Set([...input.bindings.flatMap(b=>b.project_id?[b.project_id]:[]),...attribution.candidates.filter(c=>c.targetKind==="project").map(c=>c.targetId)])].sort();
 const projectId=!common&&candidates.length===1?candidates[0]!:null;
 const text=spans.map(s=>s.text).join("\n");const explicit=[...text.matchAll(/(?:^|\n)\s*(?:이번 일|작업명|작업)\s*[:：]\s*([^\n]{2,100})/g)].map(m=>(m[1]??"").trim()).filter(label=>label.length>=2&&label.length<=100);
 const bundles=projectId?input.bundles.filter(b=>b.project_id===projectId&&b.display_name.trim().length>=2&&b.display_name.length<=100&&text.includes(b.display_name)):[];
 const labels=[...new Set(explicit)];const workLabel=projectId&&labels.length===1?labels[0]!:projectId&&bundles.length===1?bundles[0]!.display_name:null;
 const facts=spans.flatMap((span,index)=>{if(!span.text.trim())return [];const tags=categories.filter(c=>rules[c].test(span.text));return [{span_index:index,locator:span.locator,text:span.text,categories:tags,assertion_kind:assertion(span.text),subject:workLabel??"unresolved",predicate:"source_statement",value:{kind:"text",text:span.text},unit:null,effective_at:null}];});
 return {version:ORGANIZER_VERSION,categories:categories.filter(c=>facts.some(f=>f.categories.includes(c))),project_id:projectId,project_candidates:candidates,state:common?"common":candidates.length>1?"conflict":projectId?"linked":"unassigned",work_label:workLabel,bundle_id:bundles.length===1&&(!workLabel||workLabel===bundles[0]!.display_name)?bundles[0]!.id:null,facts};
}
