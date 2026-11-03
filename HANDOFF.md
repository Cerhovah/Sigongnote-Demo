# 다음 에이전트 인계

현재 배포 SHA·검수·미완료 상태는 **[docs/EXECUTION_STATE.md](docs/EXECUTION_STATE.md)**를 정본으로 사용합니다. 이 파일은 재개 순서와 검증 명령만 안내합니다.

## 바로 시작할 순서

1. [AGENTS.md](AGENTS.md) → [현재 상태](docs/EXECUTION_STATE.md) → `git status --short`, `git log -5 --oneline`을 확인합니다.
2. [명세](docs/AGENT_SPEC.md)의 현재 N카드·관련 계약만 읽습니다. 실행/연결 문제가 있을 때만 [환경 절차](docs/ENVIRONMENT.md)를 읽습니다.
3. 실제 코드·시험·운영 결과를 확인합니다. 과거 PR 번호나 비공개 출력 폴더가 새 환경에도 존재한다고 가정하지 않습니다.

## 정본과 보존 범위

- 명세 0.5(맥락 복원 에이전트)로 전환했습니다. 제품 판단은 모두 Claude Agent SDK(`services/api/src/claude-runtime.ts`, 기본 `claude-sonnet-5`)를 거치고, 새 문자·자료는 `context-restore.ts`가 기존 기록에서 생략된 맥락을 복원해 `app.work_events`/`app.work_followups`로 남깁니다. 격리 Postgres E2E(`scripts/e2e-db.mjs`, `scripts/run-e2e.mjs`)와 GitHub Actions `e2e.yml`·`device.yml`이 검증 경로입니다. 운영 전환(N09)은 사용자의 H03 준비 뒤 진행합니다.
- README는 실제 서비스·사용 흐름·문서 입구, AGENT_SPEC은 계약, ENVIRONMENT는 실행 절차, EXECUTION_STATE는 현재 사실을 담당합니다. 상세 이력은 Git과 비공개 `.work`에 보존합니다.
- 기존 사용자 승인과 완료 범위는 현재 상태의 해당 행을 따릅니다. 승인된 동일 작업은 재승인 요청하지 않습니다. 새 서버·요금 증설·범위 밖 원문 전송 권한을 뜻하지 않습니다.
- 원본·계정·동의·서명·키·미전송 큐를 유지합니다. 삼성 문자앱을 대체하지 않으며 알림으로 문자 권한을 우회하지 않습니다.
- 사용자 미커밋 자료·`.codex/`·개인 계획 파일은 자동으로 작업 입력이나 commit에 넣지 않습니다. `0.2 ver/`는 열거나 검색하지 않습니다.
- 기존 메뉴·정상 빈 목록·자료를 눌러 여는 흐름을 유지합니다. 상시 설명이나 확인 단계를 임의로 추가하지 않습니다.
- CODE_DONE·운영 배포·실제 기기 사용·PRODUCT_ACCEPTED를 구별합니다. 국소 통과로 기존 전체 시험 실패 이력을 지우지 않습니다.

## 다음 작업과 검증

현재 상태의 `현재 작업`·`잔여 코드 확인`·`잔여 실제 연결` 행을 따릅니다. 제출 불명 작업은 재제출하지 말고 영수증·원격 상태부터 조회합니다.

| 범위 | 명령 |
|---|---|
| 문서·상태 | `node scripts/check-spec.mjs` |
| Node 전체 | `npm test` |
| Python 전체 | `uv run --frozen --project services/document-worker python -m pytest services/document-worker/tests` |
| 계약·타입·빌드 | `npm run contracts:check`; `npm run typecheck`; `npm run build` |
| Android 단위 | `sh apps/android/gradlew -p apps/android :app:testStandardDebugUnitTest :app:testSmsSyncDebugUnitTest :app:testSmsRoleDebugUnitTest :contracts:wireSmoke --no-daemon --max-workers=2` |
| Windows 단위 | Windows에서 `dotnet test apps/windows/tests/Sigongnote.Windows.Tests.csproj -p:RestoreLockedMode=true` |
| 격리 DB E2E(Supabase 없이) | `node scripts/e2e-db.mjs`; `node scripts/run-e2e.mjs --all` |
| 독립 검수 연결 | `node scripts/claude-headless.mjs --probe` |

DB 통합시험에는 로컬 Supabase와 역할 설정이 필요합니다. 시험 중에는 같은 DB 큐를 처리하는 개발 API·작업자를 중지하고, 실행 뒤 필요한 서비스를 다시 시작합니다. Android는 JDK17·SDK36이 필요하며 실기기 시험은 단위 시험과 구별합니다.

저장소 조사·정리 범위와 회귀 결과는 [코드 정리 조사](guides/code-maintenance-audit.md)를 참고합니다. Cloud 환경은 현재 인스턴스 검증·설정 저장·Publish·새 작업 검증을 각각 기록합니다.

독립 검수는 해당 commit마다 Fable 5.1 high 한 세션입니다. 실제 로그인·모델·도구·사용량을 확인하고, 완료된 세션을 새 변경에 재사용하지 않습니다. 사용자에게 해당 작업의 생략을 명시적으로 허용받은 경우만 생략합니다.
