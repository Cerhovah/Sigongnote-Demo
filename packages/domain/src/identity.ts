/** Candidate-only representation and economic-transaction identity analysis. */

export type FormObservation = {
  tenantId: string;
  revisionId: string;
  formId: string;
  recordedAt: string;
  blobSha256: string;
  representationFingerprint: string;
  predecessorRevisionId?: string;
  quantity?: { value: string; unitCode: string; semantic: "scope" | "ordered" | "moved" | "accepted" };
  transaction?: {
    recordedAt: string;
    orderRef?: string;
    transportRef?: string;
    partyRef?: string;
    dateRaw?: string;
    specification?: string;
    amountMinor?: string | null;
  };
};

export type IdentityRelation = {
  leftFormId: string;
  rightFormId: string;
  kind: "same_blob" | "same_representation_candidate" | "same_transaction_candidate" |
    "distinct_transaction" | "revision_successor" | "unresolved";
  reason: string;
};

export type LogicalFormCandidate = {
  fingerprint: string;
  formIds: string[];
  candidateQuantity: NonNullable<FormObservation["quantity"]> | null;
  actualReceived: null;
  confirmedTransactionId: null;
  reviewRequired: true;
};

function key(value: string | undefined): string | null {
  const text = value?.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
  return text || null;
}

function instant(value: string): number {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("INVALID_IDENTITY_INPUT");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("INVALID_IDENTITY_INPUT");
  return parsed;
}

function relation(a: FormObservation, b: FormObservation): IdentityRelation {
  const base = { leftFormId: a.formId, rightFormId: b.formId };
  if (a.predecessorRevisionId === b.revisionId || b.predecessorRevisionId === a.revisionId) {
    return { ...base, kind: "revision_successor", reason: "explicit_predecessor" };
  }
  const left = a.transaction;
  const right = b.transaction;
  const leftTransport = key(left?.transportRef);
  const rightTransport = key(right?.transportRef);
  if (leftTransport && rightTransport && leftTransport !== rightTransport) {
    return { ...base, kind: "distinct_transaction", reason: "different_transport_reference" };
  }
  if (a.blobSha256 === b.blobSha256 &&
      a.representationFingerprint === b.representationFingerprint) {
    return { ...base, kind: "same_blob", reason: "byte_identical_representation" };
  }
  if (a.representationFingerprint === b.representationFingerprint) {
    return { ...base, kind: "same_representation_candidate", reason: "matching_logical_form" };
  }
  if (leftTransport && leftTransport === rightTransport &&
      key(left?.partyRef) && key(left?.partyRef) === key(right?.partyRef) &&
      key(left?.dateRaw) && key(left?.dateRaw) === key(right?.dateRaw) &&
      key(left?.specification) && key(left?.specification) === key(right?.specification)) {
    return { ...base, kind: "same_transaction_candidate", reason: "matching_transport_and_context" };
  }
  // Amount alone, or a shared order that may have multiple deliveries, is not identity.
  return { ...base, kind: "unresolved", reason: "insufficient_economic_identity" };
}

export function analyzeIdentity(tenantId: string, asOf: string, observations: FormObservation[]): {
  visibleFormIds: string[];
  excludedLaterFormIds: string[];
  logicalForms: LogicalFormCandidate[];
  relations: IdentityRelation[];
} {
  const cutoff = instant(asOf);
  if (!tenantId || observations.length > 500) {
    throw new Error("INVALID_IDENTITY_INPUT");
  }
  const visible: FormObservation[] = [];
  const excluded: string[] = [];
  for (const item of observations) {
    if (item.tenantId !== tenantId) continue;
    const time = instant(item.recordedAt);
    if (!item.formId ||
        !/^[0-9a-f]{64}$/.test(item.blobSha256) ||
        !/^[0-9a-f]{64}$/.test(item.representationFingerprint)) {
      throw new Error("INVALID_IDENTITY_INPUT");
    }
    if (time > cutoff) excluded.push(item.formId);
    else if (item.transaction && instant(item.transaction.recordedAt) <= cutoff) visible.push(item);
    else {
      const { transaction: _laterReference, ...historicalItem } = item;
      visible.push(historicalItem);
    }
  }
  visible.sort((a, b) => instant(a.recordedAt) - instant(b.recordedAt) || a.formId.localeCompare(b.formId));
  const groups = new Map<string, FormObservation[]>();
  for (const item of visible) {
    const transactionContext = ["orderRef", "transportRef", "partyRef", "dateRaw", "specification"]
      .map(field => key(item.transaction?.[field as keyof NonNullable<FormObservation["transaction"]>] as string | undefined) ?? "unspecified");
    const partition = JSON.stringify([item.representationFingerprint, ...transactionContext]);
    groups.set(partition, [...(groups.get(partition) ?? []), item]);
  }
  const logicalForms: LogicalFormCandidate[] = [];
  for (const forms of groups.values()) {
    const fingerprint = forms[0]?.representationFingerprint;
    if (!fingerprint) continue;
    const quantities = forms.map(item => item.quantity);
    const quantity = quantities[0];
    const matching = quantity && quantities.every(item => item &&
      item.value === quantity.value && item.unitCode === quantity.unitCode &&
      item.semantic === quantity.semantic);
    logicalForms.push({ fingerprint, formIds: forms.map(item => item.formId),
      candidateQuantity: matching && quantity ? quantity : null,
      actualReceived: null, confirmedTransactionId: null, reviewRequired: true });
  }
  const relations: IdentityRelation[] = [];
  for (let left = 0; left < visible.length; left++) {
    for (let right = left + 1; right < visible.length; right++) {
      const a = visible[left];
      const b = visible[right];
      if (a && b) relations.push(relation(a, b));
    }
  }
  return { visibleFormIds: visible.map(item => item.formId),
    excludedLaterFormIds: excluded, logicalForms, relations };
}
