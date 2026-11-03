# .claude 폴더 안내 — 시공노트 Claude Code 작업 환경

이 폴더는 Claude Code(Fable 5.1)가 이 저장소에서 **무엇을 자동으로 하고, 무엇을 물어보고, 무엇을 절대 하지 않는지**를 정한 설정입니다. 규칙의 원본은 [AGENTS.md](../AGENTS.md)이고, 여기 파일들은 그 규칙을 사람이 아니라 "기계"가 지키게 하는 장치입니다. 비밀값(키·토큰)은 어디에도 들어 있지 않습니다.

## 1. 파일 지도 (각 파일 한 줄)

| 파일 | 역할 |
|---|---|
| `settings.json` | 권한 3단계(allow 자동 / ask 물어봄 / deny 거부), 훅 연결, MCP 승인, 커밋 서명, 한국어 응답. 이 저장소의 중심 설정. 훅 명령은 스크립트를 '현재 체크아웃 → 세션 프로젝트 루트 → 현재 폴더' 순서로 찾음 |
| `hooks/guard.mjs` | 도구 실행 **전** 검사. 셸 명령: 금지 입력 언급·비밀 노출·보호 장치 우회 차단, `git add` 범위·내용 검사, `git commit` 전 개인정보 검사, 검수자의 쓰기 금지(조회형 branch/tag/worktree list/stash list·show는 허용). 파일 도구: 금지 경로 차단, 커밋된 migration 편집은 되묻기. Agent 도구: 같은 HEAD의 두 번째 flow-reviewer 차단 |
| `hooks/lifecycle.mjs` | 차단하지 않는 훅: 세션 시작 브리핑, 파일 수정 뒤 biome lint·상태 50줄·migration 파일명 알림, 검수 호출 실패 시 예약 해제, 작업 종료 때 상태 파일·push 알림 |
| `skills/briefing/` | `/briefing` — AGENTS 1번 재개 순서대로 읽고 10줄 브리핑 |
| `skills/ncard/` | `/ncard N31p` — 구현 → 국소검증 → 검수 1세션 → 수정 → stage → 검사 → 상태 갱신 → commit → push |
| `skills/db-migration/` | `/db-migration` — Supabase migration 안전 절차(RLS·tenant·멱등·격리 검증·복원 등록) |
| `skills/handoff-check/` | `/handoff-check` — 문서 정합·상태 50줄·검수 영수증·CI·운영·설치물 점검(배포 실행 없음) |
| `skills/ui-pass/` | `/ui-pass` — 화면 작업 절차(기존 유지) |
| `agents/flow-reviewer.md` | 커밋당 유일한 독립 검수자(기존 유지, Claude가 고칠 수 없음) |
| `rules/db.md`, `rules/money-state.md`, `rules/web-ui.md` | 해당 경로 파일을 열 때만 자동 로드되는 DB·돈/상태·화면 규칙 |
| `launch.json` | 데스크톱 브라우저 패널용 개발 서버(기존 유지) |
| `../.mcp.json` | 외부 연결(MCP): Supabase 읽기 전용·프로젝트 하나 고정 |
| `../.ignore` | Grep(ripgrep)이 `0.2 ver/`·`.work/`를 검색하지 않게 함 |
| `../scripts/claude-cli.mjs` | 터미널 전용 claude 명령(`mcp list`, `doctor`, `plugin …`)을 데스크톱 번들 CLI로 실행 |
| `../tests/claude-hooks.test.mjs` | 훅 2개의 국소시험 (`npm run test:hooks`; settings.json의 훅 명령을 Git Bash로 그대로 실행해 폴백 체인도 검사) |

## 2. 권한이 작동하는 방식 (3단계)

| 단계 | 뜻 | 예 |
|---|---|---|
| **allow** | 묻지 않고 실행 | `git status/diff/log`, `git add <파일>`, `git commit`, `npm run typecheck`, 시험 명령, 검사 스크립트, `gh` 읽기, 공식 문서 사이트 읽기, Supabase 스키마·migration·advisor·문서 조회 |
| **ask** | 화면에 질문이 뜨고 사람이 "허용"을 눌러야 실행 | `git push`, 브랜치 삭제·rebase·merge·amend, `npm install`, Supabase CLI(db push/reset, migration up, start/stop), docker/adb, 배포 스크립트, runner 호출, `rm`/`mv`/`curl`, 보호 파일 편집(`.claude/**`, `.github/**`, `package.json`, `supabase/config.toml`, AGENTS/CLAUDE/README/AGENT_SPEC), Supabase SQL 실행·로그 조회, 외부 MCP의 create/update/delete/deploy/trigger |
| **deny** | 항상 거부. 질문도 뜨지 않음 | `0.2 ver/`·`.env*`·키·인증서·로그인 자격 파일 읽기, force push, `reset --hard`, `clean`, `--no-verify`, `git add -A/.`, `commit -a`, 공유 stash, 원격 DB reset, 환경변수 전체 출력, Supabase 쓰기 도구, 설정 자기수정(`settings.json`, `hooks/`, `.mcp.json`, `.githooks/`, `check-staged.mjs`, `flow-reviewer.md`) |

