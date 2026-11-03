import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalValue} from './canonical-value.js';

const decimal=z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,6})?$/);
const quantity=z.strictObject({value:decimal,unitCode:z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)}).readonly();
const kinds=['observation','request','proposal','acceptance','ordered','dispatch','receipt','inspection','billing','payment','correction','cancellation'] as const;
const buckets=['ordered','dispatch','receipt','inspection','billing','payment'] as const;
export const BusinessEventSchema=z.strictObject({
 id:z.uuid(),tenantId:z.uuid(),contextId:z.uuid(),sequence:z.number().int().nonnegative(),kind:z.enum(kinds),
 subject:z.string().min(1).max(240),transactionKey:z.string().min(1).max(240).nullable(),quantity:quantity.nullable(),
 amount:z.strictObject({minor:z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})$/).nullable(),knowledge:z.enum(['known','unknown']),currency:z.literal('KRW')})
  .refine(v=>(v.knowledge==='known')===(v.minor!==null)).readonly().nullable(),
 mode:z.enum(['observed','applied']),asserted:z.boolean(),existingEffect:z.strictObject({kind:z.string().min(1).max(80),id:z.string().min(1).max(240)}).readonly().nullable(),
 evidenceIds:z.array(z.string().min(1).max(240)).max(100).readonly(),evidenceWithdrawn:z.boolean(),
 effectiveAt:z.iso.datetime().nullable(),recordedAt:z.iso.datetime(),supersedes:z.uuid().nullable(),reverses:z.uuid().nullable(),
}).superRefine((e,ctx)=>{
 if((e.mode==='applied')!==(e.existingEffect!==null)||e.supersedes&&e.reverses||e.supersedes===e.id||e.reverses===e.id)
  ctx.addIssue({code:'custom',message:'INVALID_EVENT_AUTHORITY'});
}).readonly();
export type BusinessEvent=z.infer<typeof BusinessEventSchema>;
export type BusinessEventKind=BusinessEvent['kind'];
export type ObservedWorkEntry={subject:string;unitCode:string|null;quantity:string|null;eventIds:string[];uncertain:boolean};
function scaled(value:string){const negative=value.startsWith('-'),[whole='0',fraction='']=value.replace('-','').split('.');return (BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')))*(negative?-1n:1n);}
function decimalText(value:bigint){const negative=value<0n,a=negative?-value:value,fraction=(a%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return `${negative?'-':''}${a/1000000n}${fraction?'.'+fraction:''}`;}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonicalValue(v))).digest('hex');
/** The caller must prove transactionKey and subject identity, source ACL, hashes and actor authority.
 * A model-proposed transaction key is not proof. Null keys stay separate and never contribute totals. */
export function stableBusinessEventKey(e:Pick<BusinessEvent,'id'|'tenantId'|'contextId'|'transactionKey'|'kind'|'subject'|'quantity'>){
 return hash([e.tenantId,e.contextId,e.transactionKey===null?['unresolved',e.id]:['proven',e.transactionKey],e.kind,e.subject,e.quantity?[decimalText(scaled(e.quantity.value)),e.quantity.unitCode]:null]);
}
/** Pure replay of source observations; imported applied pointers never execute or alter confirmed state. */
export function reduceBusinessEvents(input:readonly BusinessEvent[],scope:{tenantId:string;contextId:string}){
 const events=new Map<string,BusinessEvent>();let duplicateCount=0;
 for(const raw of input){const e=BusinessEventSchema.parse(raw);
  if(e.tenantId!==scope.tenantId||e.contextId!==scope.contextId)throw Error('EVENT_SCOPE_MISMATCH');
  const prior=events.get(e.id);if(prior){if(hash(prior)!==hash(e))throw Error('EVENT_ID_CONFLICT');duplicateCount++;}else events.set(e.id,e);
 }
 const ordered=[...events.values()].sort((a,b)=>Date.parse(a.effectiveAt??a.recordedAt)-Date.parse(b.effectiveAt??b.recordedAt)||a.sequence-b.sequence||a.id.localeCompare(b.id));
 const keyById=new Map(ordered.map(e=>[e.id,stableBusinessEventKey(e)]));
 const groups=new Map<string,BusinessEvent[]>();for(const e of ordered){const k=keyById.get(e.id)!;groups.set(k,[...(groups.get(k)??[]),e]);}
 const conflicts=new Set<string>(),suppressed=new Set<string>(),children=new Map<string,Set<string>>();
 const representative=new Map([...groups].map(([k,v])=>[k,v[0]!]));
 for(const [k,rows] of groups){duplicateCount+=rows.length-1;
  // Quotes, source IDs and dates may differ between copies; conflicting business content cannot disappear.
  if(new Set(rows.map(e=>hash([e.mode,e.asserted,e.amount,e.existingEffect,e.supersedes&&keyById.get(e.supersedes),e.reverses&&keyById.get(e.reverses)]))).size>1)conflicts.add(k);
 }
 for(const [k,rows] of groups){const e=rows[0]!;if(e.mode==='applied'||!e.asserted)continue;
  const ref=e.supersedes??e.reverses;if(!ref){if(e.kind==='correction'||e.kind==='cancellation')conflicts.add(k);continue;}
  const target=keyById.get(ref),parent=target&&representative.get(target);
  if(!target||!parent||parent.subject!==e.subject||parent.mode==='applied'||target===k){conflicts.add(k);continue;}
  const linked=children.get(target)??new Set<string>();linked.add(k);children.set(target,linked);suppressed.add(target);
  if(rows.every(r=>r.evidenceWithdrawn))conflicts.add(k);
 }
 for(const [parent,list] of children)if(list.size>1){conflicts.add(parent);for(const child of list)conflicts.add(child);}
 // A correction inherits only its explicitly referenced kind; cycles or cross-kind replacements are uncertain.
 const resolvedKind=(key:string,seen=new Set<string>()):BusinessEventKind|null=>{
  if(seen.has(key)){for(const k of seen)conflicts.add(k);return null;}seen.add(key);
  const e=representative.get(key)!;if(!e.supersedes)return e.kind;
  const parent=keyById.get(e.supersedes);if(!parent)return null;
  const kind=resolvedKind(parent,seen);if(e.kind!=='correction'&&e.kind!==kind){conflicts.add(key);return null;}return kind;
 };
 const resolved=new Map([...groups.keys()].map(k=>[k,resolvedKind(k)]));
 // Propagate fork/cycle uncertainty through every descendant, including late corrections.
 let changed=true;while(changed){changed=false;for(const [parent,list] of children)if(conflicts.has(parent))for(const child of list)if(!conflicts.has(child)){conflicts.add(child);changed=true;}}
 type Row={key:string;event:BusinessEvent;ids:string[];kind:typeof buckets[number];uncertain:boolean};
 const active:Row[]=[];
 for(const [key,rows] of groups){const live=rows.filter(e=>!e.evidenceWithdrawn),e=live[0]??rows[0]!,kind=resolved.get(key);
  if(e.mode==='applied'||!e.asserted||!live.length||e.reverses||suppressed.has(key)||!buckets.includes(kind as typeof buckets[number]))continue;
  active.push({key,event:e,ids:rows.map(e=>e.id).sort(),kind:kind as typeof buckets[number],uncertain:conflicts.has(key)||e.transactionKey===null||e.quantity===null});
 }
 const transactions=new Map<string,Row[]>();for(const r of active)if(r.event.transactionKey!==null){const k=hash([r.kind,r.event.subject,r.event.transactionKey,r.event.quantity?.unitCode??null]);transactions.set(k,[...(transactions.get(k)??[]),r]);}
 for(const rows of transactions.values())if(rows.length>1)for(const r of rows){r.uncertain=true;conflicts.add(r.key);}
 const observed_state:Record<typeof buckets[number],ObservedWorkEntry[]>={ordered:[],dispatch:[],receipt:[],inspection:[],billing:[],payment:[]};
 for(const kind of buckets){const bySubject=new Map<string,Row[]>();for(const r of active.filter(r=>r.kind===kind)){const k=hash([r.event.subject,r.event.quantity?.unitCode??null]);bySubject.set(k,[...(bySubject.get(k)??[]),r]);}
  for(const rows of bySubject.values()){const first=rows[0]!.event,uncertain=rows.some(r=>r.uncertain);observed_state[kind].push({subject:first.subject,unitCode:first.quantity?.unitCode??null,quantity:uncertain?null:decimalText(rows.reduce((n,r)=>n+scaled(r.event.quantity!.value),0n)),eventIds:rows.flatMap(r=>r.ids).sort(),uncertain});}
  observed_state[kind].sort((a,b)=>a.subject.localeCompare(b.subject)||(a.unitCode??'').localeCompare(b.unitCode??''));
 }
 return {observed_state,watermark:ordered.reduce((n,e)=>Math.max(n,e.sequence),0),coverage:{auditCount:events.size,activeCount:active.length,withdrawnCount:ordered.filter(e=>e.evidenceWithdrawn).length,appliedCount:ordered.filter(e=>e.mode==='applied').length,unassertedCount:ordered.filter(e=>!e.asserted).length,ambiguousIdentityCount:ordered.filter(e=>e.transactionKey===null).length,conflictCount:conflicts.size,duplicateCount}};
}
