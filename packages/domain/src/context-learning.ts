export const CONTEXT_READING_PROCEDURE='recent-project-consensus-v1';
export const CONTEXT_READING_HINT='최근 일지를 먼저 읽고 현장 후보가 한 곳으로 일치하는지 확인한다. 현장 목록과 해당 근거의 현재 판을 다시 읽는다. 서로 다른 현장이나 확인되지 않은 근거가 있으면 현장을 특정하지 않는다. 이전 교정의 현장이나 문구를 새 사건에 그대로 적용하지 않는다.';
export type ContextLearningCase={id:string;family:string;sourceVersion:string;correctedAt:string;adoptedAt:string|null;state:string;targetProject:string|null;previousProject:string|null;eligible:boolean};
export type ContextReadingCandidate={rule:string;trainIds:string[];trainFamilies:string[];createdAt:string};
export type ContextReadingEvidence={kind:string;id:string;version:string;family?:string;projectId:string|null;receivedAt:string};
export type ContextReadingShadow={caseId?:string;family:string;sourceVersion:string;receivedAt:string;observedAt:string;projectId:string|null};
/** Learning independence is conservative: equal bytes and revisions of one document share a split. It never merges business records. */
export function contextReadingLeakageKeys(source:{family:string;sourceVersion:string}){
 const sha256=source.sourceVersion.split(':')[1];
 return sha256&&/^[a-f0-9]{64}$/.test(sha256)?[source.family,`sha256:${sha256}`]:[];
}
export function makeContextReadingCandidate(cases:ContextLearningCase[],createdAt:string):ContextReadingCandidate{
 const keys=cases.flatMap(contextReadingLeakageKeys);
 if(!cases.length||cases.length>20||cases.some(c=>c.state!=='adopted'||!c.adoptedAt||!c.eligible||!c.targetProject||c.correctedAt>createdAt||c.adoptedAt>createdAt||contextReadingLeakageKeys(c).length!==2)||new Set(keys).size!==keys.length)throw new Error('INVALID_CONTEXT_TRAINING_CASES');
 return {rule:CONTEXT_READING_PROCEDURE,trainIds:cases.map(c=>c.id),trainFamilies:keys,createdAt};
}
/** A shadow proposes a site only from independently read, unambiguous earlier evidence. */
export function contextReadingPrediction(input:{family:string;sourceVersion:string;receivedAt:string},evidence:ContextReadingEvidence[]){
 const keys=contextReadingLeakageKeys(input);
 if(keys.length!==2)return null;
 const rows=evidence.filter(e=>!contextReadingLeakageKeys({family:e.family??`${e.kind}:${e.id}`,sourceVersion:e.version}).some(key=>keys.includes(key))&&e.receivedAt<=input.receivedAt);
 const projects=new Set(rows.map(e=>e.projectId));
 return rows.length>0&&rows.length<=20&&projects.size===1&&!projects.has(null)?rows[0]!.projectId:null;
}
/** Labels are accepted only after the pre-correction shadow, on later independent source families. */
export function evaluateContextReading(candidate:ContextReadingCandidate,cases:ContextLearningCase[],shadows:ContextReadingShadow[]){
 let leakage=0,wrong=0,matched=0,abstained=0,improved=0;const families=new Set<string>(),seenKeys=new Set<string>(),caseIds:string[]=[];
 for(const c of cases){
  if(c.state!=='adopted'||!c.eligible||!c.adoptedAt||!c.targetProject)continue;
  const observations=shadows.filter(s=>s.family===c.family&&s.sourceVersion===c.sourceVersion);
  if(!observations.length)continue;
  const keys=contextReadingLeakageKeys(c);
  if(keys.length!==2)continue;
  if(keys.some(key=>candidate.trainFamilies.includes(key))||candidate.trainIds.includes(c.id)){leakage++;continue;}
  const s=observations.filter(s=>s.receivedAt>candidate.createdAt&&s.observedAt>=candidate.createdAt&&s.observedAt<c.correctedAt&&c.adoptedAt!>=s.observedAt).sort((a,b)=>a.observedAt.localeCompare(b.observedAt))[0];
  if(!s)continue;
  if(keys.some(key=>seenKeys.has(key)))continue;keys.forEach(key=>seenKeys.add(key));families.add(c.family);caseIds.push(c.id);
  if(s.projectId===null)abstained++;else if(s.projectId===c.targetProject){matched++;if(c.previousProject!==c.targetProject)improved++;}else wrong++;
 }
 const independent=families.size;
 return {rule:candidate.rule,caseIds,independent,matched,wrong,abstained,improved,leakage,canPromote:candidate.rule===CONTEXT_READING_PROCEDURE&&independent>=3&&matched>=3&&wrong===0&&abstained===0&&improved>0&&leakage===0,scope:'read_evidence_only',businessEffectsChanged:false};
}
