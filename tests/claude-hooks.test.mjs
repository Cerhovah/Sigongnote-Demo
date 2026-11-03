// .claude/hooks/guard.mjs · lifecycle.mjs 훅의 국소시험. 실행: npm run test:hooks 또는 node --test tests/claude-hooks.test.mjs (저장소 루트에서)
// 훅은 stdin JSON을 받아 stdout에 결정 JSON(또는 문맥 텍스트)을 내고 항상 exit 0으로 끝나야 한다.
// Git 쓰기 규칙은 임시 저장소에서 검사하므로 실제 저장소의 index·.work 예약을 건드리지 않는다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const hooksDir = process.env.CLAUDE_HOOKS_DIR ?? path.join(".claude", "hooks");
const repo = process.cwd();

function run(script, input, cwd = repo) {
  const result = spawnSync(process.execPath, [path.resolve(repo, hooksDir, script)], {
    input: JSON.stringify({ cwd, session_id: "test-session", ...input }),
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, `${script} exit ${result.status}: ${result.stderr}`);
  const text = result.stdout.trim();
  return text.startsWith("{") ? JSON.parse(text) : text;
}
const shell = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
const file = (tool, tool_input) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input });
const decision = (output) => output?.hookSpecificOutput?.permissionDecision ?? "pass";

// 임시 git 저장소: hooksPath=.githooks + pre-commit 존재, 커밋 1개(a.txt, docs/note.md).
// 브랜치 `docs`(추적 폴더와 같은 이름)와 `scratch`(미추적 폴더와 같은 이름)를 만들어 checkout 휴리스틱을 검사한다.
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sigongnote-hooks-"));
  const g = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  fs.mkdirSync(path.join(dir, ".githooks"));
  fs.writeFileSync(path.join(dir, ".githooks", "pre-commit"), "#!/bin/sh\n");
  g("config", "core.hooksPath", ".githooks");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "note.md"), "n\n");
  g("add", "a.txt", "docs/note.md");
  g("commit", "-q", "-m", "init");
  g("branch", "docs");
  fs.mkdirSync(path.join(dir, "scratch"));
  fs.writeFileSync(path.join(dir, "scratch", "tmp.txt"), "t\n");
  g("branch", "scratch");
  return dir;
}

test("hook scripts parse and settings.json is valid JSON with the guard wired in", () => {
  for (const script of ["guard.mjs", "lifecycle.mjs"]) {
    const check = spawnSync(process.execPath, ["--check", path.resolve(repo, hooksDir, script)], { encoding: "utf8" });
    assert.equal(check.status, 0, `${script}: ${check.stderr}`);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.hooks?.PreToolUse?.some((entry) => /Bash/.test(entry.matcher) && entry.hooks.some((h) => /guard\.mjs/.test(h.command) && /systemMessage/.test(h.command))), "shell guard warns the user (fail-open) when its script is missing");
  // worktree 세션에서는 ${CLAUDE_PROJECT_DIR}가 세션을 시작한 메인 체크아웃에 고정되므로(공식 hooks·worktrees 문서)
  // 모든 훅 명령이 '현재 체크아웃(git 최상위) → CLAUDE_PROJECT_DIR → PWD' 폴백 체인으로 스크립트를 찾아야 한다.
  for (const [event, entries] of Object.entries(settings.hooks))
    for (const entry of entries)
      for (const h of entry.hooks) {
        assert.equal(h.shell, "bash", `${event}: hook shell is Git Bash`);
        assert.match(h.command, /git rev-parse --show-toplevel/, `${event}: current checkout is searched first`);
        assert.match(h.command, /\$\{CLAUDE_PROJECT_DIR\}/, `${event}: project dir is the fallback`);
      }
  for (const rule of ["Bash(git switch --discard-changes*)", "Bash(git checkout -f*)", "Bash(git switch -f*)"]) assert.ok(settings.permissions.deny.includes(rule), rule);
  for (const rule of ["Bash(git branch --delete*)", "Bash(git branch --force*)"]) assert.ok(settings.permissions.ask.includes(rule), rule);
});

// Git Bash(훅 셸)를 찾는다. git --exec-path에서 설치 루트로 거슬러 올라가며, 없으면 아래 폴백 시험은 건너뛴다(WSL bash를 쓰지 않는다).
function findBash() {
  if (process.platform !== "win32") return "bash";
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout?.trim() ?? "";
  const root = execPath ? path.resolve(execPath, "..", "..", "..") : "";
  return [root && path.join(root, "bin", "bash.exe"), root && path.join(root, "usr", "bin", "bash.exe"), "C:\\Program Files\\Git\\bin\\bash.exe"].find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}
