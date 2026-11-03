const localWorkLink = document.querySelector('#local-work-link');
if (localWorkLink && !['127.0.0.1', 'localhost'].includes(location.hostname)) {
  localWorkLink.removeAttribute('href'); localWorkLink.setAttribute('aria-disabled', 'true');
  localWorkLink.textContent = '이 PC의 브라우저에서 127.0.0.1:5188로 열어 주세요';
}
const storageKey = 'sigongnote-review-v1';
const status = document.querySelector('#feedback-status');
let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {}; } catch { saved = {}; }
function element(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
const answers = new Map();
let report;
let version;
function collect() {
  const merged = { ...(saved.answers || {}) };
  for (const [id, controls] of answers) {
    const prior = merged[id]; const changed = prior?.result !== controls.select.value || prior?.note !== controls.note.value;
    merged[id] = { result: controls.select.value, note: controls.note.value, title: controls.title,
      revision: changed ? version?.revision : prior?.revision || saved.reviewedRevision || version?.revision,
      report: changed ? report?.implementation : prior?.report || report?.implementation };
  }
  return { reviewedRevision: saved.reviewedRevision || version?.revision, notes: document.querySelector('#notes').value, answers: merged };
}
function persist() {
  saved = collect();
  try { localStorage.setItem(storageKey, JSON.stringify(saved)); if (status.textContent !== '이 브라우저에 저장했어요.') status.textContent = '이 브라우저에 저장했어요.'; }
  catch { status.textContent = '브라우저 저장을 사용할 수 없어요. 확인 결과를 복사해 주세요.'; }
}

async function load() {
  [report, version] = await Promise.all(['/content.json', '/version.json'].map(async url => { const res = await fetch(url); if (!res.ok) throw new Error(); return res.json(); }));
  document.querySelector('#release-title').textContent = report.title;
  document.querySelector('#version').textContent = `기능 보고 기준 ${report.implementation} · ${report.updated} / 화면 빌드 ${version.revision}${version.webSourceDirty ? ' (화면 코드 수정 중)' : ''} · ${new Date(version.builtAt).toLocaleString('ko-KR')}`;
  for (const id of ['available', 'pending']) for (const item of report[id]) document.querySelector(`#${id}`).append(element('li', item));
  for (const change of report.changes) {
    const article = element('article', '', 'change'); article.append(element('span', change.status, 'tag'), element('h3', change.title), element('p', change.detail), element('p', change.where, 'small'));
    document.querySelector('#change-list').append(article);
  }
  for (const scenario of report.scenarios) {
    const article = element('article', '', 'scenario'); article.append(element('span', scenario.mode, 'tag'), element('h3', scenario.title), element('p', scenario.steps));
    const select = document.createElement('select'); select.id = `result-${scenario.id}`;
    for (const text of ['아직 안 해봄', '직접 해보니 됨', '막히거나 불편함', '준비 전']) select.append(element('option', text));
    const value = saved.answers?.[scenario.id]; if ([...select.options].some(option => option.value === value?.result)) select.value = value.result;
    const label = element('label', '해본 결과'); label.htmlFor = select.id;
    const note = document.createElement('textarea'); note.id = `note-${scenario.id}`; note.rows = 2; note.maxLength = 2000; note.placeholder = '하려던 일 → 막힌 위치 → 기대한 결과'; note.value = typeof value?.note === 'string' ? value.note.slice(0, 2000) : '';
    const noteLabel = element('label', '불편한 점 또는 확인한 내용'); noteLabel.htmlFor = note.id;
    answers.set(scenario.id, { select, note, title: scenario.title }); select.addEventListener('change', persist); note.addEventListener('input', persist);
    article.append(label, select, noteLabel, note); document.querySelector('#scenarios').append(article);
  }
  const notes = document.querySelector('#notes'); notes.disabled = false; document.querySelector('#export').disabled = false; notes.value = typeof saved.notes === 'string' ? saved.notes.slice(0, 6000) : ''; notes.addEventListener('input', persist);
  document.querySelector('#addresses').textContent = 'https://sigongnote-api.onrender.com/ — 다른 컴퓨터와 모바일 데이터에서도 같은 주소를 사용합니다.';
}
document.querySelector('#export').addEventListener('click', async () => {
  if (!report) return;
  const text = [`시공노트 사용자 확인 · ${new Date().toISOString()}`, `현재 화면 빌드: ${version.revision} / 기능 보고: ${report.implementation} / 의견 작성 시작: ${saved.reviewedRevision || version.revision}`, '사용자가 기록한 결과이며 자동 검증 결과가 아닙니다.', ...Object.entries(collect().answers).map(([id, answer]) => `\n[${answers.has(id) ? answer.title : `이전 확인 항목: ${answer.title || id}`}] ${answer.result}\n작성 기준: ${answer.revision || "이전 기록(버전 미기록)"} / ${answer.report || "미기록"}\n${answer.note || ""}`), `\n추가 의견\n${document.querySelector('#notes').value}`].join('\n');
  const output = document.querySelector('#export-text'); output.hidden = false; document.querySelector('#export-label').hidden = false; output.value = text; output.focus(); output.select();
  try { await navigator.clipboard.writeText(text); status.textContent = '복사했어요. 이 대화에 붙여 주세요. 자동 전송되지는 않아요.'; }
  catch { status.textContent = '아래 결과를 선택했어요. 길게 누르거나 Ctrl+C로 복사해 이 대화에 붙여 주세요.'; }

});
document.querySelector('#clear').addEventListener('click', () => { if (!confirm('이 주소에 저장한 확인 결과를 모두 지울까요?')) return; for (const controls of answers.values()) { controls.select.selectedIndex = 0; controls.note.value = ''; } document.querySelector('#notes').value = ''; saved = {}; document.querySelector('#export-text').value = ''; document.querySelector('#export-text').hidden = true; document.querySelector('#export-label').hidden = true; persist(); status.textContent = '이 브라우저의 확인 결과를 지웠어요.'; });
load().catch(() => { document.querySelector('#load-error').textContent = '확인 정보를 가져오지 못했어요. 서버를 다시 실행한 뒤 새로고침해 주세요.'; });
