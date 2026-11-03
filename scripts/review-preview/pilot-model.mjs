// Observer-entered aggregates only. Unknown measurements are never treated as zero.
export const PILOT_KEY = 'sigongnote-pilot-v1';
export const numericFields = ['normal', 'untouched', 'baseline', 'operation', 'correction', 'support', 'reconciliation', 'repeated', 'cost'];
export const timeFields = ['operation', 'correction', 'support', 'reconciliation'];
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function validateEntry(input, today = localDate()) {
  const value = { date: input.date, mode: input.mode, workday: input.workday === true };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date || '') || !Number.isFinite(Date.parse(`${value.date}T12:00:00Z`)) || new Date(`${value.date}T12:00:00Z`).toISOString().slice(0, 10) !== value.date || value.date > today) throw Error('지난 날짜 또는 오늘 날짜를 선택해 주세요.');
  if (!['practice', 'actual'].includes(value.mode)) throw Error('연습과 실제 사용을 구분해 주세요.');
  for (const field of numericFields) {
    const raw = input[field];
    if (raw === null || raw === undefined || raw === '') { value[field] = null; continue; }
    if (!['number', 'string'].includes(typeof raw) || (typeof raw === 'string' && !/^\d+(\.\d+)?$/.test(raw))) throw Error('측정값은 0 이상의 숫자로 적어 주세요.');
    const number = Number(raw);
    const minutes = field === 'baseline' || timeFields.includes(field);
    if (!Number.isFinite(number) || number < 0 || number > (minutes ? 1440 : field === 'cost' ? 1e9 : 100000) || (!minutes && !Number.isInteger(number))) throw Error('시간은 하루 1440분 이내, 건수·비용은 정수로 적어 주세요.');
    value[field] = number;
  }
  if (value.untouched !== null && (value.normal === null || value.untouched > value.normal)) throw Error('무조작 자료 수는 정상 자료 수 이하로 적어 주세요.');
  if (timeFields.reduce((sum, key) => sum + (value[key] ?? 0), 0) > 1440) throw Error('네 종류의 시간을 중복 없이 나눠 적어 주세요. 합계는 하루 1440분 이내입니다.');
  for (const key of ['capture', 'judgment', 'document']) value[key] = input[key] === true;
  value.comparable = input.comparable === true;
  value.void = input.void === true;
  value.testedBuild = String(input.testedBuild || '').trim();
  if (value.testedBuild && !/^[A-Za-z0-9._+-]{1,60}$/.test(value.testedBuild)) throw Error('사용 앱 버전은 영문·숫자 버전이나 커밋 번호로 적어 주세요.');
  value.paid = input.paid || 'unknown';
  if (!['unknown', 'intention', 'first', 'repeat', 'declined'].includes(value.paid)) throw Error('유료 사용 관찰을 선택해 주세요.');
  value.evidence = String(input.evidence || '').trim();
  if (value.evidence && !/^[A-Za-z0-9_-]{1,40}$/.test(value.evidence)) throw Error('근거는 이름·원문 없이 짧은 영문/숫자 확인번호로 남겨 주세요.');
  if (['first', 'repeat'].includes(value.paid) && !value.evidence) throw Error('실제 결제를 관찰했다면 별도 보관한 근거의 확인번호가 필요해요.');
  return value;
}
export function readPilot(raw) {
  if (!raw) return { schema: 1, entries: [], history: [] };
  const state = JSON.parse(raw);
  if (state?.schema !== 1 || !Array.isArray(state.entries) || !Array.isArray(state.history) || state.entries.length > 500 || state.history.length > 500) throw Error('저장된 실사용 기록을 읽지 못했어요. 원본을 복사해 보관한 뒤 초기화해 주세요.');
  const keys = new Set();
  state.entries = state.entries.map(entry => ({ ...entry, ...validateEntry(entry, '9999-12-31') }));
  for (const entry of state.entries) {
    const key = `${entry.mode}:${entry.date}`;
    if (keys.has(key)) throw Error('중복 날짜가 있는 기록은 합산하지 않아요. 원본을 보관해 주세요.');
    keys.add(key);
  }
  for (const entry of state.history) validateEntry(entry, '9999-12-31');
  return state;
}
export function saveEntry(state, input, build, now = new Date()) {
  const entry = { ...validateEntry(input, localDate(now)), build, recordedAt: now.toISOString(), source: 'observer-reported' };
  const old = state.entries.find(item => item.date === entry.date && item.mode === entry.mode);
  if ((!old && state.entries.length >= 500) || (old && state.history.length >= 500)) throw Error('보관 한도에 도달했어요. 기록을 내보내 보관한 뒤 새 관찰을 시작해 주세요.');
  return { schema: 1, entries: [...state.entries.filter(item => item !== old), entry], history: old ? [...state.history, old] : [...state.history] };
}
export function summarize(state, today = localDate()) {
  const actual = state.entries.filter(item => item.mode === 'actual' && !item.void && item.date <= today);
  const entries = actual.filter(item => item.workday);
  const sum = key => entries.length && entries.every(item => item[key] !== null) ? entries.reduce((total, item) => total + item[key], 0) : null;
  const normal = sum('normal'), untouched = sum('untouched'), baseline = sum('baseline');
  const times = timeFields.map(sum);
  const burden = times.every(value => value !== null) ? times.reduce((a, b) => a + b, 0) : null;
  return {
    days: entries.length, practiceDays: state.entries.filter(item => item.mode === 'practice' && !item.void && item.date <= today).length,
    voidDays: state.entries.filter(item => item.void).length,
    futureDays: state.entries.filter(item => !item.void && item.date > today).length,
    missingBuildDays: entries.filter(item => !item.testedBuild).length,
    zeroOperation: normal > 0 && untouched !== null ? 100 * untouched / normal : null,
    reduction: baseline > 0 && burden !== null && entries.every(item => item.comparable) ? 100 * (baseline - burden) / baseline : null,
    baseline, burden, repeated: sum('repeated'), cost: sum('cost'), support: sum('support'),
    coverage: ['capture', 'judgment', 'document'].filter(key => entries.some(item => item[key])),
    paidRepeat: new Set(actual.filter(item => item.paid === 'repeat' && item.evidence).map(item => item.evidence)).size,
    assessment: '관찰자 입력 집계 · 실사용 인수 및 유료 유지 판정은 별도'
  };
}