const bash = findBash();
function hookCommand(event, matcher = "") {
  const settings = JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
  return settings.hooks[event].find((entry) => new RegExp(matcher).test(entry.matcher ?? "")).hooks[0].command;
}
// settings.json의 훅 명령을 그대로 Git Bash로 실행한다. CLAUDE_PROJECT_DIR는 존재하지 않는 폴더로 두어 'worktree 세션 + 메인에 파일 없음'을 흉내 낸다.
const viaBash = (command, cwd, input) =>
  spawnSync(bash, ["-c", command], { cwd, encoding: "utf8", input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: path.join(os.tmpdir(), "sigongnote-no-such-project-dir") }, timeout: 30000 });

test("hook commands find the scripts in the current checkout when CLAUDE_PROJECT_DIR has none (worktree sessions)", { skip: bash ? false : "Git Bash not found" }, () => {
  const guard = hookCommand("PreToolUse", "Bash");
  const passed = viaBash(guard, repo, shell("git status --short", { cwd: repo }));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout.trim(), "", "ordinary command passes through the guard found in the current checkout");
  const denied = viaBash(guard, repo, shell("git push --force", { cwd: repo }));
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(decision(JSON.parse(denied.stdout)), "deny", "deny JSON still flows through the fallback chain");
  const brief = viaBash(hookCommand("SessionStart"), repo, { hook_event_name: "SessionStart", source: "startup", cwd: repo });
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /브랜치 /, "lifecycle briefing runs from the current checkout");
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), "sigongnote-nohooks-"));
  const blocked = viaBash(guard, nowhere, shell("git status", { cwd: nowhere }));
  assert.equal(blocked.status, 0, "shell guard fails open when no checkout has the script");
  assert.match(JSON.parse(blocked.stdout).systemMessage, /guard\.mjs 없음/, "and tells the user via systemMessage");
  const quiet = viaBash(hookCommand("SessionStart"), nowhere, { hook_event_name: "SessionStart", source: "startup", cwd: nowhere });
  assert.equal(quiet.status, 0, "fail-open hooks exit 0 even when the script is nowhere");
});

test("guard denies forbidden inputs, secret exposure and protection bypass", () => {
  const dir = tempRepo();
  const denied = [
    'git commit -m "key $RENDER_API_KEY"', // 큰따옴표 안 $NAME은 확장되어 비밀값이 메시지에 들어간다(검수 P1)
    "git commit -m 'x $RENDER_API_KEY' && cat .env", // 메시지는 리터럴이지만 뒤 조각이 금지 입력
    "cd docs && printenv", // 환경 덤프는 뒤 조각에 있어도 막는다
    "git stash save wip", // save는 bare stash와 같다
    'ls "0.2 ver"',
    "type .env.product.local",
    "cat apps/android/local.properties",
    "cat ~/.codex/auth.json",
    "cat ~/.npmrc",
    "cat ~/.docker/config.json",
    "echo $RENDER_API_KEY",
    'node -e "console.log(process.env.DATABASE_URL)"',
    "printenv",
    "Get-ChildItem Env:",
    "git commit --no-verify -m x",
    'git commit -n -m "x"',
    'git commit -am "x"',
    'cat .env && git commit -m "chore: ignore .env files"',
    "git commit -F .env",
    "git commit --file=services/api/.env",
    'git commit -m "$(cat .env)"',
    'git tag -a v1 -m "$(cat ~/.ssh/id_rsa)"',
    'grep -rn "$DATABASE_URL" src',
    "git push origin main --force",
    "git push -f",
    "git push origin --delete feature",
    "git push origin :feature",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git checkout -- a.txt",
    "git checkout a.txt",
    "git checkout docs/note.md",
    "git checkout -f main",
    "git checkout --force main",
    "git switch -f main",
    "git switch --force main",
    "git switch --discard-changes main",
    "git restore a.txt",
    "git restore --staged --worktree a.txt",
    "git restore -SW a.txt",
    "git stash",
    "git stash pop",
    "git add -A",
    "git add .",
    "git add -u",
    "git -c core.hooksPath=/dev/null commit -m x",
    "git config --unset core.hooksPath",
    "npx supabase db reset --linked",
    "npx supabase migration up --db-url postgres://x",
    "gh auth token",
    "claude -p x --dangerously-skip-permissions",
  ];
  for (const command of denied) assert.equal(decision(run("guard.mjs", shell(command), dir)), "deny", command);
});

