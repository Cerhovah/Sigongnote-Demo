import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import axe from "axe-core";
import { focusHash, readFocusRoute, guideSteps } from "../apps/web/src/focus-ui.js";
import { formatFieldMoney } from "../apps/web/src/field-ui.js";

test("focus routes reject malformed IDs, preserve back destinations, money unknown is not zero", () => {
  const route = { tab: "materials", view: "site", id: "11111111-1111-4111-8111-111111111111" } as const;
  assert.deepEqual(readFocusRoute(focusHash(route)), route);
  assert.equal(readFocusRoute("#materials/document/not-a-document").view, "home");
  assert.equal(readFocusRoute("#materials/document/------------------------------------").view, "home");
  assert.equal(readFocusRoute("#unknown/unknown").tab, "today");
  assert.equal(formatFieldMoney(null), "아직 확인 못했어요");
  assert.equal(formatFieldMoney("0"), "0원");
  assert.equal(formatFieldMoney("150000"), "150,000원");
  assert.equal(formatFieldMoney("150000.00"), "아직 확인 못했어요");
  for (const step of guideSteps) { assert(step.title.length <= 16); assert(step.text.length <= 65); assert.doesNotMatch(step.text, /귀속|연결|객체|상태|미확정|기준자료|행\/셀/); }
});

