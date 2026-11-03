# 시공노트 구현 명세 0.5 — 맥락 복원 에이전트

제품 **0.3**, 명세 **0.5**. 현재 사실은 [EXECUTION_STATE](EXECUTION_STATE.md), 실행 절차는 [ENVIRONMENT](ENVIRONMENT.md), 권한은 [AGENTS](../AGENTS.md)가 정본이다. 이 문서는 후속 개발의 유일한 실행 명세이며 0.4 패치 계약과 사진대지·N30 이후 운영 단위는 폐기했다. 필요한 과거 계약은 Git 이력에서만 본다.

## A 목적과 역할 분담

**새 문자·녹음·자료가 들어오면, 그 말이 이어지는 기존 대화와 업무를 찾아 생략된 맥락을 복원하고, 새 사실·변경·요청·문제를 업무 사건으로 남겨 오늘 할 일을 계속 추적한다.** 분류는 결과를 찾아보는 정리 체계이지 내부 판단 구조가 아니다.

| 맡는 쪽 | 하는 일 | 하지 않는 일 |
|---|---|---|
| Claude (Claude Agent SDK, 기본 `claude-sonnet-5`) | 어떤 자료를 더 읽을지, 어느 대화·현장·업무와 이어지는지, 한 문장이 몇 개의 사건인지 자유롭게 해석. 필요한 만큼 도구로 탐색·서브에이전트 분기 | 거래량·입금·납품 완료·현장 생성·발송 승인 등 효과 확정 |
| 시공노트 (TS domain → API → Postgres) | 사건·할 일·근거·비용을 기억하고 운영. 현장 ID 검증, 예산 예약·정산, 멱등·버전·회사 격리 | 모델 문장을 사실로 승격 |

핵심 사례: "사장님, 그때 말씀하셨던 곳 물량 안 들어왔어요" → 전날 통화 "망원동 문틀 100개 오전 발송"을 찾아 **납품 지연 사건 + 할 일 "망원동 문틀 100개 입고 확인 및 공급처 연락"**. 과거 대화에 대상이 없으면 **"물량 미도착 신고 접수, 대상 현장 미특정"** 사건을 만들고 현장을 만들어내지 않는다. 이 두 경로가 E2E의 합격 기준이다(`tests/e2e/context-restore.e2e.test.ts`).

| 완료 상태 | 판정 근거 |
|---|---|
| CODE_DONE | 격리 Postgres E2E·국소시험·독립 검수·push 완료. 녹화 fixture 재생 통과는 코드 완료 증거 |
| LIVE_ACCEPTED | 실제 Claude 자격·실제 계정·실기기에서 같은 E2E와 기기 lane 통과 |
| PRODUCT_ACCEPTED | 5가지 판단(일이 줄었나·데이터가 계속 들어오나·추출이 정확한가·돈을 내나·비용을 감당하나)을 5영업일 실사용으로 사용자가 판정 |

### 요구 추적

| 요구 | 구현 단위 | 인수 |
|---|---|---|
| U01 현장·상위 폴더·복수 폴더 연결 유지 | 기존 0.3 | R01 |
| U02 새 자료의 자동 업무 기록 | N03,N05 | R02 |
| U03 현장 아래 다섯 분류는 조회 체계로 유지 | N08 | R03 |
| U04 PC·폰·웹 이어쓰기 | 기존 0.3, N06 | R10 |
| U05 말·글의 같은 요청 처리 | N04 | R03 |
| U06 최초 안내·설정 다시 보기 | 기존 0.3 | R01 |
| U07 네이버 로그인·회사 연속성 | 기존 0.3 | R10 |
| U08 중요한 예외만 오늘에 질문 | N03,N08 | R04 |
| U09 한 답변이 관련 업무에 반영 | N03 | R04 |
| U10 판단 기억·수정·철회 | N11 | R11 |
| U11 새 견적 초안 | 기존 0.3 | R05 |
| U12 새 발주 초안 | 기존 0.3 | R06 |
| U13 일반 청구·거래명세 | 기존 0.3 | R06 |
| U14 한국식 출력·공유 | 기존 0.3 | R07 |
| U15 지속 사용·비용·유료 효용 | N09,N10,N12 | R12,R13 |

