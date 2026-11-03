---
paths:
  - "supabase/**"
  - "scripts/recovery-*.ts"
  - "scripts/provision-cloud-*.sql"
  - "scripts/db-gate.mjs"
  - "scripts/test-tenant.mjs"
  - "tests/*migration*.test.ts"
  - "tests/recovery*.test.ts"
---
# DB·migration 규칙 (이 경로를 건드릴 때만 자동 로드)

- 운영 DB reset/down/`--linked`/`--db-url` 금지. 검증은 로컬 Docker Supabase(`supabase/config.toml`의 `sigongnote-dev`)나 네트워크 없는 격리 DB에서만. 환경 URL·키는 출력하지 않고 종류(로컬/격리)만 기록한다.
- 이미 커밋·적용된 migration 파일은 고치지 않는다. 보정은 새 migration. 파일 이름은 `npx supabase migration new <snake_case>`로 만든다(손으로 짓지 않는다).
- 순서: expand(추가·nullable·새 객체) → backfill(배치·checkpoint·재시작 가능) → verify(count/hash 대조) → cutover. 한 migration에 `drop/truncate/컬럼 삭제`를 섞지 않는다. 복귀는 기능 비활성화·이전 reader 유지·보정 migration.
- 새 회사 데이터 테이블: `app.` 스키마, `tenant_id uuid not null references app.tenants(id)`, `alter table … enable row level security`, select/insert/update/delete 정책이 tenant 경계를 검사. 기존 테이블의 정책 패턴을 Grep(`create policy`, `enable row level security`)해 같은 helper/claim을 쓴다. 역할 grant는 api/worker/migration 분리(`scripts/provision-cloud-api.sql`, `provision-cloud-worker.sql`). service-role로 RLS를 우회하는 새 경로를 만들지 않는다.
- 멱등: `if not exists`, `create or replace`, `drop policy if exists … create policy`, `do $$ … $$` 가드. 두 번 적용해도 오류가 없어야 한다.
- 돈·상태 열: 금액은 정수 원, 모르는 값은 null(0 아님). `version bigint not null default 1 check (version >= 1)`, 멱등키·보정 이력 열 유지. trigger로 금액·상태를 자동 확정하지 않는다(서버 코드가 확정).
- 신설 영속 테이블·버킷·큐·모델/프롬프트/평가 버전은 같은 커밋에서 복원 manifest(`scripts/recovery-assets.ts`·`scripts/recovery-*.ts`)와 복원 시험(`tests/recovery*.test.ts`)에 등록해야 CODE_DONE이다(AGENT_SPEC F).
- 시험: `npm run check:db`, `npm run test:tenant`(`supabase/tests/tenant_boundary.sql`), 격리 fresh/upgrade/replay, 영향 API 시험. Docker가 꺼져 있으면 "미실행(BLOCKED)"으로 적고 PASS라고 쓰지 않는다. 절차는 `/db-migration`.
