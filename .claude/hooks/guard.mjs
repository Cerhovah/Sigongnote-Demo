#!/usr/bin/env node
// .claude/hooks/guard.mjs — PreToolUse 가드(결정적 규칙). settings.json이 세 매처로 호출한다.
// settings.json의 각 훅 명령은 이 파일을 '현재 체크아웃(cwd의 git 최상위) → ${CLAUDE_PROJECT_DIR} → 현재 폴더' 순서로 찾는다.
// worktree 세션에서는 ${CLAUDE_PROJECT_DIR}가 세션을 시작한 메인 체크아웃에 고정되므로(공식 hooks·worktrees 문서) 첫 후보가 필요하다.
//
//  1) Bash|PowerShell  (settings.json 명령이 이 파일을 못 찾거나 node가 없거나 이 파일이 오류를 내면 systemMessage 경고 후 통과한다(fail-open).
//     하드 규칙은 settings.json의 deny 규칙과 .githooks가 계속 지킨다)
//     - 금지 입력 언급: `0.2 ver/`, .env*(.env.example 제외), 키스토어·인증서, local.properties, 로그인 자격 파일(.claude.json·gh hosts·
//       홈 .npmrc·.docker/config.json), .ssh/.aws, .codex/ → deny. 커밋·태그·노트 메시지(-m/--message 값)는 파일 접근이 아니므로 검사에서
//       빼되, 작은따옴표 리터럴('…')만 본문으로 보고 큰따옴표·무따옴표 값에 확장·치환(`$NAME`·`${`·`$(`·`<(`·백틱)이 있으면 원문 그대로
//       검사한다. `-F/--file` 값은 파일 읽기이므로 항상 검사한다.
//     - 비밀 노출: 비밀 환경변수의 셸 확장(`$NAME`·`${NAME}`·`%NAME%`·`$env:NAME`)은 어디서나, `process.env.NAME` 같은 코드 문자열은
//       rg/grep/Select-String 검색 조각 밖에서만 deny(사용처 검색은 정상 읽기). 환경변수 전체 출력, gh auth token/login/logout → deny
//     - 보호 장치 우회: --no-verify, core.hooksPath 변경, force push·원격 브랜치 삭제(--delete/:refspec), reset --hard, clean,
//       작업 트리 되돌리기(checkout --/추적 경로, restore --worktree, checkout·switch -f/--force/--discard-changes),
//       전체 stage(add -A/./-u, commit -a), 공유 stash(bare/pop), 원격 Supabase DB reset/--db-url/secrets, 권한 우회 플래그 → deny
//     - git commit --amend(인자 위치 무관) → ask
//     - git add <파일>: 그 파일 내용을 scripts/check-staged.mjs의 inspectContent로 선검사 → 걸리면 deny
//     - git commit/push: core.hooksPath가 .githooks이고 pre-commit이 있는지 확인, commit 직전 node scripts/check-staged.mjs 실행 → FAIL이면 deny
//     - flow-reviewer 세션(hook 입력 agent_type)에서는 Git 쓰기·설치·DB·배포·runner 호출 → deny. 조회형 `branch --show-current/-a/-r/-v`,
//       `tag -l`, `worktree list`, `stash list|show`는 허용(검수자는 읽기·국소시험만)
//  2) Read|Grep|Glob|Edit|Write|NotebookEdit  (fail-open: 스크립트 오류·부재는 통과. 하드 차단은 settings.json의 Read/Edit deny 규칙)
//     - 경로·glob 인자가 금지 입력이면 deny
//     - 이미 커밋된 supabase/migrations/*.sql 편집 → ask (보정 migration 추가가 원칙)
//  3) Agent  (fail-open)
//     - subagent_type이 flow-reviewer이면 .work/claude-runs/reviews/<HEAD>.json 을 예약한다(scripts/claude-headless.mjs의
//       reserveReview와 같은 파일·같은 wx 규약). 이미 있으면 deny — 커밋당 독립 검수 1회(AGENTS 6). model 인자가 fable이 아니면 deny.
//
// 통과: 출력 없이 종료. 거부/질문: stdout에 hookSpecificOutput.permissionDecision JSON(exit 0).
// 비밀값·환경값·개인 경로는 읽지도 출력하지도 않는다. 시험: npm run test:hooks (tests/claude-hooks.test.mjs)
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const deny = (reason) => ({ decision: "deny", reason });
const ask = (reason) => ({ decision: "ask", reason });
const slash = (value) => String(value).replaceAll("\\", "/");

