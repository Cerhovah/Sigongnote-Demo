---
paths:
  - "services/api/src/**"
  - "packages/domain/**"
  - "packages/contracts/**"
  - "services/local-agent/src/**"
---
# 돈·상태·계약 규칙 (이 경로를 건드릴 때만 자동 로드)

- 파일≠거래, 요청≠승인, 출고≠인수, 지급 기록≠송금, unknown≠0. AI(semantic/agent provider)는 후보(candidate)만 만든다. 금액·상태·효과 확정은 TS domain → API → DB 순서로만. 화면·프롬프트·클라이언트 값이 확정하지 않는다.
- 모든 쓰기 경로에 tenant 경계(`tenant_id`), 동의/철회 세대, 근거(evidence) 참조, 버전(`VERSION_CONFLICT`), 멱등키(`client_command_id`/`command_id`/`client_turn_id`, `IDEMPOTENCY_CONFLICT`), 보정 이력을 유지한다. 재시도는 같은 명령을 같은 키로 보낸다. 재처리 중복 0, 동시 실행·재개를 견딘다.
- 오류 코드 `VERSION_CONFLICT`/`DOMAIN_INVARIANT`/`INVALID_CONTRACT`/`IDEMPOTENCY_CONFLICT`/`NOT_FOUND`의 의미와 처리 문구를 바꾸지 않는다.
- 모르는 금액은 null/unknown으로 두고 0으로 표시·합산하지 않는다. 금액은 정수(원)·고정 반올림. 결과불명(발송·전송·과금)은 0이나 성공으로 쓰지 않고 상태로 남기며 자동 재시도하지 않는다.
- 정상 수집·분류·기준 내 원장·초안은 자동 처리하고, 중요한 충돌만 업무 단위로 묻는다. candidate만으로 사용자에게 질문하지 않는다.
- `packages/contracts` 변경 → 같은 커밋에서 `npm run contracts:generate` → `npm run contracts:check` → `npm run test:contract` → `npm run contracts:native`. 생성물(`**/generated/**`)과 Kotlin/C# 산출물은 손으로 고치지 않는다.
- 돈 영향(invoice/cash/charge/quote/ledger) 변경 → 5종 money 시험 필수: `node --import tsx --test --test-concurrency=1 tests/invoice.test.ts tests/cash.test.ts tests/charge-api.test.ts tests/quote-api.test.ts tests/quote-scope.test.ts`. 청구 발행은 한 번의 확인으로만.
- 제품 AI는 H03 공급자·가격 버전·예산 설정(`SEMANTIC_*`, `CAPTURE_POLICY_JSON`)을 쓴다. 개인 Claude 구독·개발 키를 제품 코드 경로에 넣지 않는다. 비밀값은 `process.env`로만 읽고 로그·오류·응답에 넣지 않는다(`LOG_REDACTION_ENABLED` 유지).