## B 사람 준비(게이트)

| 게이트 | 사람이 할 일 | 대기하는 지점 |
|---|---|---|
| H01 개발자 인증 | Git/Claude/호스팅 만료 시 재인증 | push·배포만 |
| H02 실제 계정 | 아버지 계정·회사 선택 | 실로그인만 |
| H03 Claude 자격·예산 | `ANTHROPIC_API_KEY`를 Render 비밀에 넣고 `AI_PROVIDER=claude`, `CAPTURE_POLICY_JSON.provider=anthropic` 전환, 월 한도 확인 | 운영 모델 호출만. 코드·E2E는 녹화 fixture로 계속 |
| H04 OCR·음성 | 녹음·사진 판독 공급자 계정과 목적별 처리 정책·회사/원천 동의 | 해당 판독만. 장기 음성의 별도 처리자는 의미 추출 권한을 얻지 않음 |
| H05 자료와 기기 | 실제 폴더·갤럭시 USB·self-hosted runner 등록(`sigongnote-device`) | 실기기 lane만 |
| H06 업무 기준 | 사건·할 일 교정 사례 소수의 정답 확인 | 자동 적용 범위 확대만 |
| H07 전달 | 팩스 공급자 계약 | 실발송만 |
| H08 SMS 적격성 | 개인 설치본 권한 증빙 | 실문자 수신만 |
| H09 운영·복구 | 기존 Render 2GB·DB·키 보관 | 운영 전환만 |
| H10 실사용 판정 | 5영업일 사용·유료 평가 | PRODUCT_ACCEPTED만 |

## C 실행 원칙

1. **2시간 단위.** 모든 N단위는 한 작성자가 2시간 안에 구현·시험·검수·push할 크기다. 넘치면 시작 전에 Nxxa/b로 쪼갠다.
2. **Codex 서브에이전트 병렬.** 각 단위는 파일 소유가 겹치지 않는 분할 지점을 표에 적는다. Codex는 그 지점대로 서브에이전트를 띄우고, 같은 migration·계약·화면 파일은 한 서브에이전트만 소유한다. 통합은 작성자가 E2E로 확인한다.
3. **Claude Agent SDK 필수.** 제품의 모든 판단(요청 이해·의미 추출·문자 선별·맥락 복원·PC 요약)은 `services/api/src/claude-runtime.ts`의 `runClaude`/`claudeMessagesTransport`를 거친다. 원시 HTTP 호출을 새로 열지 않는다. 기본 모델 `claude-sonnet-5`, 환경변수로만 교체. 내장 파일·셸 도구 0, in-process MCP 도구만, 구조화 출력만 제품에 들어온다.
4. **E2E 필수.** 격리 Postgres(`node scripts/e2e-db.mjs`) 위에서 `node scripts/run-e2e.mjs`가 통과해야 CODE_DONE이다. 핵심 E2E는 녹화 fixture 재생(결정적)과 `--live`(실모델) 두 모드가 같은 단언을 통과한다.
5. **실기기 CI.** `.github/workflows/device.yml`의 lane(USB 갤럭시 self-hosted·에뮬레이터·Windows)을 통과한 결과만 실기기 검증으로 적는다. 로컬 PC 스크립트 실행은 실기기 CI가 아니다.
6. 사진대지·팩스·장문 STT·개선 대시보드의 상세 계약은 이 명세 범위 밖이다. 기존 코드와 시험은 보존하되 새 요구를 붙이지 않는다.

## D 데이터·도구 계약

### D1 업무 사건

