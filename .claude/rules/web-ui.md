---
paths:
  - "apps/web/src/**"
  - "packages/ui/**"
  - "tests/work-*.test.tsx"
  - "tests/*-ui.test.tsx"
---
# 화면 규칙 (웹 화면 파일을 건드릴 때만 자동 로드)

- 60대 현장 대표가 한 화면에서 한 가지 일만 한다: 경로마다 h1 하나, `button-primary` 최대 하나, 허브 화면에 다른 흐름의 입력 폼을 쌓지 않는다. 뒤로 가기(화면·기기)는 한 단계씩.
- 본문 18px, 누르는 높이 48px, 대비 4.5:1. 미달은 결과에 기록한다. 설명 문단·반복 안내·빈 큰 카드를 늘리지 않는다(사용자는 설명을 읽는 화면을 원치 않는다).
- 송금·발송·입금·업무 완료를 확정한 것처럼 쓰지 않는다. 모르는 금액은 0원이 아니라 "확인 중"류로. 청구 발행은 한 번의 명시적 확인으로만.
- 내부 용어(tenant, 귀속, 객체, 행/셀, revision, hash, candidate)를 화면·접근성 이름에 노출하지 않는다.
- 요청은 같은 route·payload·멱등키(`client_command_id`, `command_id`, `client_turn_id`, `pending` ref)를 유지하고, 실패 후 재시도도 같은 명령을 보낸다. `VERSION_CONFLICT / DOMAIN_INVARIANT / INVALID_CONTRACT / IDEMPOTENCY_CONFLICT / NOT_FOUND` 처리 문구와 상태 초기화를 보존한다. 계정 변경(`login_required`, `account_changed`) 시 자료를 지운다.
- 합성 체험 메뉴를 제품 빌드에 넣지 않는다(`?work=preview`는 내부 회귀 전용). 삼성 문자앱 대체·알림 우회 금지.
- 검증: 변경한 `tests/work-*.test.tsx`를 명시 실행 + `npm run typecheck` + `node scripts/ui-shots.mjs --script scripts/ui-flows.json --out .work/ui-pass/<이름>`(320/390px·axe·가로 넘침). 절차는 `/ui-pass`. 디자인 참고는 Mobbin/Figma 커넥터로 필요한 화면만 조회하고 URL을 결과에 적는다. 사용자 창·커서·탭을 강제로 움직이지 않는다.