우선순위는 deny > ask > allow 입니다. 같은 명령이 두 목록에 있으면 더 엄한 쪽이 이깁니다(예: `git branch*`는 allow지만 `git branch -D *`는 ask).

데스크톱 앱의 기본인 자동 모드(auto)에 들어가면 `Agent(flow-reviewer)`·`Bash(npm run *)`처럼 임의 코드 실행을 넓게 허용하는 allow 규칙은 꺼지고 분류기(classifier)가 다시 검토합니다. `Bash(npm test)`처럼 좁은 규칙만 그대로 통과하며, ask/deny는 모드와 무관하게 그대로입니다(공식 permission-modes 문서).

훅(`hooks/`)은 규칙이 "명령 문장"만 보고 못 잡는 틈을 메웁니다. `settings.json`의 훅 명령은 스크립트를 **현재 체크아웃(명령을 실행하는 폴더의 git 최상위) → 세션을 시작한 프로젝트 루트(`CLAUDE_PROJECT_DIR`) → 현재 폴더** 순서로 찾습니다. 데스크톱의 'worktree 옵션' 세션에서는 `CLAUDE_PROJECT_DIR`가 메인 체크아웃에 고정되므로(공식 훅·worktree 문서) 첫 번째 후보가 없으면 worktree에만 있는 훅을 찾지 못합니다. 어디에서도 파일을 찾지 못하거나 node가 없으면 훅은 명령을 막지 않고 `[guard] …` 경고를 화면에 띄운 뒤 통과시킵니다(fail-open). 그동안 금지 경로·force push·`--no-verify` 같은 하드 규칙은 `settings.json`의 deny 규칙과 `.githooks`가 그대로 지킵니다. 경고가 보이면 파일이 HEAD에 있을 때는 터미널에서 `git checkout -- .claude/hooks`, HEAD에 없으면(아직 병합되지 않은 브랜치, 동기화 전 메인) PR 병합 뒤 `git pull`로 받습니다. 나머지 진입점과 `lifecycle.mjs`도 문제가 생기면 조용히 통과합니다(exit 0).

질문이 뜨면 **기대한 작업일 때만 "이번만 허용"**을 누르고, "항상 허용"은 누르지 않습니다(설정 파일이 느슨해집니다).

설정 파일 자체(`settings.json`, `hooks/`, `.mcp.json`, `flow-reviewer.md`, `.githooks/`, `check-staged.mjs`)는 Claude가 고칠 수 없습니다. 바꾸고 싶으면 Claude에게 **변경안(diff)** 을 받아 Codex에게 적용을 맡기거나 직접 붙여 넣습니다. 그 외 `.claude/` 파일(스킬·규칙·이 안내)은 Claude가 고칠 때 질문이 한 번 뜹니다.

## 3. 외부 연결(MCP)

| 연결 | 방법 | 쓰는 범위 |
|---|---|---|
| Supabase | `.mcp.json` (읽기 전용 `read_only=true`, 프로젝트 하나로 고정, 기능군 database·docs·debugging). 사용자 환경변수 `SIGONGNOTE_SUPABASE_PROJECT_REF`가 필요하고 첫 사용 때 `/mcp` → supabase → Authenticate로 브라우저 로그인 | 스키마·migration 목록·advisor(보안/성능 권고)·문서 검색은 자동. `execute_sql`·`query_logs`는 질문이 뜸. 운영 데이터의 원문·개인정보 행은 조회하지 않음. 쓰기 도구(apply_migration 등)는 URL이 바뀌어도 deny |
| Render | 공식 플러그인(OAuth, 사용자 범위). `/plugin marketplace add render-oss/render-plugin-claude-code` → `/plugin install render` → `/reload-plugins` | 서비스 목록·배포 상태·로그·지표 **읽기만**. create/update/trigger 도구는 질문(ask). 배포는 `docs/ENVIRONMENT.md`의 스크립트로만 |
| Figma · Mobbin | claude.ai 커넥터가 Claude Code에 자동 공유됨 | 화면 참고(`/ui-pass`). Figma의 create 계열 도구는 질문 |

"연결됨"과 "실제로 도구를 썼다"는 다릅니다. 기록할 때 구분합니다. 연결 상태는 세션에서 `/mcp`, 터미널에서는 `node scripts/claude-cli.mjs mcp list`로 봅니다. 토큰·키를 `.mcp.json`·문서·로그에 적지 않습니다.

## 4. 매일 루틴 (복사해서 쓰는 순서)