| 표 | 핵심 열 | 불변조건 |
|---|---|---|
| `app.work_events` | kind(request/change/problem/fact/agreement/correction/question/note), summary, project_id?, context_id?, party?, source_kind(revision/local), source_ref, evidence_refs, quantities, missing[], confidence, reasoning, status(open/resolved/superseded/dismissed), usage_id, actor_id | project_id는 회사의 기존 현장만. 없으면 null + missing에 `site`. 금액·입금·인수 확정 없음 |
| `app.work_followups` | event_id, title, due_on?, state(open/done/dismissed), version | 개인 체크리스트. 승인·전달·지급이 아님. 모든 할 일 완료 시 사건 resolved |
| `app.work_event_sources` | source_kind, source_ref, source_version, interpretation_run, run_token, state(leased/done/failed/skipped), attempts, usage_id | 현재 원천 판마다 1회 처리. 판·근거 변경은 이전 사건과 열린 할 일을 대체. 제출 불명은 자동 재호출 금지 |
| `app.work_event_corrections` / `app.local_context_consents` | 사건 교정 이전값·교체값·사유·버전 / 회사·사용자별 외부 AI 허용·동의 세대·정책 | 교정은 승인·송금이 아님. 로그인·발췌 공유만으로 외부 AI를 허용하지 않음 |
| `app.context_learning_cases` / `app.context_reading_procedures` / `app.context_reading_shadows` / `app.context_reading_evaluations` | 별도 학습 동의 세대·원천 판·채택 정답 / 읽기 절차 후보·훈련 원천 / 교정 전 새 자료 관측 / 독립 비교 결과 | owner 정답 채택·승격. 같은 원천·판의 평가 누수 금지. 철회·근거 변경 시 즉시 사용 중지. 승격은 읽기 힌트만 제공 |
| `app.product_ai_usage` channel `context` | source_kind revision/local/summary, prompt, model, price | 예약→제출→정산. 결과 불명은 0원이 아니다 |

함수: `app.next_context_input`(원천 선점), `app.save_work_events`(검증 후 저장), `app.mark_work_followup`(버전 CAS). 모두 security definer, API 역할만 실행.

처리 정책: `CapturePolicy`의 주 처리자는 의미 추출·맥락 복원에 적용한다. 선택 `processors`의 별도 처리자는 `purpose=long_stt`에만 적용한다. 원천 등록·회사 AI 허용은 사용자가 본 전체 `processing_policy`를 보내며, 같은 정책 ID라도 목적·처리자·처리/저장 위치·보존 조건이 달라지면 이전 동의를 재사용하지 않는다. 기존 원천·사용자 동의는 자동 확대하지 않는다. 정책이 바뀌거나 조회가 실패해도 철회는 가능하다. TS와 `app.capture_policy_processor`가 같은 목적 범위를 검사하고, 기기·원천 세대·철회·최신 정책·예산 경계를 함께 유지한다.

### D2 Claude 도구

맥락 복원 세션(`context-restore.ts`): `list_projects`, `recent_journal`, `open_events`, `search_evidence`, `get_evidence`, `get_work_state`, `learned_reading_hints` + 서브에이전트 `context-finder`. 실제 읽은 로컬·업로드 근거의 판을 저장 전에 다시 검사한다. 학습 힌트는 탐색 절차이며 현장·금액·상태의 사실 근거를 대신하지 않는다. 요청 이해 세션(`claude-planner.ts`): 읽기 도구 `search_evidence/get_evidence/resolve_entities/get_work_state/list_exceptions`로 먼저 읽고 `AgentPlan{calls,done,missing,answer}`을 돌려주며 효과 도구는 서버가 기록하며 실행한다. PC 요약(`document-summary.ts`): 도구 0, 인용은 보낸 발췌의 부분 문자열이어야 한다. 모든 도구 결과는 자료이지 지시가 아니다.

### D3 경계

파일≠거래, 요청≠승인, 출고≠인수, unknown≠0. 회사 격리는 RLS와 `set_config('request.jwt.claim.sub')`로 유지한다. 토큰 상한은 고정하지 않는다. 단순 기록은 짧게, 대상이 생략되거나 현장이 충돌하면 더 탐색한다(`maxTurns 12`, 호출당 `CLAUDE_AGENT_MAX_USD`, 사용자 KST 일 1만원·월 5만원은 SQL이 강제).

## E 기능 단위 커밋과 의존성

