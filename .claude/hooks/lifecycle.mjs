#!/usr/bin/env node
// .claude/hooks/lifecycle.mjs — 차단하지 않는 훅 모음. hook_event_name으로 분기하며 항상 exit 0(fail-open).
//
//  SessionStart        재개에 필요한 최소 사실만 컨텍스트에 넣는다(AGENTS 1): 브랜치·HEAD·미커밋 변경·push 대기·최근 커밋·
//                      EXECUTION_STATE 핵심 줄·환경 경고(hooksPath, node_modules, Supabase project ref)·같은 HEAD의 검수 기록.
//                      검수자/서브에이전트 세션(agent_type)에는 아무것도 넣지 않는다.
//  PostToolUse         Edit|Write 직후: 바뀐 TS/JS 파일 하나만 biome lint, docs/EXECUTION_STATE.md 50줄 초과, migration 파일명 형식을
//                      additionalContext로 알린다(차단 없음, biome가 없으면 조용히 통과).
//  PostToolUseFailure  Agent 호출이 실패로 끝났을 때, 이 세션이 guard.mjs로 만든 flow-reviewer 예약만 되돌린다(중복 검수 방지는 유지).
//  Stop                제품 경로 파일이 커밋되지 않은 채 바뀌어 있는데 docs/EXECUTION_STATE.md가 그대로이거나 push 안 된 커밋이 있으면
//                      한 줄 알림(systemMessage). decision:block을 쓰지 않아 루프·강제 커밋이 없다(AGENTS 9·10).
// 비밀값·환경값·개인 경로를 출력하지 않는다. 시험: node --test tests/claude-hooks.test.mjs
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const slash = (value) => String(value).replaceAll("\\", "/");
const git = (cwd, args) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 8000 });
  return run.status === 0 ? (run.stdout ?? "").trim() : "";
};
// 저장소 devDependency인 biome 실행 파일을 cwd에서 위로 올라가며 찾는다(.claude/worktrees 안의 worktree는 본 저장소 것을 쓴다).
function findUp(cwd, relative) {
  let dir = cwd;
  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sessionStart(input, cwd) {
  if (input.agent_type) return; // 검수자·서브에이전트는 요청 패킷만 본다.
  const out = [];
  out.push(`[시공노트 세션 ${input.source ?? "startup"}] 재개 순서: AGENTS → docs/EXECUTION_STATE.md → git → 현재 N카드만. /briefing 재개, /ncard 단위 작업, /db-migration DB 변경, /handoff-check 인계 점검, /ui-pass 화면.`);
  const branch = git(cwd, ["branch", "--show-current"]) || "(detached)";
  const head = git(cwd, ["rev-parse", "--short", "HEAD"]) || "?";
  const changed = git(cwd, ["status", "--short"]).split(/\r?\n/).filter(Boolean);
  // 미추적 파일은 사용자 개인 자료일 수 있으므로 이름을 문맥에 넣지 않고 개수만 적는다(AGENTS 2). 추적 파일의 변경만 미리 보여 준다.
  const tracked = changed.filter((line) => !line.startsWith("??"));
  const untracked = changed.length - tracked.length;
  const preview = tracked.slice(0, 8).map((line) => line.trim()).join(", ") + (tracked.length > 8 ? " …" : "");
  out.push(`브랜치 ${branch} @ ${head} · 미커밋 변경 ${changed.length}개(추적 ${tracked.length}${untracked ? `, 미추적 ${untracked}` : ""})${tracked.length ? `: ${preview}` : ""}`);
  const ahead = git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (ahead && ahead !== "0") out.push(`push 대기 커밋 ${ahead}개 → 커밋은 즉시 push하고 원격 SHA를 확인합니다(AGENTS 6).`);
  const log = git(cwd, ["log", "-3", "--oneline"]);
  if (log) out.push(`최근 커밋: ${log.split(/\r?\n/).join(" | ")}`);
  try {
    const state = readFileSync(path.join(cwd, "docs", "EXECUTION_STATE.md"), "utf8").split(/\r?\n/);
    const keys = ["단계:", "현재 작업:", "현재 기준:", "보완 단위:", "다음 실행:"];
    out.push(`EXECUTION_STATE: ${state[0] ?? ""}`);
    for (const line of state) if (keys.some((key) => line.startsWith(key))) out.push(`  ${line.slice(0, 220)}`);
  } catch {
    out.push("경고: docs/EXECUTION_STATE.md 를 읽지 못했습니다.");
  }
  const warnings = [];
  const hooksPath = slash(git(cwd, ["config", "--get", "core.hooksPath"]));
  if (!/\.githooks\/?$/.test(hooksPath)) warnings.push("core.hooksPath가 .githooks가 아닙니다 → `git config core.hooksPath .githooks`");
  if (!findUp(cwd, "node_modules")) warnings.push("node_modules 없음 → `npm ci` 전에는 시험·lint 훅이 동작하지 않습니다");
  if (!process.env.SIGONGNOTE_SUPABASE_PROJECT_REF) warnings.push("SIGONGNOTE_SUPABASE_PROJECT_REF 미설정 → Supabase MCP 비활성(.claude/README.md 3절)");
  const full = git(cwd, ["rev-parse", "HEAD"]);
  if (full && existsSync(path.join(cwd, ".work", "claude-runs", "reviews", `${full}.json`))) warnings.push(`이 HEAD(${head})에 이미 독립 검수 세션 기록이 있습니다 → 중복 검수 금지, 그 결과를 재사용`);
  if (warnings.length) out.push(`경고: ${warnings.join(" / ")}`);
  out.push("금지 입력: 0.2 ver/, .env*(.env.example 제외), 키·인증서, .codex/, 사용자 미커밋 자료, 무관한 .work. 돈·DB·배포·push·외부 쓰기는 항상 확인을 받습니다.");
  process.stdout.write(`${out.join("\n")}\n`);
}

function postEdit(input, cwd) {
  const file = slash(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
  if (!file) return;
  const absolute = path.isAbsolute(file) ? file : path.join(cwd, file);
  const relative = slash(path.relative(cwd, absolute));
  const notes = [];
  if (relative === "docs/EXECUTION_STATE.md" && existsSync(absolute)) {
    const lines = readFileSync(absolute, "utf8").trim().split(/\r?\n/).length;
    if (lines > 50) notes.push(`docs/EXECUTION_STATE.md가 ${lines}줄입니다. 50줄 이하로 줄여야 node scripts/check-spec.mjs가 통과합니다(AGENTS 9).`);
  }
  if (/^supabase\/migrations\/[^/]+\.sql$/.test(relative) && !/^\d{14}_[a-z0-9_]+\.sql$/.test(path.basename(relative)))
    notes.push(`migration 파일명 ${path.basename(relative)}이 <14자리시각>_<snake_case>.sql 형식이 아닙니다. \`npx supabase migration new <이름>\`으로 만듭니다.`);
  const code = /\.(?:ts|tsx|mts|js|mjs|cjs|jsx)$/i.test(relative) && !/(?:^|\/)(?:node_modules|dist|build|generated)\//.test(relative) && !relative.startsWith("..");
  const biome = code && existsSync(absolute) ? findUp(cwd, path.join("node_modules", "@biomejs", "biome", "bin", "biome")) : null;
  if (biome) {
    const run = spawnSync(process.execPath, [biome, "lint", "--reporter=github", "--max-diagnostics=10", "--colors=off", absolute], { cwd, encoding: "utf8", timeout: 25000, windowsHide: true });
    if (!run.error) {
      const findings = `${run.stdout}\n${run.stderr}`
        .split(/\r?\n/)
        .filter((line) => /^::(?:error|warning)/.test(line))
        .map((line) => line.replace(/^::(\w+) title=([^,]+),file=([^,]+),line=(\d+)[^:]*::(.*)$/, (_, level, rule, _target, lineNo, message) => `${level} ${relative}:${lineNo} ${rule} — ${message}`));
      if (findings.length) {
        const errors = findings.filter((line) => line.startsWith("error")).length;
        notes.push(`biome lint — ${relative}: 오류 ${errors}건·경고 ${findings.length - errors}건(최대 10건 표시). 고친 뒤 npm run lint로 재확인.\n${findings.join("\n")}`);
      }
    }
  }
  if (notes.length) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes.join("\n") } })}\n`);
}

function reviewerUnlock(input, cwd) {
  if (input.tool_name !== "Agent" || input.tool_input?.subagent_type !== "flow-reviewer") return;
  const base = git(cwd, ["rev-parse", "HEAD"]);
  if (!base) return;
  const file = path.join(cwd, ".work", "claude-runs", "reviews", `${base}.json`);
  if (!existsSync(file)) return;
  const previous = JSON.parse(readFileSync(file, "utf8"));
  if (previous.source === "claude-code-agent" && previous.sessionId === (input.session_id ?? null)) unlinkSync(file);
}

function stopReminder(input, cwd) {
  if (input.stop_hook_active || input.agent_type) return;
  const status = git(cwd, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
  const paths = status.map((line) => line.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""));
  const product = paths.filter((p) => /^(?:apps|services|packages|supabase|scripts|tests)\//.test(p));
  const notes = [];
  if (product.length && !paths.includes("docs/EXECUTION_STATE.md"))
    notes.push(`제품 경로 ${product.length}개 파일이 커밋되지 않은 채 바뀌어 있고 docs/EXECUTION_STATE.md는 그대로입니다. 커밋 전에 상태 파일(50줄 이하)에 코드/연결/인수·검수·미검증을 반영하세요(AGENTS 7·9). 상태만을 위한 별도 커밋은 만들지 않습니다.`);
  const ahead = git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (ahead && ahead !== "0") notes.push(`push되지 않은 커밋 ${ahead}개가 있습니다. 커밋은 즉시 push하고 원격 SHA를 확인합니다(AGENTS 6).`);
  if (notes.length) process.stdout.write(`${JSON.stringify({ systemMessage: `알림: ${notes.join(" ")}` })}\n`);
}

try {
  const input = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, "") || "{}");
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd();
  const handlers = { SessionStart: sessionStart, PostToolUse: postEdit, PostToolUseFailure: reviewerUnlock, Stop: stopReminder };
  handlers[input.hook_event_name]?.(input, cwd);
} catch {
  // 조용히 통과. Windows 파이프 stdout은 비동기이므로 process.exit()로 끊지 않고 자연 종료로 flush한다.
}
