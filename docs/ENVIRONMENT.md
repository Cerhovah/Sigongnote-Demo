# 실행·연결·배포 환경

환경 문제가 있거나 실행 절차가 필요할 때 읽습니다. 현재 배포·검수·실기기 상태는 [EXECUTION_STATE](EXECUTION_STATE.md), 권한과 검수 원칙은 [AGENTS](../AGENTS.md)가 정본입니다. 기존 계정·키·설치 서명·DB·미전송 큐를 재생성하지 않습니다.

## 개발 도구와 로컬 실행

| 영역 | 기준 |
|---|---|
| TS·웹·API | Node/npm은 package.json, 의존성은 package-lock.json |
| 문서 worker | Python·uv는 services/document-worker/pyproject.toml·uv.lock |
| Windows | global.json의 .NET SDK, WebView2 |
| Android | JDK17·Android SDK API36·Gradle wrapper·adb |
| 로컬 DB | 기존 Docker Desktop·Supabase 개발 환경, 운영 reset 금지 |

저장소 루트의 PowerShell7에서 필요한 항목만 실행합니다.

```powershell
git config core.hooksPath .githooks
npm.cmd ci
uv sync --frozen --project services/document-worker
pwsh -NoProfile -File scripts/check-environment.ps1 -Strict
node scripts/check-spec.mjs
```

API·worker·웹은 각각 `npm.cmd run dev:api`, `npm.cmd run dev:worker`, `npm.cmd run dev:web`로 실행합니다. 보호된 개발 환경값은 기존 `.env.product.local`을 사용하며 출력·Git·검수 입력에 넣지 않습니다. 전체시험 대신 [명세 F절](AGENT_SPEC.md)의 영향 범위 국소시험을 선택합니다.

## 확인 화면

| 주소/도구 | 데이터와 용도 |
|---|---|
| https://sigongnote-api.onrender.com/ | 실제 운영 업무 화면 |
| 운영의 /install · /activity | 공개 설치물 · 사용 대시보드 |
| http://127.0.0.1:5189/ | 별도 로컬 DB·회사 작업실, 합성 없음 |
| http://127.0.0.1:5188/ | PC 변경·피드백 창구 |
| loopback Vite + ?work=preview | 내부 합성 UI 회귀 전용, 운영 빌드 제외 |

실제 로컬 작업실은 로컬 Supabase/API/worker가 준비된 후 `pwsh -NoProfile -File scripts/start-live-work.ps1`로 실행합니다. 이 PC에서 기본 API3001이 예약돼 있으면 API의 `PORT`와 작업실의 `SIGONGNOTE_LOCAL_API_PORT`를 같은 사용 가능 포트로 지정합니다(기존 설정33001). 작업실은 정상 JWT/RLS와 별도 회사로 동작하며 공개 인증을 해제하지 않습니다. `.work/live-work/identity.json`을 보존합니다.

API와 worker의 `CLOUD_WORKER_ENABLED=true`, `WORKER_HEARTBEAT_FILE` 경로를 맞춥니다. heartbeat는 처리기 실행 상태이며 판독 품질 인수가 아닙니다. 로컬 서버는 loopback·Host/Origin·HttpOnly 쿠키 경계를 유지합니다. 5190은 실제 서비스 안내이며 합성 제품 서버가 아닙니다.

피드백 서버는 `pwsh -NoProfile -File scripts/start-review-preview.ps1 -Lan`, 상태는 `scripts/lab-service-status.ps1`로 확인합니다. 제품과 PC 확인 창구를 혼동하지 않습니다.

## UI와 에이전트 도구

