import assert from "node:assert/strict";
import { test } from "node:test";
import { applyExceptionEvent, groupExceptionCauses, projectClosure, projectTodayExceptions,
  type ExceptionRecord } from "../packages/domain/src/exceptions.ts";

const BASE: ExceptionRecord = {
  id: "e1", tenantId: "tenant-a", bundleId: "bundle-a", causeKey: "missing-inspection-1",
  cause: "missing_evidence", state: "open", version: 1, createdAt: "2026-09-29T08:00:00Z",
  stateRecordedAt: "2026-09-29T08:00:00Z",
  dueAt: null, nextReviewAt: null, knownFact: "설치 완료 보고", unknown: "검측 결과",
  impact: "인수 보류", confirmWith: "현장 담당자", action: "검측 자료 확인",
  moneyImpactMinor: null, evidenceIds: [], resolutionEvidenceIds: [], appliedEventIds: [],
  resolutionPredicate: { kind: "evidence_and_decision", requiredEvidenceKind: "inspection" },
};

test("C27 T25 dismissal and defer keep exception unresolved; resolution needs evidence then decision", () => {
  const scope = { tenantId: BASE.tenantId, bundleId: BASE.bundleId, causeKey: BASE.causeKey };
  assert.equal(applyExceptionEvent(BASE, { ...scope, expectedVersion: 1, id: "n1", exceptionId: "e1", kind: "dismiss_notification",
    recordedAt: "2026-09-29T08:10:00Z" }), BASE);
  assert.throws(() => applyExceptionEvent(BASE, { ...scope, expectedVersion: 1, id: "d0", exceptionId: "e1", kind: "defer",
    recordedAt: "2026-09-29T08:10:00Z" }), /DEFER_REVIEW_REQUIRED/);
  const deferred = applyExceptionEvent(BASE, { ...scope, expectedVersion: 1, id: "d1", exceptionId: "e1", kind: "defer",
    recordedAt: "2026-09-29T08:10:00Z", nextReviewAt: "2026-09-30T08:00:00Z", reason: "검측 대기" });
  assert.equal(deferred.state, "deferred");
  assert.throws(() => applyExceptionEvent(deferred, { ...scope, expectedVersion: 2, id: "d2", exceptionId: "e1", kind: "decision",
    recordedAt: "2026-09-29T08:11:00Z", decisionId: "yes" }), /RESOLUTION_PREDICATE_UNSATISFIED/);
  const withEvidence = applyExceptionEvent(deferred, { ...scope, expectedVersion: 2, id: "p1", exceptionId: "e1", kind: "evidence",
    recordedAt: "2026-09-29T08:12:00Z", evidenceId: "inspection-1", evidenceKind: "inspection" });
  assert.equal(withEvidence.state, "awaiting_decision");
  assert.equal(applyExceptionEvent(withEvidence, { ...scope, expectedVersion: 3, id: "d3", exceptionId: "e1", kind: "decision",
    recordedAt: "2026-09-29T08:13:00Z", decisionId: "approve-1" }).state, "resolved");
  assert.equal(applyExceptionEvent(deferred, { ...scope, expectedVersion: 1, id: "d1", exceptionId: "e1", kind: "defer",
    recordedAt: "2026-09-29T08:10:00Z", nextReviewAt: "2026-09-30T08:00:00Z", reason: "검측 대기" }), deferred);
  const reopened = applyExceptionEvent(deferred, { ...scope, expectedVersion: 2, id: "conflict", exceptionId: "e1",
    kind: "new_conflict", recordedAt: "2026-09-29T08:11:00Z" });
  assert.throws(() => applyExceptionEvent(reopened, { ...scope, expectedVersion: 2, id: "late", exceptionId: "e1",
    kind: "evidence", recordedAt: "2026-09-29T08:12:00Z", evidenceId: "inspection-1", evidenceKind: "inspection" }),
  /STALE_EXCEPTION_VERSION/);
  assert.throws(() => applyExceptionEvent(BASE, { ...scope, bundleId: "other", expectedVersion: 1,
    id: "wrong-scope", exceptionId: "e1", kind: "evidence", recordedAt: "2026-09-29T08:12:00Z",
    evidenceId: "other-site", evidenceKind: "inspection" }), /EXCEPTION_SCOPE_MISMATCH/);
});

test("C27 one cause groups repeated records and fourth urgent remains visible", () => {
  const records: ExceptionRecord[] = [
    { ...BASE, id: "s1", cause: "safety", causeKey: "safety-1" },
    { ...BASE, id: "s2", cause: "safety", causeKey: "safety-2" },
    { ...BASE, id: "s3", cause: "safety", causeKey: "safety-3" },
    { ...BASE, id: "s4", cause: "safety", causeKey: "safety-4" },
    { ...BASE, id: "r1", causeKey: "repeated" }, { ...BASE, id: "r2", causeKey: "repeated" },
    { ...BASE, id: "foreign", tenantId: "tenant-b" },
  ];
  const today = projectTodayExceptions(records, "tenant-a", "2026-09-29T09:00:00Z");
  assert.equal(today.cards.length, 4);
  assert.equal(today.urgentTotal, 4);
  assert.equal(today.openTotal, 6);
  assert.equal(today.moreAvailable, true);
  assert.deepEqual(groupExceptionCauses(records).find(item => item.causeKey === "repeated")?.ids, ["r1", "r2"]);
  const urgentDeferred = { ...BASE, id: "due", cause: "payment_due" as const,
    state: "deferred" as const, dueAt: "2026-09-29T10:00:00Z", nextReviewAt: "2026-09-29T09:30:00Z" };
  assert.equal(projectTodayExceptions([urgentDeferred], "tenant-a", "2026-09-29T09:00:00Z").cards.length, 1);
  assert.throws(() => applyExceptionEvent({ ...urgentDeferred, state: "open" }, {
    id: "late-deferral", exceptionId: "due", expectedVersion: 1, tenantId: "tenant-a",
    bundleId: "bundle-a", causeKey: BASE.causeKey, kind: "defer", recordedAt: "2026-09-29T09:00:00Z",
    nextReviewAt: "2026-09-30T09:00:00Z", reason: "later",
  }), /DEFER_EXCEEDS_DUE_AT/);
  assert.throws(() => projectTodayExceptions([{ ...BASE, state: "resolved",
    stateRecordedAt: "2026-09-29T09:05:00Z" }], "tenant-a", "2026-09-29T09:00:00Z"),
  /HISTORICAL_EXCEPTION_REPLAY_REQUIRED/);
});

test("C27 T69 work, money, and evidence close independently", () => {
  const base = { requiredWorkDone: true, inspectionEvidenceComplete: false,
    requiredEvidenceComplete: false, openCriticalExceptionCount: 0, confirmedCostsAllocated: true,
    approvedInvoicesApplied: true, receiptsAndPaymentsApplied: true, unresolvedMoneyCount: 1,
    settlementConfirmed: true, bankReconciled: false };
  const initial = projectClosure(base);
  assert.deepEqual([initial.workClosed, initial.moneyClosed, initial.evidenceComplete, initial.allClosed],
    [false, false, false, false]);
  const closed = projectClosure({ ...base, inspectionEvidenceComplete: true,
    requiredEvidenceComplete: true, unresolvedMoneyCount: 0 });
  assert.deepEqual([closed.workClosed, closed.moneyClosed, closed.evidenceComplete, closed.allClosed,
    closed.ledgerOnly], [true, true, true, true, true]);
});
