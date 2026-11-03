---
name: handoff-check
description: 기능 묶음 끝·배포 전·인계 전 읽기 전용 점검표. "인계 점검", "배포 전 체크", "문서 정합 확인", "handoff", "release check"에 사용. 문서 정합(check-spec)·상태 50줄·README 실제 링크·검수 영수증·CI 이미지·운영 health·설치물 해시·CODE_DONE/LIVE/PRODUCT 구분·미실행 표시를 확인하고 부족한 항목을 표로 돌려준다. 배포·게시 명령은 실행하지 않는다.
argument-hint: "[새 40자리 SHA] [이전 40자리 SHA]"
---

# 인계·배포 전 점검 — 새 SHA `$0`, 이전 SHA `$1` (없으면 조회만)

이 스킬은 확인만 한다. `release-control.mjs prepare`, `publish-release.mjs --publish`, `render-release.mjs deploy`, `package-cloud-clients.ps1`, `supabase db push`는 실행하지 않는다(사용자 승인 H09 뒤 `docs/ENVIRONMENT.md` 배포 절차로 사람이 실행). 키·토큰·환경 URL을 출력하지 않는다.

## 자동 수집
- 상태:
!`git status --short`
- 최근 커밋:
!`git log --oneline -5`
- 문서 게이트: !`node scripts/check-spec.mjs || true`
- 공백·충돌 표식: !`git diff --check || true`

## 점검표 (각 항목을 PASS / FAIL / 미실행(이유) 로 적는다)
| # | 항목 | 확인 방법 |
|---|---|---|
| 1 | 승인 | `docs/EXECUTION_STATE.md`의 `사용자 승인` 행에 이번 배포 범위가 있는가. 없으면 H게이트 대기로 표시하고 멈춘다(같은 배포 재승인은 요청하지 않는다). |
| 2 | 소스 | `git status --short`가 비어 있고(sourceDirty=false) `$0`이 원격에 있는가(`git fetch origin` 후 `git branch -r --contains $0`). 사용자 미커밋 자료(`.codex/`, 개인 MD, Windows 시험)가 섞이지 않았는가(`git show --stat $0`). |
| 3 | 문서 | `node scripts/check-spec.mjs` PASS, `git diff --check`, `docs/EXECUTION_STATE.md` 50줄 이하이고 `운영`·`공개 설치`·`사용자 승인`·`다음 실행` 행이 실제 Git·배포와 맞는가. `README.md`의 운영/설치/대시보드/피드백 링크 유지. `HANDOFF.md`가 연결점·금지 사항·다음 우선순위만 가리키는가(상태 복제 금지). |
| 4 | 검수 | 이 SHA에 포함된 커밋마다 flow-reviewer 1세션 영수증(`.work/<단위>/` 또는 `.work/claude-runs/reviews/<base>.json`)이 있는가 — 존재만 확인하고 원문은 재출력하지 않는다. 미검수 코드는 배포하지 않는다. |
| 5 | CI 이미지 | `gh run list --workflow release-image.yml --commit $0 --limit 3` → success 1건. digest가 `.work/render-releases`의 image.json 후보와 같은 SHA인가. |
| 6 | DB | 이 범위에 migration이 있으면 격리 fresh/upgrade/replay 결과와 `npm run check:db`·`npm run test:tenant` 결과, 운영 암호화 백업·해시 확인 기록이 `.work`에 있는가. 없으면 "미실행"으로 적고 배포 안내를 멈춘다. |
| 7 | 운영 | `node scripts/render-release.mjs inspect`(읽기 전용; 자격이 프로세스에 없으면 미실행으로 기록) → 플랜 2GB·Singapore·자동 Git 배포 꺼짐·현재 digest. WebFetch로 `https://sigongnote-api.onrender.com/health/ready` 상태만 확인하고 본문을 재출력하지 않는다. Render 플러그인이 연결돼 있으면 목록·배포·로그 **읽기** 도구로 같은 사실을 교차 확인한다(생성/수정/trigger 도구는 쓰지 않는다). |
| 8 | 설치물 | Android versionCode 증가·같은 서명, Windows manifest 해시, 공개 저장소 `Cerhovah/Sigongnote-downloads` 6자산 해시·download 302 대조 계획. 재서명·키 재생성 없음. |
| 9 | 인계·구분 | CODE_DONE / LIVE_ACCEPTED / PRODUCT_ACCEPTED를 섞지 않았는가. 문서만 바뀐 커밋을 제품 배포/실기기 재검증으로 적지 않았는가. 실기기·실연결·실제 발송 미실행을 PASS로 바꾸지 않았는가. 기능 묶음이 끝났으면 확인창구 content.json·실행 방법·검증 범위 갱신 여부. |

## 출력
- 점검표 9행의 결과 + 실행한 명령과 종료 코드 + 미실행 목록 + 부족한 항목의 최소 수정(파일·줄) + 다음 커밋에 포함할 EXECUTION_STATE 변경 줄.
- 사용자가 승인해야 하는 명령(새 배포 실행·Manual Deploy·새 자원)은 그대로 적되 실행하지 않는다. 배포 후 검증은 사용자 지시 뒤 `node scripts/release-control.mjs verify https://sigongnote-api.onrender.com/ <SHA> <archive_sha256>`로 수행한다. 이미지 게시만으로 배포를 주장하지 않고, 제출 불명은 재제출 대신 상태 조회. 인계 패키지 `scripts/package-handoff.ps1`은 PowerShell 7이 필요하므로 없으면 미실행으로 표시한다.