- 캡처: `node scripts/ui-shots.mjs --script scripts/ui-flows.json --out .work/ui-pass/고유이름`. 설치된 Edge/Chrome을 백그라운드에서 실행합니다. 320/390px·클릭·기대 화면·axe·가로 넘침·콘솔·미지원 route를 검사하며 외부/실자료 API는 차단합니다.
- FAILED는 실패 종료, 글자18px/터치48px 미달은 권고를 포함한 결과로 구분합니다. 실기기·실제 업로드·운영 인수를 대신하지 않습니다. 캡처 중 다른 빌드로 Vite HMR을 유발하지 않습니다.
- 스킬 정본은 [.claude UI 작업](../.claude/skills/ui-pass/SKILL.md), Codex 발견용은 [.agents 진입점](../.agents/skills/ui-pass/SKILL.md)입니다. 요청/결과 양식은 정본 폴더에 둡니다.
- Playwright Core·axe-core는 고정 lockfile을 사용합니다. 별도 브라우저 다운로드·유료 axe 서비스는 필요하지 않습니다. UI 개발 실행기는 contracts→domain→ui 빌드 후 loopback5280을 사용합니다.
- 연결 확인 기록(2026-10-06): Codex Figma·Mobbin, Claude CLI의 Mobbin·Claude Docs·Google Drive·Figma. MCP 연결 상태와 실제 모델 도구 사용을 구별하고 필요할 때만 재확인합니다. Claude axe MCP 실패는 직접 axe-core 캡처로 대체합니다.
- Figma OAuth 갱신이 필요할 때만 `claude mcp login plugin:figma:figma --no-browser`의 링크를 계정 소유자에게 전달합니다. 토큰·인가 코드를 문서/로그에 복사하지 않습니다.

## Claude Code 프로젝트 설정