| 단위 | 의존 | 접점·구현 | 검증·서브에이전트 분할 |
|---|---|---|---|
| N01 격리 Postgres·CI 기반 | N00 | `scripts/e2e-db.mjs`(foundation shim+migration 전량), `run-e2e.mjs`, `db-gate` E2E 모드, `.github/workflows/e2e.yml` | 85+ migration 적용·DB 시험 23개 통과. 분할: shim SQL / 워크플로 |
| N02 Claude Agent SDK 런타임 | N01 | `claude-runtime.ts`: 설정·가격·`runClaude`·Messages 전송 에뮬레이션, `product-ai-config` 기본값 | `tests/claude-runtime.test.ts`. 분할: 런타임 / 설정·readiness |
| N03 맥락 복원 사건·할 일 | N01,N02 | migration `work_events_context`, `context-restore.ts`(선점→예약→세션→정산→저장), `journal.tasks`에 할 일·사건 포함 | 핵심 E2E 두 경로+멱등+회사 격리. 분할: migration / 워커·도구 / API |
| N04 요청 이해 플래너 | N02 | `claude-planner.ts`, `agent-provider` scope·answer, `agent-runs` 답변 표시 | `tests/agent-runs.test.ts`+런타임 단위시험. 분할: 플래너 / runs 표시 |
| N05 선별·의미 추출 SDK 경로 | N02 | `semantic-provider`, `sms-triage`, `product-ai` 전송 주입 | 기존 N03/SMS DB 시험 재통과 |
| N06 PC 요약 서버 중계 | N02 | `document-summary.ts` `/v1/ai/document-summary`, local-agent `ai.ts` 중계·세션 | `tests/local-agent.test.ts` AI 4종 |
| N07 실기기 CI | N01 | `device.yml` 3 lane, `scripts/device-android.ps1`, Android `WorkApi` setup 경로 수정 | 사용자 runner 등록 후 lane 실행. 분할: Android / Windows |
| N08 오늘 화면 사건·할 일 | N03 | `work-tasks.tsx` 할 일 종류·사건 요약·"현장 미특정", 원문 열기 | `/ui-pass` 320/390px·`tests/work-*.test.tsx`. 분할: 화면 / 시험 |
| N09 운영 전환 | N02,N03,H03 | Render 비밀·`AI_PROVIDER=claude`·정책 provider `anthropic`·배포·`/health/ready` | 운영에서 E2E와 같은 문자 1건 실처리 영수증 |
| N10 운영자 관측 | N03 | 사건별 근거·도구 호출·비용·교정 여부를 운영자 화면(`/activity`)과 JSONL 내보내기로 | 회사·역할 접근 제어 시험. 분할: 조회 API / 화면 |
| N11 교정 학습 | N10,H06 | 사용자 교정→사례 저장→재사용 가능한 판단 절차 후보(규칙/경량 모델)→그림자 비교 | 누수 0·승격은 owner만 |
| N12 실사용 판정 | N09,N10,H10 | 5영업일 관여시간·지원시간·비용·결제 기록 | 사용자 판정. 에이전트가 대신 완료 불가 |
| N13 현장 원장 공개 시연 | N08 | 현장 원장·거래·변경 통합 조회, 근거 연결, 구조화 신규 자료 반영, 고정 CSV·HTML·PDF 공유 | 분할: domain read model / 공통 UI / 로컬 runtime. `npm run demo:test` 격리 파일·HTTP E2E와 320/390px, 실제 자료 추가 반영. 운영 DB 변경 없음 |

### 실행 묶음

공개 시연판 N13 계약: `FieldLedgerBundle` 1판의 현장·기록·원문 ID를 입력으로 받는다. 귀속 assigned/review와 확인 recorded/pending/confirmed는 독립 값이다. 원문 접수는 거래 확정이 아니며 수량·금액·업무일 미기재는 null이다. 같은 ID는 높은 revision만 갱신하고 같은 판의 충돌은 거부한다. 조회 필터가 화면·CSV·보고서에 공통 적용되며 content SHA-256을 기준으로 이전 결과물을 보존한다. 자료는 Git 밖 로컬 저장소에서만 읽는다. 일반 파일은 원문 접수, 명시된 JSON/CSV는 구조화 항목 반영이다. N13은 별도 로컬 HTTP/runtime이므로 DB·RLS·운영 worker 계약을 변경하지 않으며, 격리 파일 저장소 기반 `tests/demo-runtime.test.ts`가 이 단위의 E2E다. 원본 제품의 DB E2E 요구는 원본 제품 변경에 계속 적용한다.