test("guard passes ordinary work, including commit-message false positives", () => {
  const dir = tempRepo();
  const passed = [
    "git commit -m 'docs: mention `.env` handling'", // 작은따옴표 안 백틱은 치환되지 않는다
    "git commit -m 'note $RENDER_API_KEY is read by the server'", // 작은따옴표 안 $NAME도 리터럴
    "cat .env.example",
    "cat .npmrc",
    'node -e "console.log(process.env.HOME)"',
    'git commit -m "feat: version 0.2 verified"',
    'git commit -m "docs: add -A is forbidden"',
    'git commit -m "chore: ignore .env files"',
    'git commit -m "docs: mention .codex/ folder"',
    "git commit --message='fix: keep ~/.npmrc out of git' ",
    'git tag -a v0.3.0 -m "release: .env.example documented"',
    "git commit -F .work/msg.txt",
    'rg "process.env.DATABASE_URL" services',
    "grep -rn 'env.SUPABASE_SERVICE_ROLE_KEY' services/api/src",
    "git grep -n process.env.DATABASE_URL -- services",
    'Select-String -Path services -Pattern "process.env.RENDER_API_KEY"',
    "git config core.hooksPath .githooks",
    "git config --get core.hooksPath",
    "git status --short",
    "git stash list",
    "git restore --staged a.txt",
    "git switch -c feature",
    "git switch docs",
    "git checkout -b feature2",
    "git checkout -b docs2",
    "git checkout docs",
    "git checkout scratch",
    "git checkout -",
    "git branch -d scratch",
    "git add a.txt",
    "npm run typecheck && npm run lint",
    "npx supabase migration list",
    "ls -la",
    "env NODE_OPTIONS=x node --version",
  ];
  for (const command of passed) assert.equal(decision(run("guard.mjs", shell(command), dir)), "pass", command);
});

test("guard asks before git commit --amend wherever the flag sits", () => {
  const dir = tempRepo();
  for (const command of ['git commit -m "x" --amend', "git commit --amend --no-edit", 'git add a.txt && git commit --amend -m "y"']) {
    const out = run("guard.mjs", shell(command), dir);
    assert.equal(decision(out), "ask", command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /amend/);
  }
  assert.equal(decision(run("guard.mjs", shell("git commit --amend --no-verify"), dir)), "deny", "deny still wins over the amend ask");
});

test("guard blocks commit when .githooks is not installed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sigongnote-nohooks-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const out = run("guard.mjs", shell('git commit -m "x"'), dir);
  assert.equal(decision(out), "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /core\.hooksPath/);
});

