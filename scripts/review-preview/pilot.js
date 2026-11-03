import { PILOT_KEY, numericFields, localDate, readPilot, saveEntry, summarize } from './pilot-model.mjs';
const $ = selector => document.querySelector(selector);
const form = $('#pilot-form'), status = $('#pilot-status'), output = $('#pilot-export-text');
const labels = { normal: '정상 자료 수', untouched: '그중 아무 조작 없이 정리된 수', baseline: '같은 업무량을 기존 방식으로 처리할 때 총 시간(분)', operation: '앱을 직접 조작한 시간(분)', correction: '잘못된 결과를 고친 시간(분)', support: '설명·설정·지원받은 시간(분)', reconciliation: '원문과 결과를 대조한 시간(분)', repeated: '같은 내용을 다시 입력·답변한 횟수', cost: '확인한 운영 비용(원)' };
for (const [key, label] of Object.entries(labels)) {
  const wrapper = document.createElement('div'), title = document.createElement('label'), input = document.createElement('input');
  title.htmlFor = `pilot-${key}`; title.textContent = label;
  input.id = `pilot-${key}`; input.name = key; input.type = 'number'; input.min = '0'; input.step = ['normal', 'untouched', 'repeated', 'cost'].includes(key) ? '1' : 'any'; input.placeholder = '미측정이면 빈칸';
  wrapper.append(title, input); $('#pilot-fields').append(wrapper);
}
let state, build = null, unreadable = false, original = '';
function show() {
  const summary = summarize(state);
  const percent = value => value === null ? '미측정' : `${value.toFixed(1)}%`;
  const time = summary.reduction !== null && summary.reduction < 0 ? `총 관여시간 증가 ${percent(-summary.reduction)}` : `총 관여시간 절감 ${percent(summary.reduction)}`;
  $('#pilot-summary').textContent = `실제 영업일 ${summary.days}/최소 5일 · 연습 ${summary.practiceDays}일(제외)\n무조작 자료 ${percent(summary.zeroOperation)} / 목표 90%\n${time} / 절감 목표 30%\n반복 입력·질문 ${summary.repeated ?? '미측정'}회 / 목표 0회\n지원 ${summary.support ?? '미측정'}분 · 비용 ${summary.cost ?? '미측정'}원\n세 기능 관찰 ${summary.coverage.length}/3 · 유료 유지 확인번호 ${summary.paidRepeat}개(중복 제외)\n앱 버전 미기록 ${summary.missingBuildDays}일 · 제외한 기록 ${summary.voidDays}개 · 미래 날짜 ${summary.futureDays}개(합산 제외)\n${summary.assessment}`;
  const list = $('#pilot-history'); list.replaceChildren();
  for (const entry of [...state.entries].sort((a, b) => b.date.localeCompare(a.date))) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = `${entry.date} · ${entry.mode === 'actual' ? '실제 사용' : '연습'}${entry.void ? ' (집계 제외)' : ''} 수정`;
    button.addEventListener('click', () => {
      for (const key of ['date', 'mode', 'paid', 'evidence', 'testedBuild', ...numericFields]) form.elements.namedItem(key).value = entry[key] ?? '';
      for (const key of ['workday', 'capture', 'judgment', 'document', 'comparable', 'void']) form.elements.namedItem(key).checked = entry[key];
      form.scrollIntoView(); $('#pilot-date').focus(); status.textContent = '수정 후 저장하면 이전 기록도 함께 보관해요. 날짜·구분을 바꾸면 새 기록이 됩니다.';
    }); list.append(button);
  }
}
try { original = localStorage.getItem(PILOT_KEY) || ''; state = readPilot(original); show(); }
catch { unreadable = true; status.textContent = '기존 기록을 읽지 못해 덮어쓰기를 중지했어요. 내보내기로 원본을 보관한 뒤 초기화해 주세요.'; }
$('#pilot-date').value = localDate(); $('#pilot-date').max = localDate();
try { const response = await fetch('/version.json'); if (!response.ok) throw Error(); const data = await response.json(); build = { revision: data.revision, builtAt: data.builtAt, webSourceDirty: data.webSourceDirty }; }
catch { status.textContent = '빌드 정보를 가져오지 못했어요. 서버를 확인한 뒤 새로고침해 주세요. 기록 저장은 보류합니다.'; }
$('#pilot-save').disabled = unreadable || !build;
form.addEventListener('submit', event => {
  event.preventDefault();
  try {
    if (unreadable || !build) throw Error('저장 준비가 되지 않았어요.');
    if ((localStorage.getItem(PILOT_KEY) || '') !== original) throw Error('다른 창에서 기록이 바뀌었어요. 새로고침한 뒤 다시 수정해 주세요.');
    const input = Object.fromEntries(new FormData(form));
    for (const key of ['workday', 'capture', 'judgment', 'document', 'comparable', 'void']) input[key] = form.elements.namedItem(key).checked;
    const next = saveEntry(state, input, build), raw = JSON.stringify(next);
    localStorage.setItem(PILOT_KEY, raw); original = raw; state = next; show(); status.textContent = '이 브라우저에 저장했어요. 같은 날짜·구분은 수정되며 이전 기록도 내보내기에 남아요.';
  } catch (error) { status.textContent = error.message || '저장하지 못했어요. 입력값을 보관해 주세요.'; }
});
$('#pilot-export').addEventListener('click', async () => {
  output.hidden = false;
  let latest = original;
  try { latest = localStorage.getItem(PILOT_KEY) || ''; const current = readPilot(latest); output.value = JSON.stringify({ ...current, summary: summarize(current), exportedAt: new Date().toISOString(), scope: '저장된 관찰자 입력; 서버 전송 없음; 자동 인수 판정 아님' }, null, 2); }
  catch { output.value = latest; }
  try { await navigator.clipboard.writeText(output.value); status.textContent = '기록을 복사했어요. 이 대화에 붙여 주세요.'; }
  catch { status.textContent = '아래 내용을 선택해 복사해 주세요.'; output.focus(); output.select(); }
});
$('#pilot-clear').addEventListener('click', () => {
  if (!confirm('내보낸 기록을 보관했나요? 이 주소의 실사용 기록과 수정 이력만 지웁니다. 기존 피드백은 유지합니다.')) return;
  try {
    if ((localStorage.getItem(PILOT_KEY) || '') !== original) throw Error();
    localStorage.removeItem(PILOT_KEY); location.reload();
  } catch { status.textContent = '기록이 바뀌었거나 지우지 못했어요. 새로고침한 뒤 확인해 주세요.'; }
});
