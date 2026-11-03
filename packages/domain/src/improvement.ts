import {z} from 'zod';
import {canonicalValue} from './canonical-value.js';
import {WorkEffectSchema,type WorkEffect} from './work-decisions.js';

// Initial delegated scope is deliberately small: evidence-exact quality wording.
// Amounts, dates, quantities, recipients and automatic eligibility are unchanged.
export const ImprovementSpecSchema=z.strictObject({
 scope:z.literal('quality_interpretation'),prompt_version:z.literal('evidence-quality-v1'),
 rules:z.array(z.strictObject({from:z.string().trim().min(1).max(200),to:z.string().trim().min(1).max(200)})).max(20)
});
export type ImprovementSpec=z.infer<typeof ImprovementSpecSchema>;
export const EvaluationCriteriaSchema=z.strictObject({version:z.literal('work-eval-v1'),min_test_groups:z.number().int().min(1).max(20),min_shadow_groups:z.number().int().min(1).max(20),max_errors:z.literal(0),max_protected_changes:z.literal(0),max_high_confidence_errors:z.literal(0),min_improvement:z.number().int().min(1).max(50)});
export type EvaluationCriteria=z.infer<typeof EvaluationCriteriaSchema>;
export type LearningDatum={id:string;version:number;tenant:string;project:string;group:string;period:string;sourceHashes:string[];sourceText:string;proposal:WorkEffect[];expected:WorkEffect[];state:'confirmed'|'correction';createdAt:string};
export type EvalInput={sourceText:string;proposal:WorkEffect[]};
export const EvalPredictionSchema=z.strictObject({effects:z.array(WorkEffectSchema).max(6),confidence:z.number().min(0).max(1)});
export type EvalPrediction=z.infer<typeof EvalPredictionSchema>;
/** A local model can implement this read-only shadow port; it never receives test labels. */
export type LocalEvaluationPort={name:string;kind:'local';predict:(input:Readonly<EvalInput>,spec:Readonly<ImprovementSpec>,signal:AbortSignal)=>Promise<EvalPrediction>};
export const evaluationEqual=(a:unknown,b:unknown)=>JSON.stringify(canonicalValue(a))===JSON.stringify(canonicalValue(b));

/** Same work OR same source bytes is a single indivisible group, even across periods/sites. */
export function learningGroups(data:LearningDatum[]){
 if(!data.length)return [];
 if(new Set(data.map(x=>x.tenant)).size!==1||new Set(data.map(x=>x.id)).size!==data.length)throw Error('DATASET_SCOPE');
 const parents=data.map((_,i)=>i),root=(i:number):number=>parents[i]===i?i:root(parents[i]!);
 for(let i=0;i<data.length;i++)for(let j=0;j<i;j++){const a=data[i]!,b=data[j]!;if(a.group===b.group||a.sourceHashes.some(h=>b.sourceHashes.includes(h)))parents[root(i)]=root(j);}
 const grouped=new Map<number,LearningDatum[]>();data.forEach((d,i)=>{const r=root(i),g=grouped.get(r)??[];g.push(d);grouped.set(r,g);});
 const groups=[...grouped.values()].map(g=>g.sort((a,b)=>a.id.localeCompare(b.id))).sort((a,b)=>a[0]!.id.localeCompare(b[0]!.id));
 return groups;
}
export function partitionLearning(data:LearningDatum[]){
 const groups=learningGroups(data);if(groups.length<2)throw Error('INDEPENDENT_GROUPS_REQUIRED');
 const n=Math.max(1,Math.floor(groups.length/3));
 return groups.flatMap((g,i)=>g.map(d=>({id:d.id,version:d.version,group:g[0]!.id,split:i<n?'test' as const:'train' as const})));
}
export function proposeImprovement(training:LearningDatum[]):ImprovementSpec{
 const targets=new Map<string,Set<string>>();
 for(const d of training){if(d.state!=='correction'||d.proposal.length!==d.expected.length)continue;
  for(let i=0;i<d.proposal.length;i++){const from=d.proposal[i]!,to=d.expected[i]!;
   if(from.kind!=='quality'||to.kind!=='quality'||from.action===to.action||!d.sourceText.includes(to.action))continue;
   const values=targets.get(from.action)??new Set<string>();values.add(to.action);targets.set(from.action,values);
  }
 }
 return ImprovementSpecSchema.parse({scope:'quality_interpretation',prompt_version:'evidence-quality-v1',rules:[...targets].filter(([,v])=>v.size===1).sort(([a],[b])=>a.localeCompare(b)).slice(0,20).map(([from,to])=>({from,to:[...to][0]}))});
}
export function interpretImprovement(input:EvalInput,spec:ImprovementSpec):EvalPrediction{
 const checked=ImprovementSpecSchema.parse(spec);let changed=false;
 const effects=input.proposal.map(e=>{if(e.kind!=='quality')return {...e};const matches=checked.rules.filter(r=>r.from===e.action&&input.sourceText.includes(r.to));if(matches.length!==1)return {...e};changed=true;return {kind:'quality' as const,action:matches[0]!.to};});
 return {effects,confidence:changed?1:0.5};
}
/** Every effect outside the approved field is preserved byte-for-byte. */
export function withinImprovementScope(input:EvalInput,prediction:EvalPrediction){
 return input.proposal.length===prediction.effects.length&&input.proposal.every((before,i)=>{
  const after=prediction.effects[i]!;if(before.kind==='quality'&&after.kind==='quality')return before.action===after.action||input.sourceText.includes(after.action);
  return evaluationEqual(before,after);
 });
}
export function scoreImprovement(data:LearningDatum[],predictions:EvalPrediction[],criteria:EvaluationCriteria,safetyOnly=false){
 const c=EvaluationCriteriaSchema.parse(criteria);if(data.length!==predictions.length)throw Error('INCOMPLETE_EVALUATION');
 const errors:string[]=[],highConfidenceErrors:string[]=[],protectedChanges:string[]=[];let baselineErrors=0;
 for(let i=0;i<data.length;i++){const d=data[i]!,p=EvalPredictionSchema.parse(predictions[i]);if(!evaluationEqual(d.proposal,d.expected))baselineErrors++;
  if(!evaluationEqual(p.effects,d.expected)){errors.push(d.id);if(p.confidence>=0.9)highConfidenceErrors.push(d.id);}
  if(!withinImprovementScope(d,p))protectedChanges.push(d.id);
 }
 return {samples:data.length,groups:new Set(data.map(d=>d.group)).size,baseline_errors:baselineErrors,errors:errors.length,high_confidence_errors:highConfidenceErrors,protected_changes:protectedChanges,error_cases:errors,improvement:baselineErrors-errors.length,
  passed:data.length>0&&new Set(data.map(d=>d.group)).size>=c.min_test_groups&&errors.length===0&&protectedChanges.length===0&&highConfidenceErrors.length===0&&baselineErrors-errors.length>=(safetyOnly?0:c.min_improvement)};
}