const FORBIDDEN = [
  [/0\.2(?: |%20)ver(?![a-z])/i, "`0.2 ver/`는 참조 금지 보관함입니다(AGENTS 2). 열기·검색·요약 모두 하지 않습니다."],
  [/(?<![\w])\.env\b(?!\.example\b)/i, "`.env*` 비밀 환경파일은 읽거나 쓰지 않습니다(.env.example만 허용). 값은 사용자가 직접 넣습니다."],
  [/\.(?:keystore|jks|pfx|p12|pem)\b/i, "서명 키·인증서 파일은 다루지 않습니다(AGENTS 8)."],
  [/\blocal\.properties\b/i, "Android local.properties(SDK 경로·서명 정보)는 읽지 않습니다."],
  [/(?:^|[\s"'`=(\\/])\.codex[\\/]/i, "`.codex/`는 작업 입력이 아니며 커밋하지 않습니다(AGENTS 2)."],
  [/\.claude\.json\b|\.credentials\.json\b|[\\/]gh[\\/]hosts\.yml\b|GitHub CLI[\\/]hosts\.yml/i, "에이전트·CLI 로그인 자격 파일은 열지 않습니다."],
  [/(?:^|[\\/])\.(?:ssh|aws|gnupg)[\\/]/i, "SSH/AWS/GPG 자격 폴더는 다루지 않습니다."],
  // 홈의 .npmrc(npm 토큰)·.docker/config.json(레지스트리 인증)만 막는다. 저장소의 .npmrc는 옵션만 담은 추적 파일이라 예외다.
  [/(?:~|HOME\}?|USERPROFILE\}?|%|[\\/]Users[\\/][^\\/\s"']+)[\\/]\.npmrc\b|[\\/]\.docker[\\/]config\.json\b/i, "npm·Docker 로그인 자격 파일(홈 .npmrc, .docker/config.json)은 열지 않습니다."],
];
const SECRET_NAMES =
  "RENDER_API_KEY|GH_TOKEN|GITHUB_TOKEN|SUPABASE_ACCESS_TOKEN|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE|DATABASE_URL|WORKER_DATABASE_URL|MIGRATION_DATABASE_URL|AI_API_KEY|SEMANTIC_API_KEY|SHORT_STT_API_KEY|LONG_STT_API_KEY|DOCUMENT_WORKER_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|NPM_TOKEN";
// 셸·PowerShell 확장: 실제 값이 명령줄(로그·출력)에 들어가는 형태. 검색 명령 조각에서도 막는다.
const SECRET_EXPANSION = new RegExp(`(?:\\$(?:env:)?\\{?|%)(?:${SECRET_NAMES})\\b`, "i");
// 코드 문자열 형태(process.env.X, GetEnvironmentVariable("X"), printenv X, Env:X)까지 포함. 검색 패턴 인자와 겹치므로 검색 조각에는 쓰지 않는다.
const SECRET_ENV = new RegExp(`(?:\\$(?:env:)?\\{?|%|process\\.env\\.|GetEnvironmentVariable\\(["']?|printenv\\s+|Env:)(?:${SECRET_NAMES})\\b`, "i");
// 소스 검색 명령 조각(선행 VAR=값 할당 허용). 패턴 인자에 비밀 변수 이름이 들어가는 것은 사용처를 찾는 정상 읽기 작업이다.
const SEARCH_COMMAND = /^\s*(?:\w+=\S*\s+)*(?:rg|grep|egrep|fgrep|git\s+grep|Select-String|sls|findstr)\b/i;
const ENV_DUMP = /^\s*(?:printenv|env|set|export\s+-p)\s*(?:$|[|>;&])|\b(?:Get-ChildItem|gci|ls|dir|Get-Item|gi)\s+Env:\s*\*?\s*(?:$|[|>;&])|GetEnvironmentVariables\(\)|\bcmdkey\b/im;
const RELEASE_SCRIPTS = /scripts[\\/](?:render-release|publish-release|release-control|write-release)\.mjs/i;
const REVIEWER_WRITE = new Set(["add", "commit", "push", "checkout", "switch", "reset", "restore", "rm", "mv", "rebase", "merge", "cherry-pick", "revert", "tag", "stash", "worktree", "clean", "branch"]);
// 검수자에게 허용하는 조회 형태. 옵션이 모두 이 목록 안이어야 하고, 이름(위치 인자)은 조회 옵션(--contains 등)과 함께일 때만 허용한다.
const REVIEWER_READ_FLAGS = {
  branch: /^(?:--show-current|--list|--all|--remotes|--verbose|--contains|--merged|--no-merged|-[avr]{1,3})$/,
  tag: /^(?:-l|--list|-n\d*|--contains|--merged|--no-merged)$/,
};
const REVIEWER_REF_FLAGS = /^(?:-l|--list|--contains|--merged|--no-merged)$/;
const MESSAGE_SUBS = new Set(["commit", "tag", "notes"]);
// 메시지 값: 작은따옴표 리터럴('…')은 셸(bash·PowerShell 모두)이 확장하지 않으므로 본문으로 본다.
// 큰따옴표·무따옴표 값은 $NAME·${…}·$(…)·<(…)·백틱이 있으면 비밀값·파일 읽기가 섞일 수 있어 원문 그대로 검사한다.
const UNSAFE_MESSAGE = /\$[A-Za-z_{(]|`|<\(/;
const literalMessage = (value) => /^'[^']*'$/.test(value) || !UNSAFE_MESSAGE.test(value);
const CHECKOUT_REVERT = "checkout으로 파일을 되돌리면 사용자 변경이 사라집니다. 브랜치 전환은 git switch, 되돌림은 사용자가 결정합니다.";
const FORCE_SWITCH = "checkout/switch -f·--force·--discard-changes는 사용자 미커밋 변경을 묻지 않고 버립니다(AGENTS 2·8). 변경을 먼저 커밋하거나 사용자가 결정합니다.";

function git(cwd, args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 8000 });
  return run.status === 0 ? (run.stdout ?? "").trim() : null;
}
const isTrackedPath = (cwd, target) => git(cwd, ["ls-files", "--error-unmatch", "--", target]) !== null;
const isRevision = (cwd, target) => git(cwd, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]) !== null;

// core.hooksPath가 .githooks(상대 또는 절대)이고 pre-commit이 실제로 있는지. 값 자체는 출력하지 않는다.
function hooksPathStatus(cwd) {
  const value = git(cwd, ["config", "--get", "core.hooksPath"]);
  if (!value) return "core.hooksPath 미설정";
  if (!/(?:^|[\\/])\.githooks[\\/]?$/.test(value)) return "core.hooksPath가 .githooks가 아님";
  const resolved = path.isAbsolute(value) ? value : path.join(cwd, value);
  if (!existsSync(path.join(resolved, "pre-commit"))) return ".githooks/pre-commit 없음";
  return null;
}

// 명령을 &&, ||, ;, | 로 나눠 각 조각의 git 하위 명령과 인수를 뽑는다. 따옴표 안은 한 토큰(커밋 메시지는 해석하지 않음).
// `--message='…'`·`-m"…"`처럼 접두어에 붙은 따옴표 값도 한 토큰으로 본다.
const SPLIT = /&&|\|\||;|\|/;
const TOKEN = /[^\s"']*(?:"[^"]*"|'[^']*')|\S+/g;
function parseGit(tokens) {
  const start = tokens.findIndex((token) => /^git(?:\.exe)?$/i.test(token));
  if (start < 0) return null;
  const options = [];
  let i = start + 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    options.push(tokens[i]);
    if (/^-[cC]$/.test(tokens[i]) && i + 1 < tokens.length) options.push(tokens[++i]);
    i += 1;
  }
  return { sub: (tokens[i] ?? "").toLowerCase(), subIndex: i, args: tokens.slice(i + 1), options };
}
function gitSegments(command) {
  const out = [];
  for (const segment of command.split(SPLIT)) {
    const parsed = parseGit(segment.match(TOKEN) ?? []);
    if (parsed) out.push({ ...parsed, segment });
  }
  return out;
}
// 커밋·태그·노트 메시지(-m/--message와 그 값, --message=, -m<붙은값>)는 파일 접근이 아니므로 금지 입력·비밀 검사 대상에서 뺀다.
// 단 값에 명령 치환(`$(cat .env)` 등)이 있으면 원문을 남기고, -F/--file(파일 경로)은 절대 빼지 않는다. 그 외 조각(cat .env 등)도 원문 그대로 검사된다.
function withoutMessages(command) {
  return command
    .split(SPLIT)
    .map((segment) => {
      const tokens = segment.match(TOKEN) ?? [];
      const parsed = parseGit(tokens);
      if (!parsed || !MESSAGE_SUBS.has(parsed.sub)) return segment;
      const kept = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (i > parsed.subIndex && /^(?:-m|--message)$/.test(token) && i + 1 < tokens.length) {
          const value = tokens[i + 1];
          kept.push(token, literalMessage(value) ? '""' : value);
          i += 1;
          continue;
        }
        if (i > parsed.subIndex && /^(?:--message=|-m[^\s-])/.test(token)) {
          kept.push(literalMessage(token.replace(/^(?:--message=|-m)/, "")) ? '""' : token);
          continue;
        }
        kept.push(token);
      }
      return kept.join(" ");
    })
    .join(" ; ");
}
const unquote = (token) => token.replace(/^["']|["']$/g, "");
const shortFlag = (args, letter) => args.some((arg) => new RegExp(`^-[a-zA-Z]*${letter}[a-zA-Z]*$`).test(arg));
// 조각별로: 검색 명령이면 셸 확장만, 그 외는 코드 문자열 형태까지 비밀 변수 참조로 본다.
const exposesSecret = (scan) => scan.split(SPLIT).some((segment) => (SEARCH_COMMAND.test(segment) ? SECRET_EXPANSION : SECRET_ENV).test(segment));
// 환경변수 전체 출력은 `cd x && printenv`처럼 뒤 조각에 있어도 막는다(조각별 검사).
const dumpsEnv = (scan) => scan.split(SPLIT).some((segment) => ENV_DUMP.test(segment));
// 검수자 금지 스크립트는 '실행'만 막는다(조각의 첫 실행 토큰이 node이고 다음 인자가 해당 스크립트). 파일로 읽거나 검색하는 것은 정상 읽기다.
const runsProtectedScript = (command) =>
  command.split(SPLIT).some((segment) => {
    const tokens = segment.trim().match(TOKEN) ?? [];
    const start = tokens.findIndex((token) => !/^\w+=\S*$/.test(token));
    const program = tokens[start] ?? "";
    const target = unquote(tokens[start + 1] ?? "");
    return /^(?:node|node\.exe)$/i.test(program) && (RELEASE_SCRIPTS.test(target) || /claude-headless\.mjs$/i.test(target));
  });
function reviewerReadOnly({ sub, args }) {
  if (sub === "stash") return args[0] === "list" || args[0] === "show";
  if (sub === "worktree") return args[0] === "list";
  const allowed = REVIEWER_READ_FLAGS[sub];
  if (!allowed) return false;
  const flags = args.filter((a) => a.startsWith("-"));
  if (!flags.every((f) => allowed.test(f))) return false;
  // `git branch feature`·`git tag v1`은 생성이다. 이름은 --contains/--merged/-l 같은 조회 옵션과 함께일 때만 허용.
  return args.length === flags.length || flags.some((f) => REVIEWER_REF_FLAGS.test(f));
}

async function shellCommand(input) {
  const command = String(input.tool_input?.command ?? "");
  if (!command.trim()) return null;
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd();
  const bare = command.replace(/"[^"]*"|'[^']*'/g, '""');
  const scan = withoutMessages(command);

  // 1) 금지 입력 — 명령 어디에 적혀 있어도 막는다(node -e, Get-Content, grep 등 포함). 치환 없는 커밋 메시지 본문만 예외.
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(scan)) return deny(reason);

  // 2) 비밀 노출·권한 우회
  if (exposesSecret(scan)) return deny("비밀 환경변수 값을 명령줄에서 참조·출력하지 않습니다(AGENTS 8). 스크립트가 내부에서 읽게 둡니다. (사용처 검색은 rg/grep 패턴 인자로만.)");
  if (dumpsEnv(scan)) return deny("환경변수 전체 출력은 비밀을 노출합니다. 필요한 키 이름 하나만 확인하세요.");
  if (/\bgh\s+auth\s+(?:token|logout|login)\b/i.test(bare)) return deny("gh 토큰 출력·로그인 변경은 사용자가 직접 합니다.");
  if (/--dangerously-skip-permissions|bypassPermissions|--permission-mode\s+(?:auto|dontAsk)\b/i.test(bare)) return deny("권한 우회 플래그로 다른 세션을 띄우지 않습니다.");
  if (/\bsupabase\b[^|&;]*--db-url\b/i.test(bare)) return deny("임의 DB URL 접속은 운영 DB를 위험하게 합니다. 로컬 격리 DB만 사용합니다.");
  if (/\bsupabase\b[^|&;]*\bdb\s+reset\b[^|&;]*--linked\b/i.test(bare)) return deny("운영/원격 DB reset은 금지입니다(AGENTS 3, ENVIRONMENT). 로컬 격리 DB만 reset합니다.");
  if (/\bsupabase\b[^|&;]*\b(?:projects\s+delete|secrets)\b/i.test(bare)) return deny("Supabase 프로젝트 삭제·secrets 명령은 하지 않습니다.");
  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(?:\/|~|\.|\.git|\*)(?=$|\s)/.test(bare)) return deny("루트·홈·저장소 전체 삭제는 하지 않습니다.");

  const segments = gitSegments(command);

  // 6) 검수자는 읽기 전용 — 먼저 검사해 명확한 이유를 돌려준다. 조회형 branch/tag/worktree list/stash list·show는 통과.
  if (input.agent_type === "flow-reviewer") {
    if (
      segments.some((s) => REVIEWER_WRITE.has(s.sub) && !reviewerReadOnly(s)) ||
      /\bnpm(?:\.cmd)?\s+(?:install|i|ci|uninstall|update|publish)\b/i.test(bare) ||
      /\bnpx\s+supabase\b/i.test(bare) ||
      runsProtectedScript(command)
    )
      return deny("flow-reviewer는 읽기·국소시험만 수행합니다. 코드·Git·설치·배포·DB를 바꾸지 않습니다(.claude/agents/flow-reviewer.md).");
  }

  // 3) Git 보호 장치 우회·파괴적 명령. deny가 하나도 없을 때만 pending(ask)을 돌려준다.
  let pending = null;
  for (const { sub, args, options } of segments) {
    const hooksOption = options.find((o) => /^core\.hookspath=/i.test(o));
    if (hooksOption && !/(?:^|[\\/])\.githooks[\\/]?$/.test(hooksOption.split("=")[1] ?? "")) return deny("core.hooksPath 임시 교체는 hook 우회입니다(AGENTS 8).");
    if (args.some((a) => /^--no-verify$/i.test(a))) return deny("--no-verify로 .githooks 개인정보 검사를 건너뛸 수 없습니다(AGENTS 8). 실패 원인을 고치세요.");
    if (sub === "commit" && (shortFlag(args, "n") || args.includes("--all") || shortFlag(args, "a")))
      return deny("commit -n(-no-verify)와 commit -a/--all은 금지입니다. 자기 파일만 명시 add → check-staged → commit.");
    if (sub === "commit" && args.includes("--amend"))
      pending ??= ask("git commit --amend는 이미 push된 커밋을 바꿀 수 있습니다(공유 이력 변경). 새 커밋으로 고치는 것이 원칙이며, 직전 커밋이 아직 push되지 않았음을 확인했을 때만 허용하세요.");
    if (sub === "push" && (args.some((a) => /^(?:--force(?:-with-lease)?|--delete|\+\S+|:\S+)$/i.test(unquote(a))) || shortFlag(args, "f") || shortFlag(args, "d")))
      return deny("force push·원격 브랜치 삭제(--delete, :브랜치)는 하지 않습니다. 새 커밋으로 고치세요.");
    if (sub === "reset" && args.some((a) => /^--(?:hard|merge)$/i.test(a))) return deny("git reset --hard는 작업 내용과 사용자 미커밋 자료를 지울 수 있습니다(AGENTS 2). git restore --staged <파일>을 쓰세요.");
    if (sub === "clean") return deny("git clean은 미추적 파일(사용자 자료)을 지웁니다. 금지.");
    if ((sub === "checkout" || sub === "switch") && (shortFlag(args, "f") || args.some((a) => /^--(?:force|discard-changes)$/i.test(a)))) return deny(FORCE_SWITCH);
    if (sub === "checkout") {
      if (args.includes("--") || args.some((a) => a === "." || a === "*")) return deny(CHECKOUT_REVERT);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (/^(?:-b|-B|--orphan)$/.test(arg)) {
          i += 1; // 새 브랜치 이름은 경로가 아니다
          continue;
        }
        if (arg.startsWith("-")) continue;
        const target = unquote(arg);
        // 추적 경로이면서 리비전(브랜치·태그·SHA)이 아닐 때만 작업 트리 되돌리기로 본다. 폴더와 같은 이름의 브랜치 전환은 허용.
        if (isTrackedPath(cwd, target) && !isRevision(cwd, target)) return deny(CHECKOUT_REVERT);
      }
    }
    if (sub === "restore") {
      const staged = args.includes("--staged") || shortFlag(args, "S");
      const worktree = args.includes("--worktree") || shortFlag(args, "W");
      if (!staged || worktree) return deny("git restore(작업 트리 되돌림)는 사용자 변경을 지웁니다. --staged(-S)만 허용하며 --worktree(-W)와 함께 쓰지 않습니다.");
    }
    if (sub === "stash" && (args.length === 0 || args[0] === "pop" || args[0] === "save")) return deny("공유 stash 금지(worktree 규칙). 임시 WIP 커밋을 쓰거나 git stash push -u -m <태그> 뒤 apply <sha>만 허용합니다.");
    if (sub === "config" && args.some((a) => /core\.hookspath/i.test(a))) {
      const value = args[args.indexOf(args.find((a) => /core\.hookspath/i.test(a))) + 1] ?? "";
      if (args.includes("--unset") || (value && !/(?:^|[\\/])\.githooks[\\/]?$/.test(unquote(value)))) return deny("core.hooksPath는 .githooks로만 유지합니다(AGENTS 8).");
    }
    if (sub === "add") {
      if (args.some((a) => /^(?:--all|--update|\.|\*|:\/)$/.test(a)) || shortFlag(args, "A") || shortFlag(args, "u"))
        return deny("전체 stage 금지. 자기가 바꾼 파일만 이름을 적어 stage합니다(AGENTS 6). git add -A / . / -u 는 사용자 미커밋 자료까지 올립니다.");
      // 폴더 통째 stage는 사용자 미추적 파일까지 올릴 수 있으므로 되묻는다(AGENTS 2·6).
      for (const token of args) {
        const file = unquote(token);
        if (!file || file.startsWith("-")) continue;
        const absolute = path.resolve(cwd, file);
        if (existsSync(absolute) && statSync(absolute).isDirectory())
          pending ??= ask(`폴더 '${file}'를 통째로 stage하면 사용자 미추적 파일까지 올라갈 수 있습니다(AGENTS 2·6). 자기 파일 이름을 하나씩 적는 것이 원칙이며, 폴더 안 파일이 모두 자기 것일 때만 허용하세요.`);
      }
      // 4) stage 내용 선검사 — .githooks pre-commit과 같은 규칙을 더 이른 시점에.
      const gate = path.join(cwd, "scripts", "check-staged.mjs");
      if (existsSync(gate)) {
        const { inspectContent } = await import(pathToFileURL(gate).href);
        for (const token of args) {
          const file = unquote(token);
          if (!file || file.startsWith("-")) continue;
          const absolute = path.resolve(cwd, file);
          if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
          const findings = inspectContent(slash(path.relative(cwd, absolute)), readFileSync(absolute));
          if (findings.length) return deny(`개인정보 검사 FAIL: ${file} (${findings[0].rule}). 비밀값·개인 경로·원문·미승인 바이너리를 제거하거나 이 파일을 stage하지 마세요.`);
        }
      }
    }
    // 5) 커밋·push 직전: .githooks 설치 확인 + stage 검사
    if ((sub === "commit" || sub === "push") && !args.some((a) => /^--(?:dry-run|help)$/i.test(a))) {
      const problem = hooksPathStatus(cwd);
      if (problem) return deny(`${problem}. \`git config core.hooksPath .githooks\` 실행 뒤 다시 시도합니다(AGENTS 8).`);
      if (sub === "commit") {
        const gate = path.join(cwd, "scripts", "check-staged.mjs");
        if (existsSync(gate)) {
          const result = spawnSync(process.execPath, [gate], { cwd, encoding: "utf8", timeout: 20000, windowsHide: true });
          if (!result.error && result.status !== 0)
            return deny(
              `stage 개인정보 검사 FAIL — ${(result.stderr || result.stdout || "").trim().slice(0, 400)}\n` +
                "해당 파일을 `git restore --staged <파일>`로 빼거나 내용을 고친 뒤 다시 커밋하세요. (add와 commit을 한 줄에 묶었다면 .githooks pre-commit이 다시 검사합니다.)",
            );
        }
      }
    }
  }
  return pending;
}

function fileTool(input) {
  const tool = String(input.tool_name ?? "");
  const ti = input.tool_input ?? {};
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd();
  const targets = [];
  for (const key of ["file_path", "notebook_path", "path"]) if (typeof ti[key] === "string") targets.push(ti[key]);
  if (tool === "Glob" && typeof ti.pattern === "string") targets.push(ti.pattern);
  if (tool === "Grep" && typeof ti.glob === "string") targets.push(ti.glob);
  for (const raw of targets) for (const [pattern, reason] of FORBIDDEN) if (pattern.test(slash(raw))) return deny(`${reason} (도구: ${tool})`);
  if ((tool === "Edit" || tool === "Write" || tool === "NotebookEdit") && typeof ti.file_path === "string") {
    const relative = slash(path.relative(cwd, path.resolve(cwd, ti.file_path)));
    if (/^supabase\/migrations\/[^/]+\.sql$/.test(relative) && git(cwd, ["ls-files", "--error-unmatch", relative]) !== null)
      return ask("이미 커밋된 migration 파일입니다. 운영에 적용된 migration은 고치지 않고 보정 migration을 새로 추가합니다(/db-migration). 아직 어디에도 적용되지 않은 파일임을 확인했을 때만 허용하세요.");
  }
  return null;
}

function agentTool(input) {
  const ti = input.tool_input ?? {};
  if (ti.subagent_type !== "flow-reviewer") return null;
  if (typeof ti.model === "string" && ti.model && !/fable/i.test(ti.model)) return deny("flow-reviewer 모델은 claude-fable-5-1 high로 고정입니다. Agent 호출에서 model 인자를 빼세요.");
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd();
  const base = git(cwd, ["rev-parse", "HEAD"]);
  if (!base) return null;
  const directory = path.join(cwd, ".work", "claude-runs", "reviews");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${base}.json`);
  try {
    writeFileSync(file, JSON.stringify({ sessionId: input.session_id ?? null, base, pid: process.pid, source: "claude-code-agent", startedAt: new Date().toISOString() }), { flag: "wx" });
    return null;
  } catch (error) {
    if (error.code !== "EEXIST") return null;
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      previous = {};
    }
    return deny(
      `HEAD ${base.slice(0, 7)}에 이미 독립 검수 세션이 있습니다(session ${previous.sessionId ?? "?"}). 커밋당 검수 1회·재검수 금지(AGENTS 6). ` +
        "후속 질문은 SendMessage로 기존 flow-reviewer에게 보내고, P0/P1 수정 뒤에는 영향 부분만 직접 재검증합니다. " +
        `그 세션이 비정상 종료된 경우에만 사용자가 .work/claude-runs/reviews/${base}.json 을 지운 뒤 다시 시작합니다.`,
    );
  }
}

async function evaluate(input) {
  const tool = String(input.tool_name ?? "");
  if (tool === "Bash" || tool === "PowerShell") return shellCommand(input);
  if (tool === "Agent") return agentTool(input);
  return fileTool(input);
}

async function main() {
  // BOM(PowerShell 파이프 등)을 떼고 읽는다.
  const input = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
  const result = await evaluate(input);
  // Windows 파이프 stdout은 비동기이므로 process.exit()로 끊지 않고 자연 종료로 flush한다.
  if (result)
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: result.decision, permissionDecisionReason: result.reason },
      })}\n`,
    );
}

main().catch((error) => {
  // 비정상 종료는 settings.json의 훅 명령이 systemMessage 경고로 바꾼다(모든 진입점 fail-open). 하드 규칙은 deny 규칙과 .githooks가 지킨다.
  process.stderr.write(`[guard] ${error.message}\n`);
  process.exitCode = 1;
});
