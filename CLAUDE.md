@AGENTS.md

# Claude Code 작업 메모 (이 저장소)

- 입구 스킬: 재개 `/briefing` · 기능 단위 `/ncard <N번호>` · DB 변경 `/db-migration` · 인계·배포 점검 `/handoff-check` · 화면 `/ui-pass`(정본 [.claude/skills/ui-pass/SKILL.md](.claude/skills/ui-pass/SKILL.md), Codex 진입점 [.agents/skills/ui-pass/SKILL.md](.agents/skills/ui-pass/SKILL.md)). 절차는 스킬 본문이 정본이며 여기서 반복하지 않는다. 경로별 세부 규칙 `.claude/rules/`는 해당 파일을 다룰 때만 로드된다.
- 검수는 커밋당 독립 `flow-reviewer`(Fable 5.1 high) 1세션만. Codex가 작성 → `node scripts/claude-headless.mjs --mode review --request <파일>`; Claude가 작성 → Agent 도구로 flow-reviewer 1회(model 인자 없이; 훅이 같은 HEAD의 중복을 `.work/claude-runs/reviews/<HEAD>.json`으로 막는다). 자기점검·Explore·Codex 플러그인 리뷰·재검수는 검수로 세지 않는다. 검수자는 수정·commit·push·추가 에이전트·별도 API 호출을 하지 않는다(훅이 Git 쓰기를 거부한다).
- 권한은 `.claude/settings.json`(deny > ask > allow)과 `.claude/hooks/*`가 강제한다. 돈·DB·배포·push·외부 서비스 쓰기·설치·보호 파일 편집은 항상 묻는다. 거부·질문을 플래그·설정 복사·`--no-verify`·권한 모드 변경으로 우회하지 않는다. 설명과 매일 루틴은 [.claude/README.md](.claude/README.md).
- 설정 파일(`.claude/settings.json`, `.claude/hooks/`, `.mcp.json`, `.githooks/`, `scripts/check-staged.mjs`, `scripts/check-push.mjs`, `.claude/agents/flow-reviewer.md`)은 Claude가 수정하지 않는다. 변경안은 diff로 제시하고 Codex 또는 사용자가 저장한다.
- 금지 입력: `0.2 ver/`, `.env*`(`.env.example` 제외), 키스토어·인증서, 로그인 자격 파일, `.codex/`, 사용자 미커밋 자료, 이번 검수와 무관한 `.work`. 운영 DB의 원문·개인정보 행은 조회하지 않는다(스키마·migration·advisor만). 조회 결과·로그 원문을 문서·커밋·검수 입력에 복사하지 않는다.
- Git: 자기 파일만 `git add <경로>` → `node scripts/check-staged.mjs` PASS → commit → 즉시 push(승인 질문). `git add .`/`-A`/`-u`, `commit -a`, `--no-verify`, force push·`push :브랜치`, `reset --hard`, `clean`, `checkout --`/추적 경로, `restore --worktree`, `checkout/switch -f`·`--discard-changes`, 공유 stash는 훅이 차단하고 `commit --amend`는 되묻는다.
- MCP: Supabase(`.mcp.json`, 읽기 전용·`SIGONGNOTE_SUPABASE_PROJECT_REF`로 프로젝트 고정·database/docs/debugging), Render(공식 플러그인·OAuth, 목록·로그·지표 읽기만; 배포는 ENVIRONMENT 스크립트로만), Figma·Mobbin(claude.ai 커넥터 공유). "연결됨"과 "실제 도구 사용"을 구분해 기록한다.
- 셸: Windows 11. Bash 도구는 Git Bash(`npm run …`), PowerShell 도구는 5.1(`npm.cmd run …`, `pwsh` 없음). 훅은 Git Bash에서 node로 실행된다. 샌드박스는 Windows에서 동작하지 않으므로 권한 규칙·훅·.githooks가 경계다. 터미널 전용 Claude 명령(MCP 로그인·목록·doctor·플러그인)은 `node scripts/claude-cli.mjs <인자>`. UI 캡처는 `node scripts/ui-shots.mjs --script scripts/ui-flows.json --out .work/ui-pass/<이름>`. 사용자 창·커서·탭을 강제로 움직이지 않는다.
- runner는 `--probe`, `--dry-run`, `--mode review|ui`, 동일 역할·모델·effort의 `--resume <id> --follow <지시>`, 검수 역할의 `--no-mcp`를 지원한다. 완료된 이전 작업의 세션을 새 단위에 재사용하지 않는다. 실행별 원문·사용량·도구 기록은 비공개 `.work/claude-runs/`.
- 상태는 `docs/EXECUTION_STATE.md` 50줄 하나. 세부·사용량·검수 원문은 비공개 `.work`. 문서만 바꾼 커밋을 제품 재검증으로 적지 않는다. 권한/인증/실행 안내는 [환경 문서](docs/ENVIRONMENT.md)가 정본이다. 한국어로 답하고 고유명사는 영어를 병기한다.