- 정본: `.claude/settings.json`(권한 allow/ask/deny·훅 연결·MCP 승인·커밋 서명·한국어 응답), `.claude/hooks/guard.mjs`(차단 훅), `.claude/hooks/lifecycle.mjs`(알림 훅), `.mcp.json`(Supabase 읽기 전용), `.ignore`(ripgrep 보관함·.work 제외), `.claude/rules/`(경로별 규칙), `.claude/skills/`(briefing·ncard·db-migration·handoff-check·ui-pass), `.claude/agents/flow-reviewer.md`(유일 검수자). 파일별 역할·매일 루틴·문제 해결은 [.claude 안내](../.claude/README.md)입니다. 데스크톱 Code 탭과 헤드리스 runner가 같은 파일을 읽습니다. 폴더 신뢰(trust)를 수락한 뒤에만 allow 규칙·MCP 자동 승인이 적용되고 deny/ask는 즉시 적용됩니다.
- 훅: PreToolUse `guard.mjs`는 셸 명령의 `0.2 ver/`·`.env*`·인증서·자격 파일·`.codex/` 언급, 비밀 환경변수 참조·전체 출력, `--no-verify`·force push·원격 브랜치 삭제(`--delete`/`:브랜치`)·`reset --hard`·`clean`·작업 트리 되돌리기(`checkout --`/추적 경로·`restore --worktree`·`checkout/switch -f`·`--discard-changes`)·전체 stage·`commit -a`·공유 stash·원격 DB reset을 막고 `commit --amend`는 되묻고, `git commit` 직전 `core.hooksPath`와 `node scripts/check-staged.mjs`를 확인합니다. 커밋 메시지(`-m`) 본문은 검사에서 빼되 명령 치환(`$(…)`·백틱)이 든 메시지와 `-F/--file` 파일 인자는 그대로 검사합니다. 비밀 변수는 셸 확장(`$NAME`·`%NAME%`·`$env:NAME`)이면 어디서나, `process.env.NAME` 같은 코드 문자열이면 rg/grep/Select-String 검색 조각 밖에서만 막습니다(사용처 검색은 허용). 훅 스크립트는 `settings.json`의 명령이 '현재 체크아웃(명령 폴더의 git 최상위) → `CLAUDE_PROJECT_DIR` → 현재 폴더' 순서로 찾습니다. worktree 세션(데스크톱 worktree 옵션)에서는 `CLAUDE_PROJECT_DIR`가 세션을 시작한 메인 체크아웃에 고정되므로(공식 hooks·worktrees 문서) 이 순서가 없으면 worktree에만 있는 훅을 찾지 못해 셸이 전부 막힙니다. 어디에서도 스크립트를 찾지 못하거나 node가 없으면 모든 진입점이 명령을 막지 않고 `[guard] …` systemMessage 경고를 띄운 뒤 통과합니다(fail-open). 하드 규칙(금지 경로·force push·`--no-verify` 등)은 `settings.json`의 deny와 `.githooks`가 계속 지키고, `lifecycle.mjs`(세션 브리핑·biome 1파일 lint·상태 50줄·종료 알림)는 항상 통과형입니다. 복구는 파일이 HEAD에 있을 때 `git checkout -- .claude/hooks`, HEAD에 없으면(병합 전 브랜치·동기화 전 메인) PR 병합 뒤 `git pull`입니다. 같은 HEAD의 두 번째 flow-reviewer는 runner의 예약과 같은 파일 `.work/claude-runs/reviews/<HEAD>.json`으로 거부합니다. 검수자 세션(`agent_type`)에서는 Git 쓰기·설치·DB·배포 명령을 거부하되 `branch --show-current/-a/-r/-v`·`tag -l`·`worktree list`·`stash list/show` 같은 조회는 허용합니다. `.githooks`는 그대로 유지되며 Claude 훅이 이를 대체하지 않습니다. 훅 시험은 `npm run test:hooks`(`npm test`에도 포함)이며 settings.json의 훅 명령을 Git Bash로 그대로 실행해 폴백 체인도 검사합니다.
- MCP: OAuth만 쓰고 키를 파일에 쓰지 않습니다. Supabase는 사용자 환경변수 `SIGONGNOTE_SUPABASE_PROJECT_REF`(프로젝트 Reference ID, 비밀 아님)로 한 프로젝트에 고정하고 `read_only=true`·`features=database,docs,debugging`만 켭니다. 변수가 없으면 그 서버만 연결 실패로 남고 다른 기능은 정상입니다. 첫 사용 시 세션에서 `/mcp` → supabase → Authenticate로 브라우저 로그인합니다. `execute_sql`·`query_logs`는 질문이 뜨고 쓰기 도구는 deny입니다. Render는 공식 플러그인(`/plugin marketplace add render-oss/render-plugin-claude-code` → `/plugin install render`, OAuth, 사용자 범위)으로 목록·로그·지표를 읽기만 하며 배포는 아래 배포 절차로만 합니다. Figma·Mobbin은 claude.ai 커넥터를 공유하므로 `.mcp.json`에 중복 등록하지 않습니다.
- 한계와 변경: Read deny는 Bash의 cat/head/tail/sed·리다이렉션에 최선 적용이며 GNU grep·스크립트의 간접 읽기는 막지 못하므로 `.ignore`와 훅이 보완합니다. 네이티브 Windows는 샌드박스가 없어 권한 규칙·훅·.githooks가 경계이고 OS 격리는 아닙니다. 설정 파일(`settings.json`·`hooks/`·`.mcp.json`·`.githooks/`·`check-staged.mjs`·`check-push.mjs`·`flow-reviewer.md`)은 Claude가 수정하지 않고 diff를 제시하며 Codex 또는 사용자가 저장합니다. 터미널 점검은 `node scripts/claude-cli.mjs doctor`, `node scripts/claude-cli.mjs mcp list`(PATH에 claude가 없어도 데스크톱 번들 CLI를 찾습니다). 설정 변경은 저장 즉시 반영되며 `model`·`effortLevel`만 세션 시작 시 읽습니다.
- 헤드리스 runner(`scripts/claude-headless.mjs`)는 `--allowedTools`와 `dontAsk`를 자체 지정하지만, `-p` 실행에도 프로젝트 `settings.json`의 allow/ask/deny 규칙과 훅이 그대로 적용됩니다(`--bare`만 예외). 따라서 runner 세션도 `Bash(git add *)`·`Bash(git commit *)` 같은 프로젝트 allow 규칙을 물려받으며, 검수 세션의 읽기 전용은 `guard.mjs`의 `agent_type` 검사와 runner의 `--disallowedTools Edit Write`가 보장합니다. 검수 역할은 `--no-mcp`로 `.mcp.json` 연결을 끊고 실행할 수 있습니다. Codex 플러그인(`/codex:review` 등)은 설치하지 않으며 설치되어도 리뷰 명령은 Skill deny입니다(검수 1회 규칙).

## 독립 Claude 검수

`node scripts/claude-headless.mjs --probe`로 실제 CLI·claude.ai/firstParty·구독·MCP를 확인합니다. `--dry-run --mode review --request <파일>`은 인증·모델 호출·로그 생성을 하지 않습니다.

```powershell
node scripts/claude-headless.mjs --mode review --request .work/현재단위/review-input.md
```

Codex 작성 시 독립 Fable 5.1 high 한 세션이 읽기·국소시험·설계 제안을 담당합니다. 검수 원칙은 [명세 F절](AGENT_SPEC.md)을 따릅니다. Claude가 작성한 작업은 독립 하위 검수자를 사용하며 두 경로를 중복 호출하지 않습니다. UI 작성 모드는 `--mode ui`, 추가 effort는 사용자 지정이 있을 때만 사용합니다.

