---
name: ui-pass
description: 시공노트 공통 업무 화면의 설계, 구현, 320/390px 동선 검증. 화면 개선이나 첫 사용 흐름 작업에 적용한다. 운영 배포와 실기기 인수를 대신하지 않는다.
---

# 시공노트 UI 작업

60대 현장 대표가 현재 업무를 보고 다음 행동으로 이어가도록 만든다. 큰 빈 카드, 중복 설명, 내부 용어를 줄인다. 본문 18px, 누르는 높이 48px, 대비 4.5:1을 목표로 하고 수치 미달을 기록한다.

AGENTS.md → docs/EXECUTION_STATE.md → 실제 Git → 현재 계약 순서로 읽는다. 사용자 변경과 원본, 동의, 큐, 서명을 보존한다. 기준 SHA가 달라졌으면 실제 diff로 작업 범위를 다시 판단한다. 이미 승인된 독립 작업은 계속한다.

## 진행

- [요청 양식](request-template.md)으로 목표, 소유 파일, 기준 SHA, 검증 범위를 고정한다. 돈/DB/RLS/공통 계약에 영향이 생기면 관련 필수 회귀를 포함한다.
- Mobbin은 실제 사용 가능한 search_screens/search_flows 스키마로 필요한 화면만 조회한다. 본 이미지만 근거로 삼고 mobbin_url을 기록한다. Figma는 해당 호스트의 인증과 필요한 스킬을 확인한다. 연결 상태와 실제 도구 사용을 구분한다.
- 사용자 창·커서·탭을 강제로 이동하지 않는다. 배경 캡처: node scripts/ui-shots.mjs --script scripts/ui-flows.json --out .work/ui-pass/<고유이름>. DEV 합성 브라우저만 사용하고 실자료·운영 API에는 연결하지 않는다.
- 캡처 전후 실제 기대 제목과 주요 행동을 확인한다. 첫 현장→파일 추가 진입, 오늘→현장→문서, 문서→읽은 근거→초안, 설정→고급을 확인한다. 합성 파일 추가 화면 진입은 실제 업로드 성공이 아니다.
- 변경 관련 국소시험·typecheck·캡처를 한 묶음 실행한다. 실패를 고치면 영향 경로만 재실행한다. 캡처의 FAILED/nonzero를 통과로 기록하지 않는다. CAPTURED_WITH_FINDINGS는 글자/누름 영역 보완이 남은 상태다.
- 작성자가 Codex라면 scripts/claude-headless.mjs --mode review --request <검수입력>으로 독립 Fable 5.1 high 1세션을 사용한다. 작성자가 Claude라면 별도 독립 flow-reviewer 1세션만 사용한다. 작성 세션의 자기점검은 독립 검수가 아니다. 추가 검수·중복 세션은 금지한다.
- 기본 effort는 high. 사용자가 현재 작업에 xhigh를 지정했을 때만 --effort xhigh를 사용한다. 이전 UI 세션의 xhigh 선택을 새 작업에 자동 승계하지 않는다.
- [결과 양식](result-template.md)에 직접 실행/작성자 기록/미실행, 모델·사용량·과금 경로·응답 위치·도구 실행·거부를 구분한다. 검수 P0/P1 수정 후 영향 검증 → 명시 파일 stage → node scripts/check-staged.mjs PASS → commit·즉시push. 검수자는 수정·commit·push하지 않는다.

## 도구 경계

runner의 allowedTools/dontAsk는 OS 격리가 아니다. 기존 Claude 설정과 셸의 권한을 대체하지 않는다. 자동심사 거부를 권한 파일 복사나 우회 플래그로 회피하지 않는다. 상세 준비·OAuth·실행 방법은 docs/ENVIRONMENT.md가 정본이다.