test("guard pre-checks git add <file> content with check-staged rules", () => {
  const dir = path.join(repo, "tmp", "claude-hooks-test");
  fs.mkdirSync(dir, { recursive: true });
  const leak = path.join(dir, "leak.txt");
  fs.writeFileSync(leak, `note ${["C:", "Users", "someone", "doc.txt"].join("\\")}\n`); // 개인 홈 경로 패턴을 동적으로 만든다.
  const out = run("guard.mjs", shell(`git add ${path.relative(repo, leak).replaceAll("\\", "/")}`));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(decision(out), "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /sensitive-content/);
});

test("guard keeps flow-reviewer read-only", () => {
  const dir = tempRepo();
  assert.equal(decision(run("guard.mjs", shell("git add a.txt", { agent_type: "flow-reviewer" }), dir)), "deny");
  assert.equal(decision(run("guard.mjs", shell("npm install left-pad", { agent_type: "flow-reviewer" }), dir)), "deny");
  assert.equal(decision(run("guard.mjs", shell("node scripts/claude-headless.mjs --mode review", { agent_type: "flow-reviewer" }), dir)), "deny");
  assert.equal(decision(run("guard.mjs", shell("git stash list", { agent_type: "flow-reviewer" }), dir)), "pass");
  // 조회형 branch/tag/worktree/stash는 검수자가 기준 브랜치·태그를 확인하는 데 필요하다(briefing 스킬도 branch --show-current를 쓴다).
  for (const command of ["git branch --show-current", "git branch -a", "git branch -vv", "git branch --merged main", "git tag -l", "git worktree list", "git stash show", "git stash show -p"])
    assert.equal(decision(run("guard.mjs", shell(command, { agent_type: "flow-reviewer" }), dir)), "pass", command);
  for (const command of ["git branch feature", "git tag v1", "git branch -D scratch", "git stash push -m x", "git worktree add ../x"])
    assert.equal(decision(run("guard.mjs", shell(command, { agent_type: "flow-reviewer" }), dir)), "deny", command);
  assert.equal(decision(run("guard.mjs", shell("git log --stat -- src/add.ts", { agent_type: "flow-reviewer" }), dir)), "pass");
  assert.equal(decision(run("guard.mjs", shell("node --import tsx --test tests/cash.test.ts", { agent_type: "flow-reviewer" }), dir)), "pass");
  // 금지 스크립트는 '실행'만 막는다. 읽기·검색은 검수에 필요하다.
  for (const command of ["cat scripts/claude-headless.mjs", "rg reserveReview scripts/claude-headless.mjs", "sed -n 1,40p scripts/render-release.mjs"])
    assert.equal(decision(run("guard.mjs", shell(command, { agent_type: "flow-reviewer" }), dir)), "pass", command);
  for (const command of ["node scripts/claude-headless.mjs --probe", "node scripts/render-release.mjs inspect", "cd scripts && node render-release.mjs inspect"])
    assert.equal(decision(run("guard.mjs", shell(command, { agent_type: "flow-reviewer" }), dir)), command.startsWith("cd ") ? "pass" : "deny", command);
});

test("guard asks before staging a whole directory", () => {
  const dir = tempRepo();
  assert.equal(decision(run("guard.mjs", shell("git add docs"), dir)), "ask");
  assert.equal(decision(run("guard.mjs", shell("git add docs/note.md a.txt"), dir)), "pass");
});

test("guard checks file-tool paths and asks before editing a committed migration", () => {
  assert.equal(decision(run("guard.mjs", file("Read", { file_path: "0.2 ver/docs/x.md" }))), "deny");
  assert.equal(decision(run("guard.mjs", file("Glob", { pattern: "**/0.2 ver/**" }))), "deny");
  assert.equal(decision(run("guard.mjs", file("Grep", { pattern: "process.env", path: "services", glob: "*.env*" }))), "deny");
  assert.equal(decision(run("guard.mjs", file("Grep", { pattern: "\\.env", path: "services" }))), "pass");
  assert.equal(decision(run("guard.mjs", file("Edit", { file_path: ".env.local" }))), "deny");
  assert.equal(decision(run("guard.mjs", file("Read", { file_path: "services/api/.env.example" }))), "pass");
  assert.equal(decision(run("guard.mjs", file("Read", { file_path: ".npmrc" }))), "pass");
  assert.equal(decision(run("guard.mjs", file("Edit", { file_path: "supabase/migrations/20260928041730_tenant_boundary.sql" }))), "ask");
  assert.equal(decision(run("guard.mjs", file("Write", { file_path: "supabase/migrations/20991231000000_new_table.sql" }))), "pass");
});

test("guard reserves one flow-reviewer per HEAD and lifecycle releases it on failure", () => {
  const dir = tempRepo();
  const agent = (extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "flow-reviewer", prompt: "x", ...extra } });
  assert.equal(decision(run("guard.mjs", agent({ model: "haiku" }), dir)), "deny");
  assert.equal(decision(run("guard.mjs", agent(), dir)), "pass");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const reservation = path.join(dir, ".work", "claude-runs", "reviews", `${head}.json`);
  assert.ok(fs.existsSync(reservation));
  const second = run("guard.mjs", agent(), dir);
  assert.equal(decision(second), "deny");
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /test-session/);
  assert.equal(decision(run("guard.mjs", { ...agent(), tool_input: { subagent_type: "Explore", prompt: "x" } }, dir)), "pass");
  run("lifecycle.mjs", { hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: { subagent_type: "flow-reviewer" }, error: "x" }, dir);
  assert.ok(!fs.existsSync(reservation), "failed Agent call releases this session's reservation");
  run("guard.mjs", agent(), dir);
  run("lifecycle.mjs", { hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: { subagent_type: "flow-reviewer" }, session_id: "other" }, dir);
  assert.ok(fs.existsSync(reservation), "another session's reservation is kept");
});

test("lifecycle briefs on session start, stays quiet for reviewers, and reports edit findings", () => {
  const brief = run("lifecycle.mjs", { hook_event_name: "SessionStart", source: "startup" });
  assert.match(brief, /브랜치 /);
  assert.match(brief, /EXECUTION_STATE: /);
  assert.ok(brief.split("\n").length <= 20, "session brief stays short");
  assert.equal(run("lifecycle.mjs", { hook_event_name: "SessionStart", source: "startup", agent_type: "flow-reviewer" }), "");
  assert.equal(run("lifecycle.mjs", { hook_event_name: "Stop", stop_hook_active: true }), "");
  assert.equal(run("lifecycle.mjs", { hook_event_name: "Stop", agent_type: "flow-reviewer" }), "");
  assert.equal(run("lifecycle.mjs", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "docs/EXECUTION_STATE.md" } }), "");
  const named = run("lifecycle.mjs", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "supabase/migrations/bad-name.sql" } });
  assert.match(named.hookSpecificOutput.additionalContext, /형식/);
});