1. Claude 데스크톱 → 시공노트 폴더 세션 시작. 첫 줄에 `[시공노트 세션 startup]` 브리핑이 보이면 훅이 살아 있습니다.
2. `/briefing` — 10줄 브리핑을 읽고 "진행"이라고 답합니다.
3. `/ncard N31p` (카드 번호는 브리핑에서) — 구현부터 push 질문까지 한 번에 진행합니다. 질문이 뜨면 2절 기준으로 답합니다.
4. DB를 바꾸는 카드면 `/db-migration <목적>`을 먼저, 화면 카드면 `/ui-pass`가 따라옵니다.
5. 묶음이 끝나면 `/handoff-check` — 부족한 항목 표를 받아 정리합니다.
6. Codex(데스크톱)가 작성자인 날은 Codex가 `node scripts/claude-headless.mjs --mode review --request <파일>`로 Claude 검수 1세션을 부릅니다. 같은 커밋을 Claude에서 또 검수하지 않습니다(훅이 같은 HEAD의 두 번째 검수를 막습니다).

## 5. 바꾸고 싶을 때

| 원하는 것 | 고칠 곳 |
|---|---|
| 어떤 명령을 묻지 않게/묻게 하기 | `settings.json`의 `permissions.allow` / `ask` (형식: `Bash(명령 접두어 *)`). Claude에게 diff를 받아 Codex 또는 사람이 저장 |
| 새 반복 절차 | `skills/<이름>/SKILL.md` 하나 추가(머리말 `name`·`description`) |
| 특정 폴더를 건드릴 때만 적용되는 규칙 | `rules/<이름>.md`에 `paths:` 머리말 |
| 훅 동작 | `hooks/*.mjs` 수정 후 `npm run test:hooks`, `npx biome lint .claude/hooks tests/claude-hooks.test.mjs` |
| 종료 알림이 귀찮다 | `settings.json`의 `hooks.Stop` 블록 삭제 |

바꾼 뒤에는 세션에서 `/hooks`, 터미널에서 `node scripts/claude-cli.mjs doctor`로 오류를 확인합니다. 설정 파일은 저장 즉시 반영되며 `model`·`effortLevel`만 세션 시작 때 읽습니다.

## 6. 문제가 생기면

- 명령마다 `[guard] guard.mjs 없음` 또는 `node 없음` 경고가 뜸 → 현재 체크아웃과 메인 체크아웃 어디에도 `.claude/hooks/guard.mjs`가 없거나 Git Bash에서 node를 못 찾는 상태입니다. 명령은 막히지 않지만 셸 가드가 꺼져 있으니, 파일이 HEAD에 있으면 터미널에서 `git checkout -- .claude/hooks`, HEAD에 없으면 PR 병합 뒤 `git pull`(worktree 세션이면 그 브랜치에 병합·pull)로 받고 `npm run test:hooks`로 확인합니다. `git checkout --`은 HEAD에 있는 파일만 되돌립니다.
- `SIGONGNOTE_SUPABASE_PROJECT_REF 미설정` 경고 → Windows 사용자 환경변수를 넣고 Claude 앱을 완전히 종료 후 다시 켭니다(아래 7절 명령).
- 훅이 전혀 안 돈다 → 폴더 신뢰(trust) 대화상자에서 허용했는지, `/hooks`에 SessionStart·PreToolUse·PostToolUse·PostToolUseFailure·Stop이 보이는지 확인. `disableAllHooks`가 켜져 있지 않은지 확인.
- "이미 독립 검수 세션이 있다"고 막힘 → 정상입니다(커밋당 1회). 후속 질문은 SendMessage로 그 검수자에게. 그 세션이 비정상 종료된 것이 확실할 때, 또는 권한 질문에서 거부해 검수가 시작조차 되지 않았을 때만 `.work/claude-runs/reviews/<HEAD>.json`을 지우고 다시 호출합니다.
- `check-staged FAIL` → 비밀값·사용자 홈 폴더(Users 아래) 경로·원문·미승인 바이너리가 stage에 있습니다. 그 파일을 `git restore --staged <파일>`로 빼고 내용을 고칩니다.
- `.mcp.json`의 Supabase가 연결 실패 → 환경변수 미설정이거나 OAuth 미완료. `/mcp` → supabase → Authenticate.

## 7. 한 번만 하는 설정(사용자)

```powershell
[Environment]::SetEnvironmentVariable("SIGONGNOTE_SUPABASE_PROJECT_REF", "<Supabase 대시보드 Project Settings > General > Reference ID>", "User")
```
입력 뒤 Claude 데스크톱을 완전히 종료(트레이 아이콘 우클릭 → Quit)하고 다시 켭니다. Reference ID는 비밀값이 아니지만 저장소에는 적지 않습니다.

## 8. 비용 감각

- Claude Code는 개인 구독 사용량을 씁니다. 세션 시작 브리핑·훅은 토큰을 거의 쓰지 않지만, 큰 파일을 통째로 Read하거나 전체 시험을 매번 돌리면 금방 늘어납니다. 그래서 스킬이 "해당 구간만 읽기·영향 시험만 실행"을 강제합니다.
- 독립 검수 1세션은 과거 기록상 목록가 USD 1~4 수준(`docs/EXECUTION_STATE.md` 참조). 실제 청구와는 다르며 `.work/claude-runs/`에 회차별 사용량이 남습니다.
- Codex(ChatGPT Pro)는 별도 과금입니다. 제품 AI(H03 공급자)는 개인 구독과 섞지 않습니다.
