export type ExceptionState = "open" | "awaiting_evidence" | "awaiting_decision" | "deferred" | "resolved" | "reopened";
export type ExceptionCause = "safety" | "today_blocked" | "payment_due" | "missing_evidence" | "amount_conflict" | "attribution_conflict" | "source_gap" | "other";
export type ExceptionRecord = {
  id: string; tenantId: string; bundleId: string | null; causeKey: string; cause: ExceptionCause;
  state: ExceptionState; version: number; createdAt: string; stateRecordedAt: string; dueAt: string | null;
  nextReviewAt: string | null; knownFact: string; unknown: string; impact: string;
  confirmWith: string | null; action: string; moneyImpactMinor: string | null;
  evidenceIds: string[]; resolutionEvidenceIds: string[]; appliedEventIds: string[];
  resolutionPredicate: { kind: "evidence_and_decision" | "evidence_only"; requiredEvidenceKind: string };
};
export type ExceptionEvent = { id: string; exceptionId: string; kind: "defer" | "dismiss_notification" | "evidence" | "decision" | "new_conflict";
  expectedVersion: number; tenantId: string; bundleId: string | null; causeKey: string;
  recordedAt: string; nextReviewAt?: string; reason?: string; evidenceId?: string; evidenceKind?: string;
  decisionId?: string };

function instant(value: string): number {
  const result = Date.parse(value);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(result)) throw new Error("INVALID_EXCEPTION_TIME");
  return result;
}

export function applyExceptionEvent(current: ExceptionRecord, event: ExceptionEvent): ExceptionRecord {
  if (event.exceptionId !== current.id) throw new Error("EXCEPTION_ID_MISMATCH");
  if (current.appliedEventIds.includes(event.id)) return current;
  if (event.expectedVersion !== current.version) throw new Error("STALE_EXCEPTION_VERSION");
  if (event.tenantId !== current.tenantId || event.bundleId !== current.bundleId ||
      event.causeKey !== current.causeKey) throw new Error("EXCEPTION_SCOPE_MISMATCH");
  const when = instant(event.recordedAt);
  if (when < instant(current.createdAt)) throw new Error("EVIDENCE_BEFORE_EXCEPTION");
  if (event.kind === "dismiss_notification") return current;
  const applied = { version: current.version + 1, stateRecordedAt: event.recordedAt,
    appliedEventIds: [...current.appliedEventIds, event.id] };
  if (event.kind === "new_conflict") return { ...current, ...applied, state: "reopened",
    resolutionEvidenceIds: [], nextReviewAt: null };
  if (current.state === "resolved") throw new Error("RESOLVED_EXCEPTION_REQUIRES_NEW_CONFLICT");
  if (event.kind === "defer") {
    if (!event.reason?.trim() || !event.nextReviewAt || instant(event.nextReviewAt) <= when) throw new Error("DEFER_REVIEW_REQUIRED");
    if (current.dueAt && instant(event.nextReviewAt) > instant(current.dueAt)) throw new Error("DEFER_EXCEEDS_DUE_AT");
    return { ...current, ...applied, state: "deferred", nextReviewAt: event.nextReviewAt };
  }
  if (event.kind === "evidence") {
    if (!event.evidenceId || !event.evidenceKind) throw new Error("EVIDENCE_REQUIRED");
    if (event.evidenceKind !== current.resolutionPredicate.requiredEvidenceKind) {
      return { ...current, ...applied, state: "awaiting_evidence",
        evidenceIds: [...new Set([...current.evidenceIds, event.evidenceId])] };
    }
    return { ...current, state: current.resolutionPredicate.kind === "evidence_only" ? "resolved" : "awaiting_decision",
      ...applied, nextReviewAt: null,
      evidenceIds: [...new Set([...current.evidenceIds, event.evidenceId])],
      resolutionEvidenceIds: [...new Set([...current.resolutionEvidenceIds, event.evidenceId])] };
  }
  if (!event.decisionId || !current.resolutionEvidenceIds.length) throw new Error("RESOLUTION_PREDICATE_UNSATISFIED");
  return { ...current, ...applied, state: "resolved", nextReviewAt: null };
}

export function groupExceptionCauses(records: ExceptionRecord[]): { causeKey: string; ids: string[]; urgent: boolean }[] {
  const groups = new Map<string, ExceptionRecord[]>();
  for (const record of records) {
    if (record.state === "resolved") continue;
    const key = `${record.tenantId}:${record.bundleId ?? "unassigned"}:${record.causeKey}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].flatMap(group => {
    const first = group[0];
    return first ? [{ causeKey: first.causeKey, ids: group.map(record => record.id),
      urgent: group.some(isUrgent) }] : [];
  });
}

export function isUrgent(item: ExceptionRecord): boolean {
  return item.cause === "safety" || item.cause === "today_blocked" || item.cause === "payment_due";
}

function rank(item: ExceptionRecord): number {
  return item.cause === "safety" ? 0 : item.cause === "today_blocked" ? 1 : item.cause === "payment_due" ? 2 : 3;
}

export function projectTodayExceptions(records: ExceptionRecord[], tenantId: string, knownAt: string,
  pageSize = 3): { cards: ExceptionRecord[]; openTotal: number; urgentTotal: number; moreAvailable: boolean } {
  const cutoff = instant(knownAt);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("INVALID_PAGE_SIZE");
  const scoped = records.filter(item => item.tenantId === tenantId && instant(item.createdAt) <= cutoff);
  if (scoped.some(item => instant(item.stateRecordedAt) > cutoff)) throw new Error("HISTORICAL_EXCEPTION_REPLAY_REQUIRED");
  const open = scoped.filter(item => item.state !== "resolved");
  open.sort((a, b) => rank(a) - rank(b) ||
    (a.dueAt ? instant(a.dueAt) : Infinity) - (b.dueAt ? instant(b.dueAt) : Infinity) ||
    instant(a.createdAt) - instant(b.createdAt) || a.id.localeCompare(b.id));
  const urgent = open.filter(isUrgent);
  const cards = open.slice(0, Math.max(pageSize, urgent.length));
  return { cards, openTotal: open.length, urgentTotal: urgent.length, moreAvailable: cards.length < open.length };
}

export function projectClosure(input: { requiredWorkDone: boolean; inspectionEvidenceComplete: boolean;
  requiredEvidenceComplete: boolean; openCriticalExceptionCount: number; confirmedCostsAllocated: boolean;
  approvedInvoicesApplied: boolean; receiptsAndPaymentsApplied: boolean; unresolvedMoneyCount: number;
  settlementConfirmed: boolean; bankReconciled: boolean }): {
  workClosed: boolean; moneyClosed: boolean; evidenceComplete: boolean; allClosed: boolean;
  ledgerOnly: boolean } {
  const evidenceComplete = input.requiredEvidenceComplete;
  const workClosed = input.requiredWorkDone && input.inspectionEvidenceComplete && input.openCriticalExceptionCount === 0;
  const moneyClosed = input.confirmedCostsAllocated && input.approvedInvoicesApplied &&
    input.receiptsAndPaymentsApplied && input.unresolvedMoneyCount === 0 && input.settlementConfirmed;
  return { workClosed, moneyClosed, evidenceComplete, allClosed: workClosed && moneyClosed && evidenceComplete,
    ledgerOnly: moneyClosed && !input.bankReconciled };
}
