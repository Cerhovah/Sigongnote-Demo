---
name: ncard
description: N카드 한 단위를 AGENTS 6번 순서로 끝낸다 — 구현 → 국소검증 1묶음 → 독립 flow-reviewer 1세션 → P0/P1 수정·영향 재검증 → 자기 파일만 stage → check-staged PASS → EXECUTION_STATE 갱신 → commit → push 확인. "N31p 구현해", "이 카드 진행", "커밋까지 해줘", "검수 돌려"에 사용. 검수를 두 번 부르지 않는다.
argument-hint: "<N카드 번호> [목표 한 줄]"
---

# N카드 실행 루프 (`$ARGUMENTS`) — 한 단위 = 한 커밋

기준 SHA: !`git rev-parse --short HEAD` · 브랜치: !`git branch --show-current`

## 0. 고정
- 카드 행(AGENT_SPEC E절)과 의존 카드의 공개 계약만 읽는다(/briefing 결과가 있으면 재사용). 10줄 안에 적는다: 목표 사용자 행동, 허용 파일(소유), 의존 완료 여부, 영향 범위(문서/TS/공통 계약/money/DB·RLS/worker/Python/Windows/Android/공통 웹), 알려진 실패, 시험 선택자.
- 같은 migration·계약·화면 파일은 한 작성자 소유. 다른 작성자(Codex 세션)가 소유 중이면 멈추고 사용자에게 한 줄로 알린다.
- 설계 선택이 갈리거나 파일 5개 이상을 건드리면 먼저 계획(Plan)으로 접근을 적고 확인 뒤 구현한다.
- 사용자 미커밋 자료·`0.2 ver/`·`.env*`는 입력이 아니다.