동일 세션 후속은 `--resume <id> --follow <지시>`입니다. 역할·모델·effort와 HEAD별 예약을 유지합니다. 과거 완료 세션을 새 단위에 재사용하지 않고, 중단/결과불명을 성공으로 표시하거나 새 세션으로 조용히 재시도하지 않습니다.

실행별 `.work/claude-runs/시각-역할-세션-실행ID/`에 invocation/prompt/events/stderr/result/exit를 보존합니다. 실제 modelUsage·도구 실행·거부·계정 과금 경로를 기록합니다. 목록환산 USD와 실제 청구액은 다릅니다. 제품 API 키나 별도 공급자 override를 검수에 전달하지 않습니다.

`dontAsk`와 `allowedTools`는 OS 격리가 아닙니다. 필요한 정확한 명령만 `--allow`로 추가하고 권한 우회·광범위 acceptEdits·settings 제안본 자동 복사를 하지 않습니다. UI 세션의 MCP는 ToolSearch와 필요한 정확한 도구명으로 연결합니다. 읽기 검수 역할은 MCP를 노출하지 않습니다. 레거시 `run-claude-review.mjs`는 기존 단위 재현 때만 사용합니다.

## Claude Agent SDK 런타임 (제품 판단)

- 제품의 모든 판단(요청 이해·의미 추출·문자 선별·맥락 복원·PC 요약)은 `services/api/src/claude-runtime.ts`가 `@anthropic-ai/claude-agent-sdk`의 `query()`로 실행합니다. 내장 파일·셸 도구는 끄고(`tools: []`), 서버가 회사 범위로 묶은 in-process MCP 도구만 노출하며, 구조화 출력만 제품에 들어옵니다. 프로젝트 `.claude` 설정은 읽지 않습니다(`settingSources: []`).
- 설정은 프로세스 환경변수뿐입니다: `ANTHROPIC_API_KEY`(필수, Render 비밀), `AI_PROVIDER=claude`, `CLAUDE_AGENT_ENABLED=true`, `CLAUDE_AGENT_MODEL`(기본 `claude-sonnet-5`), 선택 `CLAUDE_AGENT_PRICE_JSON`·`CLAUDE_AGENT_MAX_USD`(호출당 USD 상한, 기본 0.5). `SEMANTIC_*`를 명시하면 그 공급자가 우선합니다. `CAPTURE_POLICY_JSON.provider`는 `anthropic`, `external_processing`은 `true`여야 선별·의미 추출·맥락 복원이 돕니다. `AI_PROVIDER=fixture`는 모델 없이 규칙만 쓰는 모드입니다.
- 사용량은 기존 `app.product_ai_usage` 원장에 그대로 예약→제출→정산합니다(채널 `context`는 맥락 복원·PC 요약). 가격표는 보수적 KRW 환산이며 실제 청구액과 다릅니다. 결과 불명은 0원으로 쓰지 않습니다.
- 기존 OpenAI 장기 음성을 함께 쓰는 경우 `CAPTURE_POLICY_JSON.processors`에 `purpose: "long_stt"`, `provider: "openai"`, 실제 처리/저장 위치와 보존 조건을 명시합니다. 이 항목은 장기 음성만 허용하며 주 처리자의 의미 추출 권한을 바꾸지 않습니다. 원천 등록과 회사 AI 허용에서 전체 정책을 다시 확인하고 전달해야 하며 기존 원천에 처리자나 동의를 자동 추가하지 않습니다. 설정 저장·키 존재·실제 공급자 응답·고객 자료 처리는 각각 구별합니다.
- 짧은 음성은 `SHORT_STT_FFPROBE`가 가리키는 실제 해석 도구가 있어야 시작합니다. 운영 이미지는 Debian `ffmpeg`의 `ffprobe`를 포함하고, 네트워크 없이 실제 배포 모듈로 합성 WAV의 길이를 해석하는 검사를 실행합니다. 도구가 없는 기존 이미지에서 enabled/key만 확인해 연결 성공으로 표시하지 않습니다.
- PC 설치본은 키를 갖지 않습니다. "AI 요약"은 같은 계정 세션으로 `/v1/ai/document-summary`에 발췌만 보내고 서버가 Claude를 실행합니다.

## 격리 Postgres E2E와 CI