test("focus mounted journey: two groups, accessible forms, document roundtrip, consent cancellation and versioned answer", async () => {
  const dom = new JSDOM('<!doctype html><html lang="ko"><head><title>시공노트</title></head><body><div id="root"></div></body></html>', { url: "http://localhost/?actor=agent_test", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  Object.assign(globalThis, { window: win, document: win.document, location: win.location, history: win.history, localStorage: win.localStorage, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  win.scrollTo = () => {};
  win.localStorage.setItem("sigongnote-guide-v3", "seen");
  const id = "11111111-1111-4111-8111-111111111111", project = "22222222-2222-4222-8222-222222222222";
  const doc = { id, name: "검증용 견적.txt", relative_path: "업무/검증용 견적.txt", status: "complete", revision: 7, hash: "a".repeat(64), excerpt: "자재 견적", site: null, available: 1, category: "quote", parsed: { spans: [{ text: "합성 검증 자료: 자재 5개", locator: "line:1" }] } };
  const question = { id: "q1", question: "어느 현장 일인가요?", version: 3, attribution_version: 2, source_hash: doc.hash, local_document_id: id, document_id: id, display_title: doc.name };
  const calls: { route: string; body: { answer?: { version: number; attribution_version: number; actor: string } } | undefined }[] = [];
  let answered = false, failToday = false, failSearch = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const route = String(url).replace("/api/", ""), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (route === "status") return response({ sources: [{ id, root: "work", enabled: 1, problem: null, last_scan: new Date().toISOString(), skipped: 0 }], total: 41, counts: [{ status: "complete", count: 41 }], duplicates: 0, progress: { phase: "idle", inventoried: 41, processed: 41 }, sites: [], field: { configured: true, pending: 0 }, ai: { configured: true, model: "fixture" }, folderQuestion: null });
    if (route === "field/today") return failToday ? response({ error: "READ_FAILED" }, 503) : response({ items: answered ? [] : [question, { ...question, id: "q2" }] });
    if (route === "field/projects") return response({ projects: [{ id: project, display_name: "검증 현장" }] });
    if (route.startsWith("field/projects/")) return response({ project: { id: project, display_name: "검증 현장" }, money: { confirmed_cost: null, receivable: "0", payable: "150000" }, quotes: [] });
    if (route.startsWith("documents?")) { if (failSearch) return response({ error: "UNAVAILABLE" }, 503); const offset = Number(new URLSearchParams(route.split("?")[1]).get("offset")); return response({ total: 41, documents: Array.from({ length: Math.min(40, 41 - offset) }, (_, i) => ({ ...doc, id: `${String(i + offset).padStart(8, "0")}-1111-4111-8111-111111111111` })) }); }
    if (route.startsWith("documents/") && !route.endsWith("/site")) return response(doc);
    if (route === "ai/prepare") return response({ id: "plan-ai", provider: "fixture", model: "fixture", payload: doc.parsed });
    if (route === "copies/prepare") return response({ id: "plan-copy", destination: "output", items: [{ id, name: doc.name, destination: "output/file.txt" }] });
    if (route.includes("/answer")) answered = true;
    return response({ ok: true });
  };
  const { createRoot } = await import("react-dom/client");
  const { LocalApp } = await import("../apps/web/src/local-app.js");
  const container = win.document.getElementById("root"); assert.ok(container); const root = createRoot(container);
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 290)); });
  const click = async (text: string) => {
    const button = [...win.document.querySelectorAll<HTMLElement>("button,a")].find(e => e.textContent?.trim() === text || e.querySelector("strong")?.textContent === text);
    assert.ok(button, `Missing control: ${text}`);
    await act(async () => { button.click(); }); await settle();
  };
  const route = async (hash: string) => { await act(async () => { win.location.hash = hash; }); await settle(); };
  const assertFocus = () => { assert(win.document.querySelectorAll("main [data-chunk]").length <= 2); assert(win.document.querySelectorAll("main [data-primary]").length <= 1); };
  const assertAccessible = async () => {
    win.eval(axe.source);
    const result = await (win as unknown as { axe: typeof axe }).axe.run(win.document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false } } });
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))));
  };
  try {
    await act(async () => { root.render(<LocalApp />); }); await settle(); assertFocus();
    assert.match((win.document.body.textContent ?? ""), /확인할 일 1 \/ 2/); await assertAccessible();
    await click("다른 질문 보기"); assert.match((win.document.body.textContent ?? ""), /확인할 일 2 \/ 2/);
    await click("자료 먼저 보기"); assertFocus(); assert.match(win.location.hash, /today\/document/);
    await click("현장 알려주기"); assertFocus(); await assertAccessible();
    await click("취소"); assert.equal(calls.filter(c => c.route.endsWith("/site")).length, 0);
    await click("더 할 일"); await click("AI 요약"); assertFocus();
    assert.match((win.document.body.textContent ?? ""), /이용료/); assert.match((win.document.body.textContent ?? ""), /회수할 수 없어요/);
    await click("보내지 않기"); assert.equal(calls.filter(c => c.route.includes("/approve")).length, 0);
    await click("더 할 일"); await click("정리용 복사본"); assertFocus(); await click("취소");
    assert.equal(calls.filter(c => c.route.includes("/approve")).length, 0);
    await click("← 돌아가기"); assert.deepEqual(readFocusRoute(win.location.hash), { tab: "today", view: "home", id: "" });
    await click("현장"); assertFocus(); await click("검증 현장"); await click("비용과 받을 돈"); assertFocus();
    assert.match((win.document.body.textContent ?? ""), /아직 확인 못했어요/); assert.match((win.document.body.textContent ?? ""), /0원/);
    await click("자료"); assertFocus(); assert.equal(win.document.querySelectorAll("main li").length, 20);
    await click("다음"); assert.equal(win.document.querySelectorAll("main li").length, 20); assert.match((win.document.body.textContent ?? ""), /21–40/);
    await click("다음"); assert.equal(win.document.querySelectorAll("main li").length, 1); assert.match((win.document.body.textContent ?? ""), /41–41/);
    await click("오늘"); failSearch = true; await click("자료");
    assert.match(win.document.querySelector(".result-count")?.textContent ?? "", /목록을 가져오지 못했어요/);
    assert.doesNotMatch(win.document.querySelector(".result-count")?.textContent ?? "", /0개/);
    failSearch = false; await click("다시 찾기"); assert.match(win.document.querySelector(".result-count")?.textContent ?? "", /41개/);
    await route(`#today/folder/${id}`); await click("읽기 중지…"); assertFocus();
    assert.equal(calls.filter(c => c.route === `folders/${id}`).length, 0); await click("계속 읽기");
    assert.equal(calls.filter(c => c.route === `folders/${id}`).length, 0);
    await route("#today/guide"); assertFocus(); await assertAccessible(); await click("다음 사용법"); await click("오늘 보기");
    const select = win.document.querySelector<HTMLSelectElement>("#field-project"); assert.ok(select);
    await act(async () => { select.value = project; select.dispatchEvent(new win.Event("change", { bubbles: true })); });
    const submit = [...win.document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "이 현장 일이에요"); assert.ok(submit);
    await act(async () => { submit.click(); submit.click(); }); await settle();
    const answers = calls.filter(c => c.route.includes("/answer")); assert.equal(answers.length, 1);
    assert.equal(answers[0]?.body?.answer?.version, 3); assert.equal(answers[0]?.body?.answer?.attribution_version, 2); assert.equal(answers[0]?.body?.answer?.actor, "agent_test");
    assert.match((win.document.body.textContent ?? ""), /새로 답할 일이 없어요/);
    await click("자료"); failToday = true; await click("오늘");
    assert.doesNotMatch((win.document.body.textContent ?? ""), /새로 답할 일이 없어요/); assert.match((win.document.body.textContent ?? ""), /가져오지 못했어요/);
  } finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close(); }
});
