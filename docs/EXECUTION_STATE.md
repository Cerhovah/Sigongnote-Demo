# 실행 상태 · 공개 시연판 / 제품0.3 기반 / 명세0.5+N13 · 2026-11-04
단계: IMPLEMENTATION
현재 작업: N13 현장 원장·거래·변경 통합, 구조화 신규 기록, 근거 조회, 고정 CSV·HTML·PDF와 파일 공유. 공개 시연 저장소에서 구현·국소 연결·독립 검수 완료, 게시 진행.
현재 기준: upstream main 883c6a7e8c6a8f739fdc2f30a88ac27786831e9f → 공개 초기 snapshot 1da24ab. 고객 원문·과거 이력·운영 workflow/render/mcp 설정 제외, 원본 1008blob 동일 확인.
구현 이력: N01,N02,N03,N04,N05,N06,N07,N08,N10,N11,N13
구현 이력 수: 11/13
보완 단위: 없음
사용자 승인: 최신 main 기반 별도 공개 저장소 생성과 현장 원장·CSV·현황 공유 구현. 원본 비공개 저장소·운영 서버·DB·기기·서명 변경 없음.
저장소: Cerhovah/Sigongnote-Demo 공개. 비공개 원본의 visibility를 바꾸지 않은 독립 소스 snapshot. 브랜치 codex/field-ledger-demo.
실행: npm run demo:build → npm run demo:start -- --data-dir <Git 밖 비공개 폴더> --port 8770. 127.0.0.1만 수신. 고객 자료는 Git 밖에 유지.
원장: 귀속 assigned/review와 확인 recorded/pending/confirmed 독립. 업무 발생일/접수일 구분, 동일 ID 판 충돌 거부, 같은 원문의 거래 중복 집계 방지.
입력: JSON·한국어 원장 CSV의 명시 항목 반영. 일반 파일은 실제 접수·원문 연결. incoming 현장 폴더 자동 접수, 신규 접수 시각 기록, 재시작 유지. 외부 AI 호출 없음.
공유: 화면 필터와 같은 content SHA 스냅샷으로 CSV·HTML·PDF. 이전 보고서 재열기, PDF 로컬 렌더·캐시, 기기 파일 공유와 다운로드 fallback.
자료 연결: 기본 원장35건과 귀속 검토93건 분리, 자료181개 등록. 봉천동16건·대전 병원19건. 원본88개와 해당 기록 근거 발췌93개, 원본 전체 아카이브 공개 없음.
직접 실자료 실행: 봉천동 실제1건 단계적 추가15→16, 업무일 유지·접수시각 기록·중복방지·CSV/PDF/HTML 반영·이전CSV 유지·디스크 재열기 PASS. 대전 변경 원장19건. 원본88개 전후hash 동일.
시험: domain6·UI9·local HTTP/runtime7=22통과(독립 검수21 + 개선 후 UI9 재검증). 전체typecheck·demo build·Biome 오류0·문서검사 PASS.
화면: 내부 합성자료로 320/390/1280px 다섯 보기·원문 서랍·CSV 추가·파일저장 동선 확인. 거래표 모바일 전체폭 초과 수정 후320/390 재캡처 overflow0·페이지오류0.
공개 초기 검수: Fable5.1 high 세션6ac20bca-71f5-4f39-9a89-73b000664cdf. OAuth 재로그인 후 동일세션 재개, P0/P1없음·staged gate 직접PASS. Pro/firstParty·목록환산USD3.49498925·실청구미조회. 원문/도구기록 비공개.work.
기능 검수: Fable5.1 high 세션5e484bf4-47be-49af-98a6-8a8a42046084, P0/P1없음. 검수자 직접21시험·typecheck·문서·diff PASS. Max/claude.ai/firstParty·목록환산USD3.120628·실청구미조회. Bash2/Read21/Grep1/PowerShell5/Glob1, Bash1거부 후 PowerShell 대체. 결과·도구로그는 .work/claude-runs에 보관.
검수 개선 반영: 전체 현장에서 현장 미지정 파일 추가 시 귀속 검토 원장에 바로 표시. 초기 구조화 묶음의 현장 자동 선택은 유지. 영향 UI9시험 PASS, 재검수 없음.
운영 경계: 공개 웹호스팅·원본 서비스 배포·실기기 설치·상대방 수신·전체 제품 실사용 인수는 이번 로컬 시연 실행에 포함하지 않음.
정본: AGENTS 작업규칙 / AGENT_SPEC 계약 / ENVIRONMENT 기존 환경절차. N13 실행·공개범위는 README와 이 파일. 상세 영수증은 .work, 고객 자료는 저장소 밖.
