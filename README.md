# 시공노트 · 현장 업무원장 시연

새 자료를 현장별 원장에 모으고, 거래·변경·확인할 일을 원문과 연결해 CSV와 현황 보고서로 전달합니다.

이 공개 저장소는 `Cerhovah/Sigongnote`의 main `883c6a7e8c6a8f739fdc2f30a88ac27786831e9f`에서 출발한 별도 소스 저장소입니다. 가져온 범위는 [PUBLIC_SOURCE.json](PUBLIC_SOURCE.json)에 있습니다. 고객 자료와 이전 Git 이력, 운영 배포 설정은 포함하지 않습니다.

## 실행

Node 24와 npm이 필요합니다. PDF 출력에는 PC에 설치된 Edge 또는 Chrome을 사용합니다.

```powershell
git clone https://github.com/Cerhovah/Sigongnote-Demo.git
cd Sigongnote-Demo
git config core.hooksPath .githooks
npm.cmd ci --ignore-scripts
npm.cmd run demo:build
npm.cmd run demo:start -- --data-dir "../sigongnote-demo-private" --port 8770
```

[로컬 시연 화면](http://127.0.0.1:8770/)을 엽니다. 처음 실행하면 빈 원장으로 시작합니다. 제공받은 현장 JSON 묶음을 **자료 추가**로 넣거나 아래 방식으로 기존 데이터셋을 연결합니다. 데이터 폴더는 Git 저장소 밖에 둡니다.

## 다섯 보기

| 보기 | 하는 일 |
|---|---|
| 오늘의 현황 | 들어온 기록, 주요 변경, 대표가 확인할 업무 |
| 현장 업무원장 | 시간순 기록, 검색·날짜 필터, 원문 근거와 이전 기록 |
| 거래·분개 | 청구·입금·지급·정산 기록, 수량·금액과 확인 상태 |
| 변경·미결 | 바뀐 내용, 이전 기록, 다음 확인 행동 |
| 공유·보고서 | 같은 기준의 원장 CSV·현황 PDF·HTML, 파일 공유·저장 |

현장 귀속과 업무 확인 상태는 별도로 표시합니다. 기본 원장에는 연결된 현장 기록이 나오며 **귀속 검토**에서 관련 후보를 봅니다. 제공된 자료에 봉천동과 대전 병원이 있으면 봉천동을 먼저 열고, 다른 현장 버튼으로 대전 병원의 변경 기록을 비교합니다. 공개 코드에는 해당 고객의 데이터가 없습니다.

## 기존 데이터셋 연결

기존 `시안/data.js`, `03_업무원장.csv`, `06_원문근거연결표.csv`가 있는 데이터셋을 변환합니다. Python 표준 라이브러리만 사용합니다.

```powershell
python scripts/import-field-dataset.py --input "<기존 데이터셋 폴더>" --output "<저장소 밖 비공개 폴더>" --hold-back-one
npm.cmd run demo:start -- --data-dir "<저장소 밖 비공개 폴더>" --port 8770
```

`--hold-back-one`은 실제 기록 한 건을 `신규반영_실제기록.json`으로 따로 준비합니다. **자료 추가**에서 이 파일을 넣으면 원장과 새로운 공유 결과물에 반영됩니다. 과거 업무 날짜를 바꾸지 않고 기존 실제 자료로 추가 반영 동작을 시연합니다.

비공개 폴더의 `bundle.json`은 업무 기록, `source-paths.json`은 자료 ID와 원문의 로컬 연결을 담습니다. 문자는 해당 기록의 근거 발췌만 열며 휴대폰 전체 아카이브를 제공하지 않습니다. 기존 원본은 변경하지 않습니다.

## 새 자료와 공유 결과물

- **JSON 업무 묶음:** 명시된 현장·업무·변경 항목과 근거 ID를 검증해 반영합니다.
- **구조화 CSV:** 내보낸 원장 또는 업무ID·업무유형·요청내용·원문자료ID가 있는 한국어 원장을 읽습니다. 같은 ID의 내용을 바꿀 때는 높은 `기록버전` 또는 `revision`을 명시합니다.
- **일반 문서·사진·TXT·다른 CSV:** 선택한 현장의 새 자료 접수 기록과 원문으로 저장합니다. 문서 의미 해석이나 금액·완료 여부를 생성하지 않습니다.
- **자동 접수:** 비공개 폴더의 `incoming/<현장ID>/` 자료를 2초 간격으로 반영합니다. 화면은 15초 간격으로 갱신되며 새로고침으로 바로 확인할 수 있습니다.

같은 파일은 중복 기록을 만들지 않습니다. 잘못된 구조화 묶음은 전체를 거부하며 행 일부만 반영하지 않습니다. 로컬 시연 실행은 원문을 외부 AI·클라우드에 전송하지 않습니다.

현장·날짜·검색·귀속 필터가 화면과 CSV·보고서에 공통 적용됩니다. 각 결과물에는 기준 ID와 생성 시각이 들어가며 새 자료가 들어와도 이전 보고서는 같은 내용으로 다시 열립니다. PDF는 로컬 브라우저로 출력해 보관하고 HTML은 외부 자원 없이 열립니다. 파일 공유를 지원하면 기기의 공유 창을 열고, 그 외 환경에서는 파일을 저장합니다. 상대방에게 전달할 파일은 사용자가 선택합니다.

## 검사와 피드백

```powershell
npx.cmd tsc -p packages/contracts/tsconfig.build.json
npx.cmd tsc -p packages/domain/tsconfig.build.json
npm.cmd run typecheck
npm.cmd run demo:test
npm.cmd run demo:build
node scripts/check-spec.mjs
```

합성 자료는 내부 회귀시험에서만 사용합니다. 새 접수→원장→원문→CSV/보고서→재시작, 귀속/확인 상태 분리, 중복·버전 충돌과 공유 기준 보존을 검사합니다. 현재 결과와 검수 범위는 [EXECUTION_STATE.md](docs/EXECUTION_STATE.md)에 있습니다.

- [시연 저장소 이슈](https://github.com/Cerhovah/Sigongnote-Demo/issues)
- [원본 서비스](https://sigongnote-api.onrender.com/) · [원본 설치 안내](https://sigongnote-api.onrender.com/install)
- [작업 규칙](AGENTS.md) · [기능 명세](docs/AGENT_SPEC.md) · [환경 절차](docs/ENVIRONMENT.md)

시연 명령은 로컬 시연판을 실행합니다. 원본 서비스의 서버·DB·설치 앱 배포는 변경하지 않습니다.
