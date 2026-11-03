import { readFileSync } from "node:fs";
export function dependencyIds(text) {
  for (const range of text.matchAll(/([CRDN])\d{2}[–-]([CRDN])\d{2}/g)) {
    if (range[1] !== range[2]) throw new Error("Mixed-prefix dependency range");
  }
  const result=[];
  for (const match of text.matchAll(/([CRDN])(\d{2})([a-z]?)(?:[–-](?:[CRDN])?(\d{2}))?/g)) {
    if (match[4] && (match[3] || Number(match[4]) < Number(match[2]))) throw new Error("Invalid dependency range");
    for (let n=Number(match[2]); n<=Number(match[4] ?? match[2]); n++) result.push(`${match[1]}${String(n).padStart(2,"0")}${match[3]}`);
  }
  return result;
}
export function validateUnitGraph(units) {
  const ids=new Set(units.map(unit=>unit.id));
  if(ids.size!==units.length) throw new Error("Duplicate unit");
  const complete=new Set(["N00"]);
  for(const unit of units) for(const dep of dependencyIds(unit.dependencies)) {
    if(dep!=="N00" && !ids.has(dep)) throw new Error("Unknown dependency");
  }
  let pending=[...units];
  while(pending.length) {
    const ready=pending.filter(unit=>dependencyIds(unit.dependencies).every(dep=>complete.has(dep)));
    if(!ready.length) throw new Error("Cyclic dependency");
    for(const unit of ready)complete.add(unit.id);
    pending=pending.filter(unit=>!complete.has(unit.id));
  }
}
export function validateCompleted(units, completed) {
  if (new Set(completed).size !== completed.length) throw new Error("Duplicate completed unit");
  for (const id of completed) {
    const unit = units.find(item => item.id === id);
    if (!unit) throw new Error("Unknown completed unit");
    for (const dependency of dependencyIds(unit.dependencies)) if (dependency!=="N00" && !completed.includes(dependency)) throw new Error("Completed unit has blocked dependency");
  }
  return completed.length;
}
export function readPlanUnits(plan = readFileSync("docs/AGENT_SPEC.md","utf8")) {
 if (plan.includes("## E 기능 단위 커밋과 의존성")) plan=plan.split("## E 기능 단위 커밋과 의존성")[1].split("### 실행 묶음")[0];
 return [...plan.matchAll(/^\| ([CRDN]\d{2}[a-z]?)(?: [^|]*)? \| ([^|]+) \|/gm)].map(match => ({id:match[1],dependencies:match[2].trim()}));
}
export function validateExecutionState(state, units) {
 if (state.trim().split("\n").length > 50) throw new Error("Execution state exceeds 50 lines");
 if (units.length === 0) {
  if (!/^단계: DESIGN\r?$/m.test(state) || !/^완료 단위: 해당없음\r?$/m.test(state) || !/^완료 단위 수: 산정 전\r?$/m.test(state)) throw new Error("Design phase cannot claim implementation progress");
  return 0;
 }
 // Implementation history survives an audit reopening a unit. It is not acceptance.
 const history = /^구현 이력:/m.test(state);
 if (history && /^완료 단위(?: 수)?:/m.test(state)) throw new Error("Mixed history and completion labels");
 const completedLine = state.match(history ? /^구현 이력: (.+)$/m : /^완료 단위: (.+)$/m)?.[1].trim();
 if (!completedLine || (completedLine !== "없음" && !/^[CRDN]\d{2}[a-z]?(?:[ ,]+[CRDN]\d{2}[a-z]?)*$/.test(completedLine))) throw new Error("Invalid completed unit list");
 if (units.some(unit => /^[DN]/.test(unit.id)) && !/^단계: IMPLEMENTATION\r?$/m.test(state)) throw new Error("D/N units require implementation phase");
 const done = completedLine.match(/[CRDN]\d{2}[a-z]?/g) ?? [];
 const count = validateCompleted(units, done);
 const actual = state.match(history ? /^구현 이력 수: (\d+)\/(\d+)\r?$/m : /^완료 단위 수: (\d+)\/(\d+)\r?$/m);
 if (!actual || Number(actual[1]) !== count || Number(actual[2]) !== units.length) throw new Error("Completion count mismatch");
 if(history){
  const reopened=state.match(/^보완 단위: (.+)$/m)?.[1].trim();
  if(!reopened || (reopened!=='없음'&&!/^[CRDN]\d{2}[a-z]?(?:,[CRDN]\d{2}[a-z]?)*$/.test(reopened)))throw new Error('Invalid reopened unit list');
  const ids=reopened.match(/[CRDN]\d{2}[a-z]?/g)??[];
  if(new Set(ids).size!==ids.length||ids.some(id=>!done.includes(id)))throw new Error('Reopened unit must have unique implementation history');
 }
 return count;
}
export function checkExecutionState() {
 const state = readFileSync("docs/EXECUTION_STATE.md","utf8");
 const units = readPlanUnits();
 // Contiguous N01..Nmax roots (sub-units allowed). The spec decides the scope size; a gap or a stray prefix is an error.
 const roots=[...new Set(units.map(unit=>unit.id.slice(0,3)))].sort();
 if (units.some(unit=>!/^N\d{2}[a-z]?$/.test(unit.id)) || roots.length===0 || roots.some((root,index)=>root!==`N${String(index+1).padStart(2,"0")}`)) throw new Error("Expected contiguous N01-Nmax implementation scope");
 validateUnitGraph(units);
 return validateExecutionState(state,units);
}
