import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayView, QuestionCard, fixtureToday } from "../apps/web/src/today.tsx";
import { AppFrame } from "../apps/web/src/navigation.tsx";
import { answerOutcome, demoReducer, emptySession, questions, remainingQuestions, waitingQuestions } from "../apps/web/src/demo-session.ts";
import { readRoute } from "../apps/web/src/app.tsx";

const banned = /귀속|연결|객체|상태|미확정|기준자료|행\/셀|locator|시트\s*\d|I12|B4/;
const noop = () => {};
function outcomeFor(session: Parameters<typeof waitingQuestions>[1], id: string) {
  const question = questions.find(item => item.id === id);
  const answer = session.answers[id];
  assert.ok(question && answer);
  return answerOutcome(question, answer);
}

test("UX Today has one answer card, keeps every other due question reachable, and labels rehearsal", () => {
  const html = renderToStaticMarkup(<AppFrame active="today" onNavigate={noop}><TodayView /></AppFrame>);
  assert.equal((html.match(/aria-labelledby="question-title"/g) ?? []).length, 1);
  assert.match(html, /타일 붙일 바탕이 준비됐나요/);
  for (const question of questions.slice(1)) assert.ok(html.includes(question.question));
  assert.match(html, /실제 업무에는 반영되지 않아요/);
  assert.match(html, /aria-current="page"/);
  assert.doesNotMatch(html, /disabled|<textarea|fact-grid/);
  assert.doesNotMatch(html, banned);
});

test("UX every question and answer uses reality language without exposing internal coordinates", () => {
  for (const item of questions) {
    for (const choice of [undefined, "yes", "no", "later", "unknown"] as const) {
      const html = renderToStaticMarkup(<QuestionCard item={item}
        {...(choice ? { answer: { choice } } : {})} onAnswer={noop} onUndo={noop} onNext={noop} />);
      assert.doesNotMatch(html, banned);
      assert.match(html, /무엇을 보고 물어보나요/);
      if (choice) assert.match(html, /답 고치기/);
    }
  }
});

test("UX one answer creates one rehearsal record; repeat click does not duplicate money and undo preserves history", () => {
  const action = { type: "answer", id: "duplicate", answer: { choice: "yes" } } as const;
  const one = demoReducer(emptySession, action);
  assert.equal(Object.keys(one.answers).length, 1);
  assert.equal(demoReducer(one, action), one);
  assert.match(outcomeFor(one, "duplicate").consequence, /150,000원 한 번/);
  const corrected = demoReducer(one, { ...action, answer: { choice: "no" } });
  assert.match(outcomeFor(corrected, "duplicate").consequence, /300,000원/);
  assert.equal(corrected.history.length, 2);
  assert.equal(corrected.history[1]?.before?.choice, "yes");
  const undone = demoReducer(corrected, { type: "undo", id: "duplicate" });
  assert.equal(undone.answers.duplicate, undefined);
  assert.equal(undone.history.length, 3);
  assert.equal(emptySession.history.length, 0);
});

test("UX payment answer and deferral never mean all work or money is closed", () => {
  let session = demoReducer(emptySession, { type: "answer", id: "payment", answer: { choice: "yes" } });
  assert.equal(waitingQuestions(questions, session).length, 1);
  assert.match(outcomeFor(session, "payment").consequence, /보낸 돈은 아직 계산하지 않아요/);
  session = demoReducer(session, { type: "answer", id: "delivery", answer: { choice: "later" } });
  assert.equal(remainingQuestions(questions, session).length, 3);
  const html = renderToStaticMarkup(<TodayView session={session} selectedId="summary" />);
  assert.match(html, /나중에 답할 질문/);
  assert.match(html, /오후에 다시/);
  assert.doesNotMatch(html, /모든 일이 끝|모든 돈|지급 완료/);
});

test("UX differing quantity accepts zero, rejects decimals, and preserves an unresolved discrepancy", () => {
  for (const quantity of [-1, 1.5, Number.NaN, 100000]) {
    assert.equal(demoReducer(emptySession, { type: "answer", id: "delivery", answer: { choice: "quantity", quantity } }), emptySession);
  }
  for (const quantity of [0, 20, 30]) {
    const session = demoReducer(emptySession, { type: "answer", id: "delivery", answer: { choice: "quantity", quantity } });
    assert.equal(waitingQuestions(questions, session).length, 1);
    assert.ok(outcomeFor(session, "delivery").summary.includes(String(quantity)));
  }
  assert.equal(demoReducer(emptySession, { type: "answer", id: "payment", answer: { choice: "quantity", quantity: 25 } }), emptySession);
});

test("UX no captured source is unknown, not a claim that everything is fine", () => {
  const html = renderToStaticMarkup(<TodayView data={{ ...fixtureToday, items: [] }} />);
  assert.match(html, /확인할 일이 없는지는 알 수 없어요/);
  assert.match(html, /최근 업무 자료를 가져온 때: 아직 없음/);
  assert.doesNotMatch(html, /모두 답했어요|문제없|연결/);
});

test("UX unprepared work and unpaid bills stay visible as actions after every question is answered", () => {
  let session = emptySession;
  for (const item of questions) session = demoReducer(session, { type: "answer", id: item.id, answer: { choice: "no" } });
  const html = renderToStaticMarkup(<TodayView session={session} selectedId="summary" />);
  assert.match(html, /답한 뒤에도 남은 일/);
  assert.match(html, /현장 담당자와 오늘 작업 일정을 확인해 주세요/);
  assert.match(html, /오늘 지급 기한을 챙겨주세요/);
  assert.doesNotMatch(html, /소식을 더 기다리는 일|모든 일이 끝/);
  const unknown = demoReducer(emptySession, { type: "answer", id: "ready", answer: { choice: "unknown" } });
  assert.match(renderToStaticMarkup(<TodayView session={unknown} selectedId="summary" />), /담당자에게 물어볼 일/);
});

test("UX hash routes support browser history and reject unknown top-level surfaces", () => {
  assert.deepEqual(readRoute("#projects/project-1"), { tab: "projects", id: "project-1" });
  assert.deepEqual(readRoute("#materials/e-1"), { tab: "materials", id: "e-1" });
  assert.deepEqual(readRoute("#today/payment"), { tab: "today", id: "payment" });
  assert.deepEqual(readRoute("#secret"), { tab: "today" });
});
