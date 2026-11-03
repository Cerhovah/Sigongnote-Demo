import {adaptLegacyClaimsToSemanticCandidates,validateSemanticBatchPartial,semanticRejectionCode,type SemanticValidationContext} from '@sigongnote/domain';
import type {Db} from './auth.js';
import type {CapturePolicy} from './capture-scope.js';
import {linkDirectoryEvidence} from './entity-links.js';
export async function promoteSemanticOnce(options:{db:Db;policy:CapturePolicy;tenantScope?:string}){
 const {db}=options;
 const [row]=await db`select app.next_semantic_promotion(${options.tenantScope??null}::uuid,${db.json(options.policy)}) input`;
 if(!row?.input)return false;const i=row.input;
 const context:SemanticValidationContext={tenantId:i.tenant,revisionId:i.revision,indexJobId:i.job,observedAt:i.observedAt,modelVersion:i.model,promptVersion:i.prompt,chunks:i.chunks};
 let batch:unknown=null;
 try{
  const output=i.output.semanticCandidates;
  // Discard server enrichment from a stored result and recompute it against current authority.
  const raw=output?.raw??(output?{schemaVersion:output.schemaVersion,modelVersion:output.modelVersion,promptVersion:output.promptVersion,candidates:output.candidates.map(({tenantId:_,revisionId:__,observedAt:___,status:____,assertionStatus:_____,...c}:Record<string,unknown>)=>({...c,uncertaintyReasons:Array.isArray(c.uncertaintyReasons)?c.uncertaintyReasons.filter(x=>!['source_negation','source_condition','source_plan','reported_speech','quoted_speaker_unknown','future_effective_time','ambiguous_quote_context'].includes(String(x))):[]}))}:null);
  const validated=raw?validateSemanticBatchPartial(raw,context):adaptLegacyClaimsToSemanticCandidates(i.output,context);
  const identities=linkDirectoryEvidence(i.identity);
  batch={...validated,candidates:validated.candidates.map(c=>{
   const text=c.evidence.map(e=>e.quote).join('\n');
   const categories=[...new Set([
    ...(['request','proposal','acceptance'].includes(c.eventKind)||/견적|계약|발주|합의/.test(text)?['agreement']:[]),
    ...(/도면|실측|규격|색상|자재/.test(text)?['drawing_material']:[]),
    ...(['dispatch','receipt'].includes(c.eventKind)||/시공|출역|납품/.test(text)?['delivery_work']:[]),
    ...(/청구|기성|매입|매출|계산서|수금|지급|정산|입금/.test(text)?['billing_payment']:[]),
    ...(c.eventKind==='inspection'||/점검|하자|검수|보완/.test(text)?['inspection_defect']:[])])];
   const mentions=[c.actor,c.subject,c.object].filter(m=>m!==null);
   return {...c,categories,entityLinks:identities.links.filter(l=>mentions.some(m=>l.mentionId===`${m.kind}:${m.mention}`)),entityCoverage:identities.coverage};
  })};
 }catch(error){const reason=semanticRejectionCode(error);if(!reason)throw error;batch={invalidReason:reason};}
 const [saved]=await db`select app.save_semantic_candidates(${i.tenant}::uuid,${i.usage}::uuid,${i.user}::uuid,${i.context_hash},${batch?db.json(batch as never):null}::jsonb,${db.json(options.policy)}) ok`;
 return saved?.ok===true;
}