## 1. 구현
- 도메인(`packages/domain`) → API(`services/api`) → 화면(`apps/web`) 순으로 실제 접점까지 연결한다. AI는 후보만 만들고 금액·상태·효과는 TS domain/API/DB가 확정한다. unknown≠0, 요청≠승인, 파일≠거래. 원본 이동·삭제·덮어쓰기 없음.
- tenant·동의·근거·버전·멱등키·보정 이력을 유지한다. 새 영속 테이블·버킷·큐·모델/프롬프트 버전은 같은 커밋에서 복원 manifest·복원 시험에 등록한다.
- migration은 `/db-migration`, 화면은 `/ui-pass`(320/390px 캡처) 절차를 따른다. wire 계약 변경은 생성기 산출물(TS/JSON/OpenAPI/C#/Kotlin)을 같은 커밋에 맞춘다.
- 새 시험은 가장 가까운 기존 책임의 시험 파일에 추가하거나 `tests/agent-<책임>.test.ts`를 만든다. 줄 수·파일 존재만 확인하는 시험은 결과를 대신하지 못한다.

## 2. 국소검증 1묶음 (실제 존재하는 명령만, AGENT_SPEC F)
영향 범위에 해당하는 행만 골라 한 번에 실행하고 결과(통과/실패 수)를 기록한다. Bash 도구는 `npm`, PowerShell 도구는 `npm.cmd`.

| 영향 | 명령 |
|---|---|
| 문서만 | `node scripts/check-spec.mjs`, `git diff --check` |
| TS 계약·코드 | `npm run typecheck`, `npx biome lint <변경 경로>`, `node --import tsx --test --test-concurrency=1 <변경 책임의 시험 파일>`; 배포/연결 영향 시 `npm run build` |
| 공통 wire 계약 | `npm run contracts:generate`, `npm run contracts:check`, `npm run test:contract`, `npm run contracts:native` |
| 돈(G-M) | `node --import tsx --test --test-concurrency=1 tests/invoice.test.ts tests/cash.test.ts tests/charge-api.test.ts tests/quote-api.test.ts tests/quote-scope.test.ts` |
| DB/RLS | `npm run check:db`, `npm run test:tenant`, 새 migration은 `/db-migration`의 격리 fresh/upgrade/replay + 권한·영향 API 시험 |
| worker | `tests/jobs.test.ts`, `tests/parse-worker.test.ts`, `tests/worker-health.test.ts` 중 영향 파일을 TS runner로 |
| 의미·판단 | `tests/organization.test.ts`, `tests/claims.test.ts`, `tests/attribution.test.ts`, `tests/work-decisions-api.test.ts` + 새 기능 시험 |
| Python worker | `uv run --locked --project services/document-worker pytest <변경 parser/renderer 시험> -q` |
| Windows | `dotnet test apps/windows/tests/Sigongnote.Windows.Tests.csproj --no-restore --filter "FullyQualifiedName~<변경 클래스>"` |
| Android | `./scripts/check-android.ps1 -Tasks @(':app:testStandardDebugUnitTest',':app:assembleStandardDebug')` (PowerShell) |
| 공통 웹 | 변경한 `tests/work-*.test.tsx` 명시 실행 + `node scripts/ui-shots.mjs --script scripts/ui-flows.json --out .work/ui-pass/<카드>` |
| 도구(.claude/hooks, scripts) | `npm run test:hooks`(= `node --test tests/claude-hooks.test.mjs tests/agent-tools.test.mjs`; `npm test`에도 포함됨), `node --test tests/doc-boundary.test.mjs` |
| staging | `node scripts/check-staged.mjs` PASS (git commit 직전 훅이 자동 재실행) |

실패는 원인을 고치고 영향 부분만 다시 실행한다. 실패·미실행을 PASS로 적지 않는다. 존재하지 않는 명령을 실행한 것처럼 적지 않는다. 환경값·URL은 출력하지 않는다.

## 3. 독립 검수 1세션 (커밋당 정확히 한 번)
- 작성자가 Claude(이 세션)이면 Agent 도구로 `flow-reviewer`를 **한 번** 호출한다(model 인자 없이). 훅이 같은 HEAD의 두 번째 호출을 `.work/claude-runs/reviews/<HEAD>.json`으로 막는다. 작성자가 Codex이면 Codex가 `node scripts/claude-headless.mjs --mode review --request <패킷 파일>`로 부르므로 Claude는 패킷만 쓰고 여기서 부르지 않는다. 자기점검·Explore·Codex 플러그인 리뷰는 검수가 아니다.
- 검수 패킷(`.work/<단위>/review-input.md`에도 저장. 상대 경로만, 비밀값·개인 경로·원문·소스 전체 붙이기 금지 — runner도 같은 개인정보 검사를 통과해야 한다):

```
N카드: <ID와 한 줄 목표>
기준 SHA: <git rev-parse HEAD>
변경 파일과 hash: <경로> <git hash-object 경로> … (SHA-1 blob)
요구: <AGENT_SPEC 카드 행 요약과 줄 번호>
관련 계약 위치: <AGENT_SPEC 절·줄>, <호출 경로 파일:줄>, <권한/DB 계약 위치>
작성자 실행 결과: <명령 → 통과/실패 수>
미검증: <실행하지 못한 것과 이유>
국소시험 명령: <검수자가 그대로 실행할 수 있는 명령 목록>
설계 질문 1개: <…>
```

- 결과: P0(데이터·돈·보안)·P1(흐름 회귀)은 반드시 고친다. P2·설계 제안(3개 이하)은 채택 여부를 적는다. 재검수 호출 없음 — 후속 질문은 SendMessage로 같은 검수자에게. 검수가 중단·거부·한도로 끝났으면 REVIEW_BLOCKED로 기록하고 push하지 않는다.

## 4. 수정 → 재검증 → 마무리
1. P0/P1 수정 → 영향 부분만 2단계 명령 재실행. 큰 재설계는 다음 단위로 분리하되 현재 단위의 필수 동작이 빠지면 완료 처리하지 않는다.
2. `docs/EXECUTION_STATE.md`를 50줄 안에서 갱신(현재 작업·현재 기준 SHA·구현 이력·검수 모델/effort/세션/P0P1·목록환산 USD와 실청구 구분·미검증·다음 실행) → `node scripts/check-spec.mjs`. 상세 원문·사용량은 `.work/<단위>/`.
3. 자기 파일만 이름을 적어 `git add <파일…>` (`-A`/`.`/`-u`·`commit -a`는 훅이 막는다. 사용자 미커밋 파일·`.work`·`.env` 제외) → `node scripts/check-staged.mjs` PASS.
4. `git commit -m "<type>(<scope>): <요약>"` (예 `feat(ui): …`, `fix(api): …`, `docs: …`, `chore(agents): …`). 훅이 stage 검사를 한 번 더 한다.
5. `git push origin <브랜치>` — 승인 질문이 뜨면 사용자가 허용한다. 실패하면 같은 커밋의 전송만 복구하고 검수를 다시 부르지 않는다. `git rev-parse HEAD`와 `git ls-remote origin <브랜치>`로 원격 SHA 일치 확인. main 직접 push는 사용자 승인 뒤에만.
6. 보고: 변경 파일, 실행한 명령과 결과, 검수 P0/P1/P2 처리, 미검증, CODE_DONE / LIVE_ACCEPTED / PRODUCT_ACCEPTED 구분. 과금 경로(개인 Claude 구독)와 사용량은 `.work/<단위>/`에 남긴다.
