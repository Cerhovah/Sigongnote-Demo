# 실행 상태 · 제품0.3 / 명세0.5 · 2026-10-24
단계: IMPLEMENTATION
현재 작업: 갤럭시 문자/마이크 정상OS권한·모든 새 문자 AI범위·개인설치 H08 연결. 실제 SMS1건→업무판별→업로드/해석→업무일지 본문/재열기·사건1/할일1 확인. 새 문자 조회 지연 보완·안전 진단 추가. 아래 A-J는 이전 이력이며 전체 제품 인수와 구별한다.
현재 기준: 자동 수집→현재 근거 판→사건/할 일→현장 교정→견적→발행/재열기. 합성 회귀·SDK·운영·실기기·사용자 인수를 구별한다.
구현 이력: N01,N02,N03,N04,N05,N06,N07,N08,N10,N11
구현 이력 수: 10/12
보완 단위: N03,N06,N07,N08
사용자 승인: 지정 회사 DB 전량 삭제·전체 리팩터링/강한 검증·Cerhovah 기존 서비스 반영·기존 서명 설치물·commit/push. 새 결제·증설 제외.
작업트리: main bad303a 기반 codex/install-links-20261024 문자 연결 보완. 원래 작업트리의 사용자 변경·원본·계정·서명·미전송 큐 보존.
운영: 서버source8a571c62/source_dirty=false·DB/worker ready, 공개rc.13/code23 유지. USB 개인문자앱rc.14/code24 기존서명 업데이트. 해당SMS source1의 H08 정상 적용, 서버배포·스키마변경 없음.
DB 삭제: 승인된2회사와381종속행 삭제·타 회사 해시 불변·전체 app JSON 포함 잔여 참조0. Auth 계정·원본 Storage 보존. 암호화 복구 백업은 비공개.work.
최신 운영 백업:183테이블/565행 암호화·격리 전량 복원·FK누락0·수치 원문 보존. 새90 upgrade/replay·원래565행 불변·구판 API4조회 전후200. Auth/Storage 서비스 자체 복원 실행 아님.
접점: PC 서버 중계·계정/응답 격리·동의한 native 업무/사진/녹음 폴더 기존 업로더·실제capture ID/기기/SHA metadata·RLS 정식 읽기 연결.
맥락: 새 판 재해석·취소/대체·선행 근거·다현장 보류·호출 불명 봉인·회사/사용자 AI 동의·사건/현장 교정·버전 CAS.
문서: PC 근거·신규 견적·수량/매입단가·서버 정수 계산·발행/취소·판 고정·재열기. 실제 Python PDF/XLSX→DB artifact→API 재열기2/2 PASS.
학습: 별도 회사 개선 동의→owner정답→읽기 절차 후보→교정 전 독립 자료 shadow→평가/승격/철회. 동일SHA/문서판 누수 차단·작업 완료시 학습 사례 보존.
기존 직접 검증: typecheck/build·공통C#/Kotlin계약·Python33+39하위 PASS. 320/390px 사건/근거/교정·문서 동선 실패/넘침/axe0. 보조 글자 권고는 별도.
기존 실모델: 로컬 구독 Claude Sonnet5 smoke/맥락 E2E PASS. 운영 키·고객 원문·폰 수집 성공과 구별.
CI 수정: 현장 metadata RLS·blob 재사용·SMS 적격 활성화·최신 migration rollback·Python OS경로·Windows 구스키마와 현재 화면 시험 연결.
OCR: Docker/CI Tesseract kor+eng 및 언어 preflight. 실제 Python11spans/첨부7 PASS, 없는 엔진은 MESSAGE_IMAGE_RETRY/OCR_ENGINE_UNAVAILABLE.
E/F 실제 Supabase:18파일/26시험 전부 PASS·fail/skip0·준비/정리PASS. F PR39587959131 SUCCESS. E 이미지 runtime/pull과 기존서명rc.13 빌드는 통과했으나 최종 G로 대체 예정.
F Windows39588005717:171중169PASS/0FAIL/2NOT_RUN. 실APIfixture 두 시험은 hosted 환경 미제공. G의전체정책 저장·재열기·lostACK 영향48/48 PASS.
Windows 실제fixture: 전용5290/5291·실제Auth/Storage/API/worker로2/2 PASS·fail/skip0. 최초1FAIL/1NOT_RUN은 옛선택자가실제로녹음을선택→정확텍스트ID/판route로수정, 기존span/금액/발행·원본/PDF hash·재개단언전부PASS. 합성내부시험이며고객인수아님.
OS: 승인/UAC후WSL업데이트exit0·3.0.3.0, 사용자Docker재연결뒤Linux29.8엔진응답. Windows2시험후전용환경정리·기존config/env byte복원·기존컨테이너/5190/55439 보존PASS. 재부팅/초기화/추가OS설정변경0.
Android 실제기동: VM 가용8.79→14.96GB(.NET만정리)·43.6s부팅·실제Auth/Storage/API/worker fixture PASS. F17중15PASS/2FAIL/skip0·정리PASS, 촬영/업로드/업데이트 전후 PASS.
G Android: 정확 revision 주소의 JSON표현 비교 수정·남은 구선택자 수정. 실제native발신6read에서4성공/2work_busy 재현→최대2발신·32FIFO·미전송 만료·close 취소, 불명 write 자동 재송신0·무응답 만료 뒤 독립 읽기 계속.
G 정책: 주 Anthropic 의미처리와 별도 OpenAI long_stt 목적 분리. 전체processing_policy 저장·재열기·현재내용 비교, 기존 원천/AI동의 자동확대0·정책변경뒤 철회 가능.
G 계약/DB: 새90 fresh PASS·TS/SQL 목적일치·실제source/API/revoke/전사 재사용/제출1회 영향2/2 PASS·tenant PASS. 최초PG103중94PASS/9FAIL에서8환경+1fixture를 수정해 영향8/8+2/2 PASS, 중복 합산 금지.
G 소비자: 웹10/10·Android standard93/93/smsSync29/29·추가queue/진단16/16 PASS·typecheck·두variant instrumentation compile PASS. 320/390px2캡처 overflow/axe/console/작은target0, 글자권고각1.
운영 음성 직접확인: 기존 OpenAI 장기STT 합성4초1건 HTTP200·전사/segment1 PASS, DB/동의 생성0. 구판 짧은음성 ffprobe 부재→H 실제 nonroot 이미지 합성1초 ffprobe·network none/read-only 검사 PASS·공급자0회. 최종 이미지 전환 뒤 실제 짧은음성 확인 예정.
검수 A-F: 커밋별 외부 Fable5.1 high 6세션(동일E후속1회 포함7호출). 재현P1 수정·국소영향PASS. Pro/firstParty 실제계정사용, 실제청구액 UNKNOWN·모델/도구/거부/응답hash 비공개.work.
G native: 공통 사건/학습/AI동의/신규문서·품목수정의 설치앱 중계 누락 복구. Windows83route Decode/Path 누락0·실제adapter/fakeHTTP/문서 guard28/28 PASS, Android 실제adapter/MockWebServer·Bridge 영향23/23, queue/무응답 영향9/9 PASS·두variant compile PASS.
G 검수: Fable5.1 high 단일세션과 같은 세션의 새범위 후속에서 직접24/24 PASS. Linux의 Windows전용시험 skip으로 CI실패하는 P1 재현→OS별 실행/NOT_RUN 표시·Windows 실제job 연결. 두호출 도구107요청/거부3, 추가검수0.
전체 범위 감사: 기존25포함118파일382중360PASS/21FAIL/1SKIP→13환경오분류·UI7·복구목록1 수정. 새runner112파일372/372 PASS에는 DB1건 포함. 최종root181파일 unit111/PG48/Supabase22 정확1분류, Linux unit110/Windows전용1 실제job 분리.
범위 영향: classifier/환경/PG15/15·UI16/16·기기복구목록3/3 PASS. Python 전체105cases+39subtests PASS·fail/skip0. 검수P1 영향catalog6/6·PG1/1·실제Windows installer1/1 PASS, 원격DB접속 전 차단 확인. 실제Supabase22/D19·Linux 최종실행은 대기.
G 최종: PR39596090830 FAIL. Linux372중371PASS/1FAIL(MMS실OCR)·PG48/core/tenant NOT_RUN. Supabase22파일21PASS/1FAIL·30중29PASS/1FAIL(D19첫복원 내부원인UNKNOWN), 준비/정리PASS·Python105+39 PASS.
G 설치/이미지: Windows39596134478 Node설치1FAIL(원인UNKNOWN)·native전체NOT_RUN. 이미지39596112392 archive누락FAIL. Android39596123445 실제17/17PASS·fixture/AuthStorageAPIworker/cleanupPASS·ZIPdigest일치. H 제품모듈불변·최종tree대조로인계예정, 새공개설치물/운영 미반영.
H 실제 CI: Linux unit110파일377/377·PG49파일114/114·tenant PASS. 실제Supabase22파일 중21PASS/1FAIL(30중29/1), D19는Linux에서Windows DPAPI호출로 복원검사 전 중단. Python105+39 PASS. 이미지 runtime/push/pull digest PASS·운영 미배포.
H Windows: hosted native186중184PASS/0FAIL/2NOT_RUN·Node설치1FAIL(INSTALL_FIRST exit1)·최종전체FAIL 유지. G Android 실제17/17와 H의6개제품subtree동일 확인. 각artifact ZIP SHA대조PASS, 별도local실API2/2와혼합집계하지않음.
I 수정: 실제 Windows 짧은경로/끝separator 2실패·기본PowerShell 미지원API 실패 재현→동일표현·루트보존·PS5호환 정규화, 실제PS5 설치/보호12+두runtime루트2=14/14 PASS. 합성 Linux hosted/정확seedDB/전체opt-in에서만32byte RAM키·입구재검사, 기본운영 DPAPI/SQL/원본·돈·RLS검증 불변. 복원8/8·typecheck·검수직접22/22 PASS.
I 실제 CI: Linux unit110파일379/379·PG49파일114/114·tenant·Python105+39 PASS. Supabase22파일21PASS/1FAIL(30중29/1), D19실제1/1PASS14.987초·전체행/원본/격리복원필수assertion·제품/키/큐인수false유지. 유일PDF2중1FAIL은retry기대값불일치·actual원문UNKNOWN.
I Windows/이미지: hosted Node14/14·native186중184PASS/0FAIL/2NOT_RUN·최종SUCCESS. 실제localAPI2/2는별도. 이미지22gates/runtime/push/pull·digest PASS. J는시험fixture1줄·사실문서뿐, 최종제품tree대조뒤기기인계·새이미지/공개설치물예정.
J 보완: 실제venv importprobe에서임시파서선택false→빈__init__.py후true. timeout250ms/반감10/203page/권한/재개·멱등단언불변, fresh실AuthStorageworker2/2PASS·diffPASS. config/envbyte복원·전용projectstopPASS이나엄격Docker상태비교false/원래cleanupFAIL보존; 기존vector자동재시작관측·인과UNKNOWN·기존DBhashNOT_RUN.
독립 검수: A-J Fable5.1 high 커밋별10세션15호출·도구504요청/거부44. I직접22/22·신규fixture후속specPASS, J직접실Python프로브/specPASS·P0/P1없음. J해시직접산출/JSONparse등거부NOT_RUN보존·Pro/firstParty 실제계정·청구UNKNOWN, 통합usage·원문/응답hash 비공개.work.
설치 안내: /download/windows→공개rc.13 Setup.exe HTTP200·155004928bytes·SHA256SUMS/GitHub digest 일치. README 직접링크·실행안내 추가. 기존 Windows 설치기의 이번 PC 실행은 미실행.
외부 인수: SM-S721N user0 READ_SMS/마이크 허용·삼성기본문자 유지·명시 동의한 모든 새 문자 범위. 실제SMS1건 업무판별·parse complete·본문 일치/재열기 확인, 사건1/할일1·현장 확인 전. MMS/녹음/촬영/실기기CI/전체 업무정답·PRODUCT_ACCEPTED는 별도.
이번 검증: 작성자 smsSync95/95·SQLite 날짜경계36/36·기존서명/정렬·ADB 설치/실제 SMS1건 PASS. 독립 정적검수1회 P0/P1 없음·검수자 명령 재실행은 권한 거부로 미실행. 상세 비공개 .work/sms-live-20261024·.work/claude-runs. 사용자 미커밋 파일 제외.
문서 정본: AGENT_SPEC 계약 / ENVIRONMENT 절차 / 현재 사실 이 파일. 배포 후 상태 후기는 다음 정상 커밋에 포함, 상태만 추가 커밋하지 않음.
