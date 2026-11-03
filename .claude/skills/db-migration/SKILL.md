---
name: db-migration
description: Supabase migration을 만들거나 바꾸는 안전 절차. "테이블 추가", "컬럼 바꿔", "RLS", "migration", "스키마 변경"에 사용. 로컬 격리 DB에서만 검증하고 운영 DB에는 적용하지 않는다(운영 적용은 사용자 승인 뒤 ENVIRONMENT 배포 절차). 작성자 측 점검표가 들어 있으며 flow-reviewer 검수를 대체하지 않는다.
argument-hint: "<변경 목적 snake_case>"
---

# DB migration 절차 (`$ARGUMENTS`)

전제: 대상은 Docker의 로컬 Supabase(`supabase/config.toml`의 project_id `sigongnote-dev`)만이다. `db reset --linked`·`--db-url`·운영 reset/down은 훅이 막고, `db push`·`migration up`·`db reset`(로컬)은 사용자 질문이 뜬다. 기존 `supabase/migrations/*.sql`은 고치지 않고 새 파일을 추가한다(커밋된 migration 편집은 훅이 되묻는다).

## 1. 설계(쓰기 전에)
- 비슷한 기존 테이블의 최신 migration을 Grep(`enable row level security`, `create policy`)으로 찾아 `app.` 스키마·`tenant_id`·policy·grant 패턴을 그대로 따른다. 기준 예: `supabase/migrations/20260928041730_tenant_boundary.sql`(schema `app`, 역할 `sigongnote_api`, tenant 경계·RLS·grant 방식). 새 패턴을 발명하지 않는다.
- 변경을 expand(열·테이블 추가, nullable) → backfill(checkpoint·재시작 가능) → verify(count/hash 대조) → cutover(reader 전환) 단계로 나눈다. 파괴적 down 대신 기능 비활성화·이전 reader 유지·보정 migration을 계획한다.
- 금액은 정수 원, 모르는 값은 null. 버전·멱등키·보정 이력·tenant·동의 세대 열을 유지한다.

## 2. 파일 만들기
```
npx supabase migration new $ARGUMENTS
```
생성된 `supabase/migrations/<14자리시각>_$ARGUMENTS.sql`만 편집한다. 파일 이름을 손으로 만들지 않는다(훅이 형식 미달을 알린다).

## 3. 작성 점검표 (모두 "예"여야 한다 — 작성자 측 점검이며 검수가 아니다)
- [ ] 회사 데이터 테이블은 `tenant_id uuid not null references app.tenants(id)` + `alter table … enable row level security` + select/insert/update/delete 정책이 tenant 경계를 검사한다. 정책 없는 RLS는 전부 차단이므로 의도인지 확인.
- [ ] `version bigint not null default 1 check (version >= 1)`, `created_at/updated_at` 등 기존 표준 컬럼 유지. 멱등키·보정 이력이 필요한 효과 테이블은 unique 제약으로 중복 적용을 막는다.
- [ ] 금액·수량은 모르는 값을 0으로 기본 설정하지 않는다(unknown≠0 → nullable, 확정 여부 컬럼 분리). trigger로 금액·상태를 자동 확정하지 않는다.
- [ ] `if not exists`, `drop policy if exists … create policy`, `do $$ … $$` 가드 — 재실행해도 같은 결과(멱등). 한 migration에 drop/rename을 섞지 않는다.
- [ ] 파괴적 down 없음. 역할 grant는 api/worker/migration 분리(`scripts/provision-cloud-api.sql`, `scripts/provision-cloud-worker.sql`), service-role 우회 경로 없음.
- [ ] 신설 영속 테이블·버킷·큐·모델/프롬프트 버전은 같은 커밋에서 복원 manifest(`scripts/recovery-assets.ts`·`scripts/recovery-*.ts`)와 복원 시험(`tests/recovery*.test.ts`)에 등록해야 CODE_DONE이다(AGENT_SPEC F).
- [ ] 원문·개인정보를 seed/fixture에 넣지 않는다. 합성 자료만.
- [ ] 응답 schema가 바뀌면 `packages/contracts` 생성물·네이티브 계약을 같은 커밋에서 갱신한다.

## 4. 격리 검증 (명령은 로컬 DB 대상; 환경 URL·키는 출력하지 않고 "로컬/격리"라는 종류만 기록)
| 검사 | 명령 |
|---|---|
| 스택 확인 | `npx supabase status` (꺼져 있으면 `npx supabase start`; Docker Desktop 필요, 승인 질문) |
| fresh(처음부터 전부 적용) | `npx supabase db reset` (로컬 전용, 승인 질문) → 전체 migration 재생 성공 |
| upgrade(기존 DB에 새 것만) | `npx supabase migration up` (승인 질문) |
| replay(두 번 적용·중단 복구) | `npx supabase migration up` 재실행 → 오류 없이 no-op 이어야 한다 |
| 드리프트 | `npx supabase db diff` → schema 차이 0 |
| 권한·RLS 불변조건 | `npm run check:db`, `npm run test:tenant` (`supabase/tests/tenant_boundary.sql`) |
| 영향 API/도메인 | `node --import tsx --test --test-concurrency=1 <해당 시험> tests/*migration*.test.ts`; 돈 영향이면 money 5개 시험(/ncard 표) |
| 계약 산출물 | 스키마가 wire 계약을 바꾸면 `npm run contracts:generate && npm run contracts:check` |

Docker가 없거나 스택이 꺼져 있으면 "미실행(BLOCKED)"으로 적고 PASS라고 쓰지 않는다.

## 5. 그 다음
- `/ncard` 3단계(flow-reviewer 1세션) → stage → commit → push. 검수 패킷에 migration 파일과 격리 검증 결과(위 표의 명령·종료 코드)를 넣는다.
- 운영 적용은 이 스킬 범위 밖이다: `docs/ENVIRONMENT.md` "배포·설치·복원" 2항(운영 암호화 백업·해시 → 네트워크 없는 별도 DB 전량 복원·migration·RLS/구버전 호환 검증 → 이력 유지 도구로 expand/backfill/검증/cutover). 사용자 승인(H09) 필수, 사람이 실행한다. 새 자원·결제는 H게이트.
