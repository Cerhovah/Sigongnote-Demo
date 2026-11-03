import {z} from 'zod';
import type {Tx} from './auth.js';
import type {AgentScope} from './agent-tools.js';
import {ApiFault} from './routes.js';
import {readIssuedDocument} from './document-issuance.js';
import {documentNames} from './document-drafts.js';
const types=z.enum(['estimate','purchase_order','invoice','delivery_statement']);
export const ArtifactInputSchema=z.strictObject({id:z.uuid().optional(),type:types.optional(),format:z.enum(['pdf','xlsx']).optional()});
export const ArtifactReceiptSchema=z.strictObject({id:z.uuid(),revision_id:z.uuid(),type:types,label:z.string(),number:z.string(),state:z.string(),render_state:z.string(),files:z.array(z.strictObject({format:z.enum(['pdf','xlsx']),sha256:z.string().regex(/^[a-f0-9]{64}$/),byte_length:z.number().int().positive()})).max(2)});
/** Read-only discovery. Actual bytes always use the existing authenticated file route. */
export async function getAgentArtifacts(tx:Tx,scope:AgentScope,input:unknown){
 const b=ArtifactInputSchema.parse(input);if(!scope.project&&!b.id)throw new ApiFault('INVALID_CONTRACT');
 const ids=await tx`select d.id from app.business_documents d join app.business_document_revisions r on r.tenant_id=d.tenant_id and r.document_id=d.id where d.tenant_id=${scope.tenant}::uuid and (${b.id??null}::uuid is null or d.id=${b.id??null}::uuid) and (${scope.project}::uuid is null or r.snapshot#>>'{project,id}'=${scope.project}) and (${b.type??null}::text is null or d.document_type=${b.type??null}) and not exists(select 1 from app.business_document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.version>r.version) order by d.created_at desc,d.id desc limit 5`;
 if(b.id&&!ids.length)throw new ApiFault('NOT_FOUND');const artifacts=[];
 for(const row of ids){try{const d=await readIssuedDocument(tx,scope.tenant,String(row.id));artifacts.push({id:d.id,revision_id:d.revision_id,type:d.document.type,label:documentNames[d.document.type as keyof typeof documentNames],number:d.document.document_number,state:d.state,render_state:String(d.render_state),files:d.state==='approved'?d.files.filter(f=>!b.format||f.format===b.format).map(f=>({format:f.format,sha256:f.sha256,byte_length:Number(f.byte_length)})):[]});}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}}
 return {artifacts:z.array(ArtifactReceiptSchema).max(5).parse(artifacts)};
}
export function localArtifactPlan(text:string){
 if(!/찾|보여|열어|다운로드/u.test(text)||/준비|만들|작성|새로/u.test(text)||!/PDF|엑셀|XLSX|발행한|발행된|파일|문서\s*번호|견적서|발주서|청구서|거래\s*명세/iu.test(text))return null;
 const mentioned=[[/거래\s*명세/u,'delivery_statement'],[/청구/u,'invoice'],[/발주/u,'purchase_order'],[/견적/u,'estimate']] as const;
 const matches=mentioned.filter(([pattern])=>pattern.test(text)),type=matches.length===1?matches[0]![1]:undefined;
 return {tool:'get_artifact' as const,input:JSON.stringify({...(type?{type}:{}),...(/PDF/i.test(text)?{format:'pdf'}:/엑셀|XLSX/i.test(text)?{format:'xlsx'}:{})})};
}
