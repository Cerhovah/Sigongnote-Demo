import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inspectStaged, inspectContent } from "../scripts/check-staged.mjs";
import { validateCompleted, validateExecutionState, readPlanUnits, validateUnitGraph, checkExecutionState } from "../scripts/execution-state.mjs";

test('audit history preserves implemented dependencies while explicitly reopening unmet scope',()=>{
 const units=[{id:'N01',dependencies:'N00'},{id:'N02',dependencies:'N01'},{id:'N03',dependencies:'N02'}];
 const history='단계: IMPLEMENTATION\n구현 이력: N01,N02\n구현 이력 수: 2/3\n';
 assert.equal(validateExecutionState(history+'보완 단위: N02',units),2);
 assert.equal(validateExecutionState(history+'보완 단위: 없음',units),2);
 for(const line of ['', '보완 단위: N03','보완 단위: N02,N02','보완 단위: N02x'])assert.throws(()=>validateExecutionState(history+line,units));
 assert.throws(()=>validateExecutionState(history+'보완 단위: N02\n완료 단위: N01,N02',units),/Mixed/);
 assert.throws(()=>validateExecutionState(history.replace('2/3','3/3')+'보완 단위: N02',units),/count mismatch/);
});

test("blocked dependencies never count as completed even when later units are attempted", () => {
 const plan = [{id:"C01", dependencies:"없음"},{id:"C02",dependencies:"C01"},{id:"C09",dependencies:"C04,C07"}];
 assert.equal(validateCompleted(plan,["C01","C02"]),2);
 assert.throws(() => validateCompleted(plan,["C01","C02","C09"]),/blocked dependency/);
 assert.throws(() => validateCompleted(plan,["C01","C01"]),/Duplicate/);
});

test("D implementation dependencies do not turn external evidence into product completion", () => {
 const units = readPlanUnits("| D01 | 없음 | capture |\n| D02 | D01 | bind |\n| D03 | D01–D02 | scan |");
 assert.equal(units.length,3);
 assert.equal(validateExecutionState("단계: IMPLEMENTATION\n완료 단위: D01,D02\n완료 단위 수: 2/3",units),2);
 assert.throws(() => validateExecutionState("단계: IMPLEMENTATION\n완료 단위: D03\n완료 단위 수: 1/3",units),/blocked dependency/);
 assert.throws(() => validateExecutionState("단계: DESIGN\n완료 단위: D01\n완료 단위 수: 1/3",units),/implementation phase/);
 assert.throws(() => validateExecutionState("단계: IMPLEMENTATION\n완료 단위: C01\n완료 단위 수: 1/3",units),/Unknown/);
});

test("design state rejects inherited implementation progress and premature unit plans", () => {
 const units = readPlanUnits("");
 assert.equal(units.length,0);
 assert.equal(validateExecutionState("단계: DESIGN\n완료 단위: 해당없음\n완료 단위 수: 산정 전",units),0);
 assert.throws(() => validateExecutionState("완료 단위: C01\n완료 단위 수: 37/48",units),/cannot claim/);
 assert.throws(() => validateExecutionState("단계: DESIGN\n완료 단위: 없음\n완료 단위 수: 0/18",units),/cannot claim/);
 const future=[{id:"R01",dependencies:"없음"},{id:"R02",dependencies:"R01"}];
 assert.throws(() => validateExecutionState("완료 단위: R02\n완료 단위 수: 1/2",future),/blocked dependency/);
 assert.throws(() => validateExecutionState("완료 단위: R01\n완료 단위 수: 37/48",future),/Completion count/);
 assert.throws(() => validateCompleted([{id:"R03",dependencies:"R01–R02"}], ["R03"]),/blocked dependency/);
 assert.throws(() => validateCompleted([{id:"C01",dependencies:"없음"},{id:"C02",dependencies:"없음"},{id:"R03",dependencies:"C01–R02"}], ["C01","C02","R03"]),/Mixed-prefix/);
});

test("N execution reads current specification and rejects stale, cyclic and blocked completion", () => {
 const units=readPlanUnits();
 assert.equal(units.length,12);
 assert.equal(units[0]?.id,"N01");
 assert.equal(units[0]?.dependencies,"N00");
 assert.doesNotThrow(()=>checkExecutionState());
 assert.equal(validateCompleted(units,["N01"]),1);
 assert.throws(()=>validateCompleted(units,["N03"]),/blocked dependency/);
 assert.throws(()=>validateCompleted(units,["D01"]),/Unknown/);
 assert.throws(()=>validateUnitGraph([{id:"N01",dependencies:"N02"},{id:"N02",dependencies:"N01"}]),/Cyclic/);
 assert.throws(()=>validateUnitGraph([{id:"N01",dependencies:"N32"}]),/Unknown dependency/);
 assert.throws(()=>validateUnitGraph([{id:"N01",dependencies:"N00"},{id:"N01",dependencies:"N00"}]),/Duplicate/);
 assert.equal(validateExecutionState(`단계: IMPLEMENTATION\n완료 단위: N01\n완료 단위 수: 1/${units.length}`,units),1);
 assert.throws(()=>validateExecutionState("단계: IMPLEMENTATION\n완료 단위: N01\n완료 단위 수: 6/20",units),/Completion count/);
});

test("staged environment, original document and embedded credential cannot pass push gate", () => {
  mkdirSync(".work", { recursive: true });
  const cwd = mkdtempSync(join(process.cwd(), ".work", "privacy-test-"));
  const git = (...args: string[]) => {
    assert.equal(spawnSync("git", args, { cwd, encoding: "utf8" }).status, 0);
  };
  git("init", "-q");
  writeFileSync(join(cwd, ".env"), "EXAMPLE=value");
  writeFileSync(join(cwd, "sample.hwp"), "synthetic unapproved binary");
  writeFileSync(join(cwd, "leak.ts"), 'export const url = "' + "postgresql:" + "//test:fake@host/db" + '";');
  git("add", ".");
  const findings = inspectStaged(cwd);
  assert.deepEqual(findings.map(x => x.path).sort(), [".env", "leak.ts", "sample.hwp"]);
  git("config","core.hooksPath",join(process.cwd(),".githooks"));
  const commitArgs = ["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"];
  assert.notEqual(spawnSync("git",commitArgs,{cwd,encoding:"utf8"}).status,0);
  git(...commitArgs,"--no-verify");
  const bare = join(cwd,"remote.git");
  git("init","--bare","-q",bare);
  git("remote","add","test",bare);
  assert.notEqual(spawnSync("git",["push","test","HEAD:refs/heads/test"],{cwd,encoding:"utf8"}).status,0);
  assert.notEqual(spawnSync("git",["--git-dir",bare,"rev-parse","--verify","refs/heads/test"],{cwd,encoding:"utf8"}).status,0);
});

test("binary sources and current secret formats are rejected before transmission", () => {
 assert.deepEqual(inspectContent(".env.example",Buffer.from("AI_API_KEY=\nAI_MODEL_SMALL=\nDATABASE_URL=\nLOG_LEVEL=info\n")),[]);
 for (const ext of ["zip","jpg","heic","csv","docx","amr","3gp"]) assert.equal(inspectContent(`sample.${ext}`,Buffer.from("synthetic")).length,1);
 assert.equal(inspectContent("sample.dat",Buffer.from([0,1,2])).length,1);
 for (const fake of ["sb_"+"secret_"+"a".repeat(30),"eyJ"+"a".repeat(12)+"."+"b".repeat(16)+"."+"c".repeat(16)]) assert.equal(inspectContent("sample.ts",Buffer.from(fake)).length,1);
});