- Supabase CLI·Docker 없이 `node scripts/e2e-db.mjs`가 평범한 PostgreSQL(16/17)에 auth/storage 최소 shim과 migration 전량을 적용하고 `.work/e2e/env.json`과 API 환경파일을 만듭니다. `SIGONGNOTE_E2E_DB=1`이면 `scripts/db-gate.mjs`가 이 DB를 READY로 판정해 기존 DB 시험 전체가 그대로 돕니다. 격리 복제 DB(`sigongnote_drill_seed_*`)도 같은 방식으로 만듭니다.
- 공통 `rootTestCatalog()`는 모든 root `.test.ts`·`.test.tsx`·`.test.mjs`를 unit/일반 PostgreSQL/실제 Supabase 중 정확히 한 곳에 배치합니다. `tests/` helper의 전이 의존성도 검사합니다. `node scripts/run-unit.mjs`가 현재 OS에서 실행할 수 있는 unit 전량을 실행하고 파일 목록·실제 집계를 남기며 skip·0건·timeout은 실패입니다. Windows 전용 시험은 Linux 집계에 `NOT_RUN/PLATFORM_NOT_SUPPORTED`로 명시하고, 기존 Windows device job의 `--platform-only` 실행과 별도 결과 artifact로 실제 검증합니다. `e2e.yml`의 실제 Supabase 준비 뒤 Python 전체 pytest도 실행합니다. 합성 서버 복원 시험은 해당 child에만 hosted Linux·격리 opt-in을 주고 현재 로컬 서비스 READY를 첫 쓰기 전에 확인합니다. 운영 원본이나 기존 복원 기록을 덮어쓰지 않습니다.
- 실행: `node scripts/run-e2e.mjs`(핵심 E2E 녹화 재생 + DB 시험 묶음 + tenant 경계 오라클), `--all`(격리 Postgres에서 도는 DB 시험 전체; 실제 Supabase Auth/Storage 클라이언트·Docker 복원 도구·Vault·문서 워커가 필요한 파일은 공통 `scripts/e2e-test-catalog.mjs`의 이름·이유와 함께 `NOT_RUN`으로 남김), `--live`(실제 Claude), `--record`(fixture 갱신). 실제 Auth/Storage·복구 도구가 필요한 파일은 모두 `e2e.yml`의 별도 `supabase-integration` job이 GitHub-hosted 임시 Linux VM에서 npm 고정 Supabase CLI·loopback Auth/Storage·Python·나눔 글꼴을 준비해 실행합니다. 공급자 키 없이 모델은 fixture/예산 0이며, 파일별 시간 제한·40분 job 제한을 두고 skip·0건·시간 초과를 성공으로 처리하지 않습니다. 종료 때 해당 VM의 로컬 프로젝트만 정리하고, `local-supabase-integration-status` artifact에는 파일명·상태·집계·오류 코드·숫자 소스 줄만 남깁니다. CLI 출력·환경파일·원문 로그는 업로드하지 않습니다. `node scripts/run-supabase-e2e.mjs --list`로 목록을 확인하며, 실제 통합 결과는 해당 Actions 실행 결과로 판정합니다. `SIGONGNOTE_E2E_DB=1 npm run test:tenant`는 같은 오라클(`supabase/tests/tenant_boundary.sql`)만 격리 DB에서 돌립니다. 핵심 E2E는 `tests/e2e/context-restore.e2e.test.ts`, 녹화는 `fixtures/claude/context-restore.json`입니다.
- 사람이 보는 검증 기록: `SIGONGNOTE_E2E_DB=1 node --import tsx scripts/e2e-showcase.mts`가 가상 회사 2곳으로 같은 흐름(맥락 복원→오늘 화면→완료→질문→경계·멱등)을 실제 Claude로 돌리고 단계별 `run.json`과 화면 PNG를 비공개 `.work/showcase/`에 남깁니다. 시험이 아니라 시연 기록이며 CI에 넣지 않습니다.
- GitHub Actions: `e2e.yml`은 push/PR마다 Postgres 서비스 위에서 typecheck·단위·DB 시험·핵심 E2E를 돌리고, `live` job은 실행 요청과 저장소 비밀 `ANTHROPIC_API_KEY`가 모두 있을 때 실모델로 같은 E2E를 반복합니다. 키가 없으면 eligibility artifact에 `NOT_RUN`을 남기고 실제 job은 skipped입니다. `device.yml`의 야간 실행과 수동 기본 `all`은 GitHub-hosted Android 에뮬레이터·`windows-2025` 네이티브 `dotnet test`를 실행합니다. Windows는 `global.json` SDK와 WebView2 Runtime을 사용하고, 실제 계정/API fixture가 필요한 미실행 시험은 TRX와 `verification-scope.json`에 남깁니다. 이는 물리 PC 설치·실계정·실폰 인수가 아닙니다. USB 갤럭시는 저장소 변수 `SIGONGNOTE_DEVICE_RUNNER_ENABLED=true`와 수동 `device` 또는 `all` 선택이 모두 있을 때만 기존 self-hosted `sigongnote-device` runner에서 `scripts/device-android.ps1`을 실행합니다. 비활성·미요청은 `physical-usb-eligibility` artifact에 `NOT_RUN`으로 남깁니다. runner 등록은 사용자가 저장소 Settings → Actions → Runners에서 수행하며, 워크플로가 runner·토큰·서명을 생성하지 않습니다.

