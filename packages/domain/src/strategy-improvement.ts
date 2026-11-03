import {z} from 'zod';
import {partitionLearning,learningGroups,type LearningDatum} from './improvement.js';
import {ReadToolSchema,canonicalReadInput} from './evidence-search-input.js';

export const StrategyScopeSchema=z.enum(['search','tool_selection']);
export type StrategyScope=z.infer<typeof StrategyScopeSchema>;
export const StrategyValueSchema=z.strictObject({tool:ReadToolSchema,query:z.string().trim().max(2000)});
export type StrategyValue=z.infer<typeof StrategyValueSchema>;
export const StrategySpecSchema=z.discriminatedUnion('scope',[
 z.strictObject({scope:z.literal('search'),version:z.literal('search-query-v1'),rules:z.array(z.strictObject({from:z.string().min(1).max(2000),to:z.string().min(1).max(2000)})).min(1).max(20)}),
 z.strictObject({scope:z.literal('tool_selection'),version:z.literal('read-tool-v1'),rules:z.array(z.strictObject({instruction:z.string().min(1).max(2000),from:ReadToolSchema,to:ReadToolSchema})).min(1).max(20)})
]);
export type StrategySpec=z.infer<typeof StrategySpecSchema>;
export type StrategyDatum={id:string;tenant:string;group:string;project:string;sourceHashes:string[];createdAt:string;instruction:string;baseline:StrategyValue;expected:StrategyValue;relevant:string[]};
const normalized=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase();
const grouped=(data:StrategyDatum[]):LearningDatum[]=>data.map(d=>({...d,version:1,period:d.createdAt,sourceText:'',proposal:[],expected:[],state:'confirmed'}));
export function partitionStrategy(data:StrategyDatum[]){return partitionLearning(grouped(data));}
export function independentStrategyGroups(data:StrategyDatum[]){return learningGroups(grouped(data)).map(g=>g.map(d=>d.id));}
/** Only training labels may enter candidate construction. Conflicting corrections produce no rule. */
export function proposeStrategy(scope:StrategyScope,training:StrategyDatum[]):StrategySpec|null{
 const targets=new Map<string,Set<string>>();
 for(const d of training){
  if(scope==='search'){
   if(d.baseline.tool!=='search_evidence'||d.expected.tool!=='search_evidence'||!d.expected.query||normalized(d.baseline.query)===normalized(d.expected.query))continue;
   const key=normalized(d.baseline.query);if(!key)continue;const values=targets.get(key)??new Set<string>();values.add(d.expected.query);targets.set(key,values);
  }else{if(d.baseline.tool===d.expected.tool)continue;const key=JSON.stringify([normalized(d.instruction),d.baseline.tool]);const values=targets.get(key)??new Set<string>();values.add(d.expected.tool);targets.set(key,values);}
 }
 const rules=[...targets].filter(([,v])=>v.size===1).sort(([a],[b])=>a.localeCompare(b)).slice(0,20).map(([from,to])=>scope==='search'?{from,to:[...to][0]}:{instruction:JSON.parse(from)[0],from:JSON.parse(from)[1],to:[...to][0]});
 return rules.length?StrategySpecSchema.parse({scope,version:scope==='search'?'search-query-v1':'read-tool-v1',rules}):null;
}
export function predictStrategy(instruction:string,baseline:StrategyValue,spec:StrategySpec):StrategyValue{
 if(spec.scope==='search'){
  if(baseline.tool!=='search_evidence')return {...baseline};const matches=spec.rules.filter(r=>r.from===normalized(baseline.query));return matches.length===1?{...baseline,query:matches[0]!.to}:{...baseline};
 }
 const matches=spec.rules.filter(r=>r.instruction===normalized(instruction)&&r.from===baseline.tool);if(matches.length!==1)return {...baseline};const tool=matches[0]!.to;
 if((tool==='search_evidence'||tool==='resolve_entities')&&!baseline.query.trim())return {...baseline};
 return {tool,query:tool==='search_evidence'||tool==='resolve_entities'?baseline.query:''};
}
/** Tool routing never drops nontrivial filters/IDs or rewrites an effect tool. */
export function applyStrategyCalls<T extends {tool:string;input:string}>(instruction:string,calls:T[],spec:StrategySpec,project:string|null=null):T[]{
 if(spec.scope==='tool_selection'&&calls.length!==1)return calls;
 return calls.map(call=>{
  if(!ReadToolSchema.safeParse(call.tool).success)return call;
  let input:Record<string,unknown>;try{input=JSON.parse(call.input);if(!input||typeof input!=='object'||Array.isArray(input))return call;}catch{return call;}
  if(spec.scope==='search'){
   if(call.tool!=='search_evidence'||typeof input.query!=='string')return call;
   const after=predictStrategy(instruction,{tool:'search_evidence',query:input.query},spec);return {...call,input:JSON.stringify({...input,query:after.query})};
  }
  if(!canonicalReadInput(call.tool,input,project))return call;
  const before={tool:ReadToolSchema.parse(call.tool),query:typeof input.query==='string'?input.query:''},after=predictStrategy(instruction,before,spec);
  if(after.tool===before.tool)return call;
  return {...call,tool:after.tool,input:JSON.stringify(after.tool==='search_evidence'?{query:after.query,...(input.project_id?{project_id:input.project_id}:{})}:after.tool==='resolve_entities'?{query:after.query}:{})};
 });
}
export function strategyScore(data:StrategyDatum[],predictions:{value:StrategyValue;ids:string[]}[],scope:StrategyScope,baselineIds:string[][],shadow=false){
 if(data.length!==predictions.length||data.length!==baselineIds.length)throw Error('INCOMPLETE_EVALUATION');
 const equalIds=(a:string[],b:string[])=>JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());
 const correct=(d:StrategyDatum,p:{value:StrategyValue;ids:string[]})=>scope==='search'?p.value.tool==='search_evidence'&&equalIds(p.ids,d.relevant):p.value.tool===d.expected.tool;
 let errors=0,baselineErrors=0,applied=0;data.forEach((d,i)=>{if(!correct(d,predictions[i]!))errors++;if(!correct(d,{value:d.baseline,ids:baselineIds[i]!}))baselineErrors++;if(JSON.stringify(d.baseline)!==JSON.stringify(predictions[i]!.value))applied++;});
 const groups=independentStrategyGroups(data).length;
 return {samples:data.length,groups,errors,baseline_errors:baselineErrors,improvement:baselineErrors-errors,applied_samples:applied,protected_changes:0,high_confidence_errors:errors,passed:groups>=1&&errors===0&&applied>0&&(shadow||baselineErrors-errors>=1)};
}
