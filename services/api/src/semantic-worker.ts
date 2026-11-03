import {createHash} from 'node:crypto';
import {runSemantic} from './product-ai.js';
import {promoteSemanticOnce} from './semantic-promotion.js';
import type {SemanticValidationContext} from '@sigongnote/domain';
import {tokenCostKrw,type ProductAiConfig} from './product-ai-config.js';
import {semanticRequest} from './semantic-provider.js';
import type {Db} from './auth.js';
import type {CapturePolicy} from './capture-scope.js';
import type {ClaimInput} from '@sigongnote/domain';
import {selectSemanticWindow,type SourceChunk} from './semantic-layout.js';
export const SEMANTIC_PROMPT='construction-semantics-v3-audio-context';
const deferred=new Map<string,number>();
export function semanticHeadroom(config:ProductAiConfig){
 const id='00000000-0000-4000-8000-000000000001';
 const seed:ClaimInput={tenantId:id,revisionId:id,sourceHash:'0'.repeat(64),parserVersion:'bounded',promptVersion:SEMANTIC_PROMPT,schemaVersion:'model-claims-v1',tradePackVersion:'construction-v1',scopeFingerprint:'0'.repeat(64),sourceGeneration:1,externalAiConsent:true,spans:[{revisionId:id,locator:'section:0',kind:'text',text:'x'}]};
 const context:SemanticValidationContext={tenantId:id,revisionId:id,indexJobId:id,observedAt:'2026-01-01T00:00:00Z',modelVersion:config.model,promptVersion:SEMANTIC_PROMPT,chunks:[{ordinal:0,contentHash:'0'.repeat(64),locator:'text:0',text:'x',active:true}]};
 return Math.max(1,tokenCostKrw(config.price,semanticRequest(seed,config,context).maxInputTokenBound,config.maxOutputTokens));
}
export async function runSemanticOnce(options:{db:Db;policy:CapturePolicy;semantic?:ProductAiConfig|undefined;tenantScope?:string;transport?:typeof fetch;timeoutMs?:number}){
 const {db,policy,semantic:config}=options;
 if(await promoteSemanticOnce(options))return 'promoted';
 if(!config||!policy.external_processing||policy.provider!==config.provider)return 'idle';
 if(Date.parse(config.price.valid_until)<=Date.now())return 'price_expired';
 const modelKey=createHash('sha256').update(JSON.stringify({model:config.model,provider:config.provider,prompt:SEMANTIC_PROMPT,schema:'semantic-candidates-v1'})).digest('hex');
 for(const [key,until] of deferred)if(until<=Date.now())deferred.delete(key);
 const headroom=semanticHeadroom(config);if(headroom>10000)return 'price_wait';
 const [row]=await db`select app.next_semantic_input(${db.json(policy)},${modelKey},${options.tenantScope??null}::uuid,${headroom}::bigint,${[...deferred.keys()]}::uuid[]) value`;
 const source=row?.value;if(!source)return 'idle';
 const window=selectSemanticWindow(source.chunks as SourceChunk[],source.context_chunks??[]),chunks=window.primary;
 const defer=()=>{if(deferred.size>=1000)deferred.delete(deferred.keys().next().value!);deferred.set(String(source.index_job),Date.now()+60000);};
 if(!chunks.length){defer();return 'input_wait';}
 const scope={tenant:String(source.tenant),user:String(source.user),source:String(source.source),generation:Number(source.generation),revision:String(source.revision)};
 const input:ClaimInput={tenantId:scope.tenant,revisionId:scope.revision,sourceHash:source.source_hash,parserVersion:source.parser,promptVersion:SEMANTIC_PROMPT,schemaVersion:'semantic-candidates-v1',tradePackVersion:'construction-v1',scopeFingerprint:source.scope,sourceGeneration:scope.generation,externalAiConsent:true,
  spans:chunks.map(c=>({revisionId:scope.revision,locator:`section:${c.ordinal}`,kind:'text',text:c.text}))};
 // Internal locator maps exactly to this immutable chunk ID. Original page/cell/box stays in N02.
 const trace={policy,policy_provider:policy.provider,index_job:source.index_job,model_key:modelKey,first_ordinal:chunks[0]!.ordinal,last_ordinal:chunks.at(-1)!.ordinal,context_ordinals:window.context.map(c=>c.ordinal)};
 const context:SemanticValidationContext={tenantId:scope.tenant,revisionId:scope.revision,indexJobId:source.index_job,observedAt:new Date().toISOString(),modelVersion:config.model,promptVersion:SEMANTIC_PROMPT,chunks:window.chunks};
 try{const result=await runSemantic(db,scope,input,config,trace,AbortSignal.timeout(options.timeoutMs??45000),options.transport,context);
  if(!result.value)defer();else await promoteSemanticOnce(options);
  return result.value?'stored':result.state;
 }catch{defer();return 'input_wait';}
}