## 제품 데이터·모델·인증

- 사용자별 KST 월5만원/일1만원, 연결 자료100GB 한도를 함께 적용합니다. 기기 임시 사본·파일별 처리 상한과 구분합니다. 발견/보관/판독/색인 상태를 분리하고 CAD는 판독하지 않습니다.
- 최초 동의한 채널과 범위만 처리합니다. 정상 상태에서 동의를 반복 요구하지 않으며 범위 확대·철회·OS 권한은 별도로 확인합니다. 원본·미전송 큐·키를 보존합니다.
- API/worker/migration DB 역할을 분리합니다. 서버 secret은 기존 보호 저장소/호스팅 설정에만 두고 클라이언트에는 공개 endpoint/key만 제공합니다. 실제 설정 schema와 `.env.example`이 키 이름의 정본입니다.
- 후보 추출과 업무 실행은 위 Claude 런타임(기본)이나 명시한 `SEMANTIC_PROVIDER/API_KEY/MODEL/PRICE_JSON`을 사용하며 `CAPTURE_POLICY_JSON`이 필요합니다. 개발 Fable 구독과 제품 AI 비용은 별개입니다.
- 기존 보수 예약표는 2026-11-01 전에 갱신합니다(입력100만 토큰5,500원/출력22,000원, 짧은 STT 분당30원). 실제 시세·청구액을 뜻하지 않습니다. 결과불명 비용을 0으로 만들거나 자동 재호출하지 않습니다.
- 짧은 음성은 `SHORT_STT_ENABLED/API_KEY/FFPROBE/PRICE_JSON`, 장문은 `LONG_STT_PROVIDER/MODEL/API_KEY/PRICE_JSON` 및 tenant/global 시간 예산을 확인합니다. OpenAI/Clova 공급자를 동의 없이 교체하지 않습니다. 정확한 장문·실발화 인수는 별도입니다.
- 기존 네이버 `custom:naver` 로그인과 회사 멤버 권한을 보존합니다. 사전 검수/테스터·다른 개인 계정·LTE·네이티브 복귀의 실제 확인은 현재 상태에서 구분합니다. 단체 아이디를 개인 로그인/회사 계정으로 임의 병합하지 않습니다. 카카오 추가는 H02입니다.
- PDF는 구간별 이어 읽기와 저장 커서를 사용합니다. `WORKER_PDF_BATCH_PAGES`는 1–200(기본20)이며 입력 크기와 실제 OCR 성능을 구분합니다.

## 배포·설치·복원

기존 Render 2GB/월USD25·Singapore·Supabase를 유지합니다. 새 자원·결제는 기존 승인에 포함되지 않습니다. 이번 운영 웹/설치 앱 업데이트의 사용자 승인은 [현재 상태](EXECUTION_STATE.md)에 기록하며 같은 배포를 재승인 요청하지 않습니다.