1. 기반과 지능: N01→N02→N05 (완료).
2. 핵심 흐름: N03→N04→N06→N08 (완료, N08 화면 점검 남음).
3. 검증 자동화: N07 (코드 완료, 실기기 lane은 H05 runner 등록 뒤).
4. 운영과 판정: N09→N10→N11→N12 (H03·H06·H10 대기, 독립 작업은 N10 조회 API부터).

Codex 서브에이전트 병렬 지침: 한 묶음 안에서 표의 분할 지점마다 서브에이전트 1개, 최대 4개. 각 서브에이전트는 자기 파일만 수정하고 `npm run typecheck`와 자기 국소시험을 통과한 diff를 돌려준다. 작성자는 합친 뒤 `node scripts/run-e2e.mjs`로만 완료를 판정한다.

## F 커밋 절차와 검증 명령

1. 현재 N단위·base SHA·허용 파일을 고정하고 구현한다.
2. 국소시험 1묶음: `npm run typecheck`, 변경 경로 `npx biome lint`, 해당 시험 파일, 그리고 `node scripts/e2e-db.mjs && node scripts/run-e2e.mjs`.
3. 독립 검수 Claude Code Fable 5.1 high 1세션(P0/P1만, 재현 입력 필수). 수정 후 영향 부분만 재검증.
4. 자기 파일만 `git add` → `node scripts/check-staged.mjs` PASS → commit → push. EXECUTION_STATE 50줄 갱신은 같은 커밋.

| 영향 | 명령 |
|---|---|
| 문서만 | `node scripts/check-spec.mjs`, `git diff --check` |
| 런타임·판단 | `npm run test:claude`, `node scripts/run-e2e.mjs` (`--live`는 자격 있을 때) |
| DB/RLS | `node scripts/e2e-db.mjs` 전량 적용, 영향 API 시험, 격리 DB 재생 |
| 돈 | `node --import tsx --test --test-concurrency=1 tests/invoice.test.ts tests/cash.test.ts tests/charge-api.test.ts tests/quote-api.test.ts tests/quote-scope.test.ts` |
| 화면 | 변경 `tests/work-*.test.tsx` + `node scripts/ui-shots.mjs --script scripts/ui-flows.json` |
| 실기기 | GitHub Actions `device.yml` lane 결과 |

## G 실연결과 사용자 인수

| 인수 | 실제 성공 기준 |
|---|---|
| R01 시작 | 로그인→기존 회사→폴더 연결 후 첫 자료가 일지에 보인다 |
| R02 자동 업무기록 | 새 문자·자료가 사건으로 남고 같은 원천이 두 번 처리되지 않는다 |
| R03 대화 실행 | 요청이 실제 근거를 읽은 답변과 기록된 도구 단계로 돌아온다 |
| R04 판단과 기억 | 생략된 현장이 기존 기록에서 복원되고, 없으면 미특정으로 남는다 |
| R05 변경 견적 | 기존 0.3 초안 경로 유지 |
| R06 발주·청구 | 기존 0.3 계산 경로 유지, 과청구 0 |
| R07 사진·전달 | 기존 0.3 유지, 추가 요구 없음 |
| R08 음성 | 짧은 말과 글이 같은 플래너를 탄다 |
| R09 문자 | 선별 결과가 있어야 회사 자료로 수집된다 |
| R10 동기화 | PC 일지·요약이 같은 계정의 폰·웹에서 보인다 |
| R11 개선과 비용 | 사건마다 모델·비용·도구 호출·교정 여부가 남는다 |
| R12 복원과 운영 | 격리 DB에서 migration 전량 재적용·E2E 재통과 |
| R13 실제 효용 | 5영업일 관여·교정·지원시간과 결제 여부로 사용자가 판정 |

표본 0건은 0오류가 아니다. 미실행을 PASS로 쓰지 않는다.
