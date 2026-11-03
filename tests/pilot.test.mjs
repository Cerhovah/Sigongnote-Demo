import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPilot, saveEntry, summarize, validateEntry } from '../scripts/review-preview/pilot-model.mjs';
const date = '2026-09-29', now = new Date('2026-09-30T00:00:00Z');
const entry = { date, mode: 'actual', workday: true, comparable: true, normal: 10, untouched: 9, baseline: 100, operation: 30, correction: 10, support: 10, reconciliation: 10, repeated: 0, cost: 0, capture: true, judgment: true, document: true };
const save = (state, value) => saveEntry(state, value, { revision: 'fixture' }, now);
test('D20 practice, calendar day, duplicate edits do not fabricate five actual business days', () => {
  let state = save(readPilot(''), { ...entry, mode: 'practice' });
  assert.equal(summarize(state).days, 0);
  state = save(state, { ...entry, workday: false }); assert.equal(summarize(state).days, 0);
  state = save(state, entry); state = save(state, { ...entry, repeated: 2 });
  assert.equal(summarize(state).days, 1); assert.equal(state.history.length, 2);
  assert.equal(summarize(state).repeated, 2); assert.equal(state.history.at(-1).repeated, 0);
});
test('D20 all involvement included; unknowns and no denominator stay unknown', () => {
  let state = save(readPilot(''), entry); assert.equal(summarize(state).zeroOperation, 90); assert.equal(summarize(state).reduction, 40);
  state = save(state, { ...entry, date: '2026-09-28', support: '' });
  assert.equal(summarize(state).reduction, null); assert.equal(summarize(state).support, null);
  assert.equal(summarize(save(readPilot(''), { ...entry, baseline: 0, normal: 0, untouched: 0 })).zeroOperation, null);
  assert.equal(summarize(save(readPilot(''), { ...entry, baseline: 0 })).reduction, null);
  assert.equal(summarize(save(readPilot(''), { ...entry, comparable: false })).reduction, null);
  assert.equal(summarize(save(readPilot(''), { ...entry, baseline: 30 })).reduction, -100);
});
test('D20 dates, counts, minutes and paid evidence validated; intent is not payment', () => {
  for (const bad of [{ date: '2026-02-30' }, { date: '2999-01-01' }, { normal: -1 }, { normal: 1.5 }, { untouched: 11 }, { normal: '', untouched: 1 }, { operation: 1440, support: 1 }, { cost: Infinity }, { cost: ' ' }, { paid: 'repeat' }, { evidence: 'personal name' }]) assert.throws(() => validateEntry({ ...entry, ...bad }, date));
  assert.equal(summarize(save(readPilot(''), { ...entry, paid: 'intention' })).paidRepeat, 0);
  assert.equal(summarize(save(readPilot(''), { ...entry, paid: 'repeat', evidence: 'PILOT-1' })).paidRepeat, 1);
});
test('D20 malformed or duplicate storage never silently resets; missing metric remains null', () => {
  for (const raw of ['bad', '{}', JSON.stringify({ schema: 1, entries: [entry, entry], history: [] })]) assert.throws(() => readPilot(raw));
  const state = readPilot(JSON.stringify({ schema: 1, entries: [{ date, mode: 'actual', workday: true }], history: [] }));
  assert.equal(summarize(state).repeated, null); assert.equal(summarize(state).cost, null);
});
test('D20 void corrections preserve history and remove mistaken days without falsifying workday', () => {
  let state = save(readPilot(''), entry);
  state = save(state, { ...entry, void: true });
  assert.equal(summarize(state).days, 0); assert.equal(summarize(state).voidDays, 1);
  assert.equal(state.history[0].void, false); assert.equal(state.entries[0].workday, true);
  state = save(state, entry); assert.equal(summarize(state).days, 1);
});
test('D20 clock changes preserve records, future days excluded, paid evidence deduplicated even on non-workdays', () => {
  let state = save(readPilot(''), { ...entry, paid: 'repeat', evidence: 'PAID-1' });
  state = save(state, { ...entry, date: '2026-09-28', paid: 'repeat', evidence: 'PAID-1' });
  state = save(state, { ...entry, date: '2026-09-27', workday: false, paid: 'repeat', evidence: 'PAID-2' });
  assert.equal(summarize(state).paidRepeat, 2); assert.equal(summarize(state).missingBuildDays, 2);
  const future = readPilot(JSON.stringify({ schema: 1, entries: [{ ...entry, date: '2099-01-01' }], history: [] }));
  assert.equal(summarize(future, date).days, 0); assert.equal(summarize(future, date).futureDays, 1);
});