1. 정확한 커밋과 이전 정상 `image.json`을 고정합니다. 사용자 미커밋 파일을 포함하지 않는 별도 checkout에서 빌드합니다. sourceDirty=false, 기존 설치 서명·원본·큐 보존이 조건입니다.
2. DB 변경이 있으면 운영 암호화 백업·해시를 확인하고 네트워크 없는 별도 DB에서 전량 복원·migration·RLS/구버전 호환을 검증합니다. 운영 reset/down은 금지합니다. 이력이 유지되는 migration 도구로만 적용합니다.
3. `scripts/package-cloud-clients.ps1 -PublicConfigPath <공개연결JSON> -OutputDirectory <새폴더>`로 Android/Windows를 만듭니다. code/version·설치 표시·download redirect를 일치시킵니다. 기존 signing 파일을 재생성하지 않습니다.
4. 공개 저장소 `Cerhovah/Sigongnote-downloads`에 APK/Windows ZIP/Setup.exe/해시/BUILD/설치 스크립트/Windows manifest 해시를 게시합니다. 인증 없는 새 다운로드의 상태·7개 해시를 대조한 뒤 서버를 전환합니다. 사설 문자연결 APK는 공개 기본 앱과 분리합니다.
5. GitHub Actions `release-image.yml`의 정확 SHA 이미지를 사용합니다. codex/site-navigation push가 빌드를 시작하며 main은 workflow_dispatch로 지정할 수 있습니다. 고정 git archive→Python PDF/JPEG/XLSX 런타임→비공개 GHCR→digest 재다운로드 검증을 통과해야 합니다.
6. 기존 Render 서비스·플랜·region·자동 Git배포 꺼짐·/health/ready·현재 정상 digest를 확인하고 아래 배포기를 실행합니다. 현재/새 SHA·tar hash 및 DB/migrations/worker readiness가 함께 일치해야 완료입니다.

```powershell
node scripts/release-control.mjs prepare <새40자리SHA> <이전40자리SHA>
node scripts/publish-release.mjs <새40자리SHA> <이전40자리SHA> --publish
node scripts/render-release.mjs inspect
node scripts/render-release.mjs deploy <새image.json> <이전image.json>
node scripts/release-control.mjs verify https://sigongnote-api.onrender.com/ <새SHA> <archive_sha256>
```

CI 이미지를 사용하면 로컬 publish는 반복하지 않습니다. `GH_TOKEN`·`RENDER_API_KEY`는 기존 자격 저장소에서 프로세스에만 연결합니다. 명령 인수·결과·검수에 비밀값을 출력하지 않습니다. CLI 로그인 표시와 Git 자격 저장소의 인증은 다를 수 있습니다.

Render API 자격이 없고 기존 로그인된 관리 화면을 사용할 수 있으면 동일 검증을 지킨 채 Settings → Image에서 정확 digest와 기존 registry credential을 선택하고, 저장 결과를 확인한 뒤 Manual Deploy → Deploy latest reference를 한 번 실행합니다. 새 자격 발급은 필요하지 않습니다. 배포 ID·digest·플랜·region·건강 검사와 외부 `verify` 결과를 해당 비공개 릴리스 폴더에 보존합니다.

이미지 게시만으로 배포를 주장하지 않습니다. 배포 제출 불명은 자동 재제출하지 않으며 상태를 조회합니다. 준비 실패 시 이전 digest로 복귀하되 DB·원본·큐를 보존합니다. 정상 배포 후 이미지 포인터 갱신만 실패하면 새 정상 이미지를 불필요하게 되돌리지 않습니다. `.work/render-releases` 영수증에 단계별 결과를 남깁니다.

Windows 업데이트는 기존 `scripts/install-windows-client.ps1`과 manifest 해시를 사용합니다. 실행 중 구판을 강제 종료하거나 계정/큐를 지우지 않습니다. Android는 같은 package/signature와 증가한 versionCode로 설치합니다. USB 연결·실제 촬영·OS 권한·사용자 인수는 설치 파일 게시와 별도로 확인합니다.

복원은 DB/Auth/Storage 원문 참조·동의·삭제·기기 큐와 DPAPI/Keystore 의존성을 구분합니다. DB 백업만으로 다른 기기의 키 복구나 전체 제품 복원을 완료했다고 하지 않습니다. 결과불명 발송을 다시 실행하지 않습니다.

## 별도 연결 게이트

H02 인증, H03 제품 AI 예산, H04/H05 음성·기기, H06 업무 기준, H07 팩스, H08 SMS, H09 운영·복구, H10 실제 사용은 [명세 B절](AGENT_SPEC.md)의 해당 조건만 대기합니다. 한 항목으로 독립 작업을 멈추지 않습니다.

PDF 공유와 일반 청구서는 공급자 없이 사용할 수 있습니다. 법정 전자계산서는 사업자 계약·인증서·국세청 전송/정정·비용 조건을 별도로 확인합니다. 팩스는 계정·발신번호·수신처·유효기간·장당/일/월 한도 승인 후 활성화하며 번호/키는 서버에만 둡니다. 제출 전 취소와 제출 후 불명을 구별하고, 불명 자동 재전송은 하지 않습니다.
