import {BusinessEventSchema,reduceBusinessEvents,stableBusinessEventKey,type BusinessEvent} from '@sigongnote/domain';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Db,type Tx} from './auth.js';
import type {CapturePolicy} from './capture-scope.js';
import {linkDirectoryEvidence} from './entity-links.js';
import {ApiFault,execute,principal,tenantHeader,type Services} from './routes.js';

type Snapshot={tenant:string;context:string;watermark:number;observedVersion:number;context_hash:string;events:BusinessEvent[];facts:any[];commands:any[];adjustments:any[]};
/** IDs, consent, immutable source hashes and import receipts come from the worker-only DB snapshot.
 * Model subject mentions are resolved again against N05; models cannot assign transaction authority. */
export function businessEventBatch(snapshot:Snapshot){
 let sequence=Number(snapshot.watermark);const records:{adapter_kind:string;adapter_id:string;event_key:string;event:BusinessEvent}[]=[];
 const base=(row:any):BusinessEvent=>({id:row.eventId,tenantId:snapshot.tenant,contextId:snapshot.context,sequence:++sequence,kind:'observation',subject:'unresolved:'+row.id,transactionKey:null,quantity:null,amount:null,mode:'observed',asserted:false,existingEffect:null,evidenceIds:[],evidenceWithdrawn:false,effectiveAt:null,recordedAt:row.recordedAt,supersedes:null,reverses:null});
 const append=(adapter_kind:string,row:any,event:BusinessEvent)=>{event=BusinessEventSchema.parse(event);records.push({adapter_kind,adapter_id:row.id,event_key:stableBusinessEventKey(event),event});};
 for(const row of snapshot.facts){
  const s=row.semantic,identities=row.identity?linkDirectoryEvidence(row.identity):null;
  const links=identities?.coverage==='complete'?identities.links.filter(l=>s.subject&&l.mentionId===`${s.subject.kind}:${s.subject.mention}`&&l.status==='linked'):[];
  const target=links.length===1?links[0]!.targetId:null;
  const event={...base(row),kind:s.eventKind,subject:target?`${links[0]!.targetKind}:${target}`:'unresolved:'+row.id,
   transactionKey:target?row.transactionKey:null,quantity:s.quantity,amount:s.amount,asserted:s.assertionStatus==='asserted',effectiveAt:s.effectiveAt,
   evidenceIds:s.evidence.map((e:any)=>`${row.revision}:${e.indexJobId}:${e.ordinal}`)};
  // Only the DB's explicit transaction-identity decision graph may identify a transaction. Corrections need a later explicit link.
  append('semantic_fact',row,event);
 }
 for(const [kind,rows] of [['work_command',snapshot.commands],['charge_adjustment',snapshot.adjustments]] as const)for(const row of rows)
  append(kind,row,{...base(row),subject:kind==='charge_adjustment'?'charge:'+row.charge:'work:'+snapshot.context,mode:'applied',asserted:true,existingEffect:{kind,id:row.id},evidenceIds:[]});
 const reduced=reduceBusinessEvents([...snapshot.events,...records.map(r=>r.event)],{tenantId:snapshot.tenant,contextId:snapshot.context});
 return {records,reduced};
}
export async function publishBusinessEventsOnce(options:{db:Db;tenantScope?:string}){
 const {db}=options;const [row]=await db`select app.claim_business_outbox(${options.tenantScope??null}::uuid) value`;const lease=row?.value;if(!lease)return false;
 try{const [result]=await db`select app.finish_business_outbox(${lease.tenant}::uuid,${lease.id}::uuid,${lease.token}::uuid,true) ok`;return result?.ok===true;}
 catch{await db`select app.finish_business_outbox(${lease.tenant}::uuid,${lease.id}::uuid,${lease.token}::uuid,false)`;return false;}
}
type BusinessRetry={tenant:string;context:string;hash:string;retryAt:number};
type BusinessSchedule={after:{tenant:string;context:string}|null;blocked:Map<string,BusinessRetry>};
const businessSchedules=new WeakMap<Db,BusinessSchedule>();
export async function runBusinessEventsOnce(options:{db:Db;policy:CapturePolicy;tenantScope?:string;now?:()=>number;onFailure?:(code:string)=>void}){
 const {db}=options,now=(options.now??Date.now)();
 let schedule=businessSchedules.get(db);if(!schedule){schedule={after:null,blocked:new Map()};businessSchedules.set(db,schedule);}
 for(const [key,value]of schedule.blocked)if(value.retryAt<=now)schedule.blocked.delete(key);
 // Publication remains independent of poisoned contexts and continuous successful imports.
 const published=await publishBusinessEventsOnce(options);let failed=false;
 for(let attempt=0;attempt<8;attempt++){
  const cursor={after:schedule.after,excluded:[...schedule.blocked.values()]};
  const [row]=await db`select app.next_business_event_input(${options.tenantScope??null}::uuid,${db.json(options.policy)},${db.json(cursor)}) input`;
  if(!row?.input)return published?'published':failed?'retry':'idle';
  const input=row.input as Snapshot&{failure?:string},key=`${input.tenant}:${input.context}`;
  schedule.after={tenant:input.tenant,context:input.context};
  try{
   if(input.failure)throw new Error('BUSINESS_CONTEXT_INPUT_INVALID');
   const batch=businessEventBatch(input);
   const [saved]=await db`select app.save_business_event_projection(${input.tenant}::uuid,${input.context}::uuid,${input.context_hash},${input.observedVersion}::bigint,${db.json(batch.records)},${db.json(batch.reduced)},${db.json(options.policy)}) ok`;
   schedule.blocked.delete(key);return saved?.ok===true?'stored':'stale';
  }catch{
   failed=true;schedule.blocked.delete(key);schedule.blocked.set(key,{tenant:input.tenant,context:input.context,hash:input.context_hash,retryAt:now+60_000});
   if(schedule.blocked.size>1024)schedule.blocked.delete(schedule.blocked.keys().next().value!);
   // Never log the exception, source, model payload, IDs or hashes.
   (options.onFailure??console.warn)('BUSINESS_CONTEXT_RETRY');
  }
 }
 return published?'published':'retry';
}
export async function readBusinessWork(tx:Tx,tenant:string,contextId:string,policy:CapturePolicy|undefined){
 const [row]=await tx`select app.read_business_work(${tenant}::uuid,${contextId}::uuid,${tx.json(policy??{})}) value`;const input=row?.value;if(!input)return null;
 const reduced=reduceBusinessEvents(input.events,{tenantId:tenant,contextId:contextId});
 return {context_id:contextId,version:Number(input.observedVersion),confirmed_version:Number(input.confirmedVersion),...reduced,approval_confirmed:false,payment_executed:false};
}
export function registerBusinessEventRoutes(app:FastifyInstance,services:Services){
 app.get<{Params:{id:string}}>('/v1/work/:id/state',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   const body=await readBusinessWork(tx,tenant,id.data,services.capturePolicy);if(!body)throw new ApiFault('NOT_FOUND');return {status:200,body};
  });
 }));
}
