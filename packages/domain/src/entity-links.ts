/** Evidence-backed identity resolution only. A link never approves a business effect. */
export const ENTITY_LINK_RESOLVER_VERSION = "entity-links-v1";

export type EntityKind = "project" | "contract" | "bundle" | "party" | "item_type" | "item_instance";
export type EntityLinkScope = {
  projectId?: string;
  contractId?: string;
  partyId?: string;
  role?: string;
};
export type EntityReference = EntityLinkScope & {
  tenantId: string;
  id: string;
  targetKind: EntityKind;
  displayName: string;
  itemTypeId?: string;
};
export type EntityLinkEvidence = {
  id: string;
  tenantId: string;
  revisionId: string;
  locator: string;
  text: string;
  /** The caller verifies source consent, access and current revision before setting true. */
  active: boolean;
};
export type EntityAlias = {
  tenantId: string;
  id: string;
  targetKind: EntityKind;
  targetId: string;
  text: string;
  scope: "company" | "project" | "contract" | "party";
  scopeId: string;
  role?: string;
  validFrom?: string;
  validUntil?: string;
  status: "active" | "conflict" | "retired";
  evidenceIds: string[];
};
export type EntityMention = {
  id: string;
  targetKind: EntityKind;
  text?: string;
  existingId?: string;
  evidenceIds: string[];
};
export type EntityLinkInput = {
  tenantId: string;
  revisionId: string;
  documentScope: "project" | "common" | "product" | "unknown";
  effectiveAt: string | null;
  context: EntityLinkScope;
  mentions: EntityMention[];
  references: EntityReference[];
  aliases: EntityAlias[];
  evidence: EntityLinkEvidence[];
};
export type EntityLinkCandidate = {
  targetKind: EntityKind;
  targetId: string;
  label: string;
  matchedBy: ("existing_id" | "name" | "alias")[];
  aliasIds: string[];
  evidenceIds: string[];
  reasons: string[];
};
export type ResolvedEntityLink = {
  mentionId: string;
  targetKind: EntityKind;
  status: "linked" | "candidate_only" | "unassigned" | "blocked_scope";
  targetId: string | null;
  candidates: EntityLinkCandidate[];
  evidenceIds: string[];
  reasons: string[];
};
export type EntityLinkResult = {
  version: typeof ENTITY_LINK_RESOLVER_VERSION;
  revisionId: string;
  links: ResolvedEntityLink[];
};

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
}
function utcTime(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  // Date.parse silently rolls an impossible calendar day into the next month.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function containsMention(text: string, mention: string): boolean {
  const source = normalized(text);
  const needle = normalized(mention);
  if (!needle) return false;
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    const before = source.slice(Math.max(0, at - 2), at);
    const after = source.slice(at + needle.length, at + needle.length + 2);
    if (!/[\p{L}\p{N}_]$/u.test(before) && !/^[\p{L}\p{N}_]/u.test(after)) return true;
  }
  return false;
}

/** Null means the target is incompatible; reasons mean compatible but unverified. */
function targetScope(reference: EntityReference, context: EntityLinkScope): string[] | null {
  const reasons: string[] = [];
  for (const field of ["projectId", "contractId", "partyId", "role"] as const) {
    const expected = field === "projectId" && reference.targetKind === "project" ? reference.id :
      field === "contractId" && reference.targetKind === "contract" ? reference.id : reference[field];
    const actual = context[field];
    if (!expected) continue;
    if (actual && normalized(actual) !== normalized(expected)) return null;
    // The entity being resolved supplies its own ID, but not its parent scope.
    if (!actual && !((field === "projectId" && reference.targetKind === "project") ||
      (field === "contractId" && reference.targetKind === "contract"))) reasons.push(`missing_${field}`);
  }
  return reasons;
}

function aliasScope(alias: EntityAlias, input: EntityLinkInput): string[] | null {
  if (alias.status === "retired") return null;
  const expected = alias.scope === "company" ? input.tenantId :
    input.context[`${alias.scope}Id` as "projectId" | "contractId" | "partyId"];
  if (!alias.scopeId || (expected && expected !== alias.scopeId)) return null;
  const reasons = expected ? [] : ["alias_scope_unverified"];
  if (alias.role && input.context.role && normalized(alias.role) !== normalized(input.context.role)) return null;
  if (alias.role && !input.context.role) reasons.push("alias_role_unverified");
  if (alias.status === "conflict") reasons.push("alias_conflict");
  const from = alias.validFrom ? utcTime(alias.validFrom) : null;
  const until = alias.validUntil ? utcTime(alias.validUntil) : null;
  if ((alias.validFrom && from === null) || (alias.validUntil && until === null) ||
    (from !== null && until !== null && from >= until)) return [ ...reasons, "alias_period_invalid" ];
  if (from !== null || until !== null) {
    const at = utcTime(input.effectiveAt);
    if (at === null) reasons.push("alias_time_unverified");
    else if ((from !== null && at < from) || (until !== null && at >= until)) return null;
  }
  return reasons;
}

export function resolveEntityLinks(input: EntityLinkInput): EntityLinkResult {
  if (!input.tenantId || !input.revisionId || input.mentions.length > 1000 ||
    input.references.length > 20000 || input.aliases.length > 20000 || input.evidence.length > 40000 ||
    input.mentions.some(mention => !mention.id || (!mention.existingId && !mention.text?.trim())) ||
    new Set(input.mentions.map(mention => mention.id)).size !== input.mentions.length) {
    throw new Error("INVALID_ENTITY_LINK_INPUT");
  }
  const evidence = new Map<string, EntityLinkEvidence>();
  const duplicateEvidenceIds = new Set<string>();
  for (const item of input.evidence.filter(item => item.tenantId === input.tenantId)) {
    if (evidence.has(item.id)) duplicateEvidenceIds.add(item.id);
    evidence.set(item.id, item);
  }
  const evidenceValid = (ids: string[], current: boolean): boolean => ids.length > 0 && ids.every(id => {
    const item = evidence.get(id);
    return !!item && !duplicateEvidenceIds.has(id) && item.active && !!item.revisionId &&
      !!item.locator.trim() && (!current || item.revisionId === input.revisionId);
  });
  const references = input.references.filter(reference => reference.tenantId === input.tenantId);
  const contextInvalid = ([ ["projectId", "project"], ["contractId", "contract"], ["partyId", "party"] ] as const)
    .some(([field, kind]) => {
      const id = input.context[field];
      if (!id) return false;
      const matches = references.filter(reference => reference.targetKind === kind && reference.id === id);
      return matches.length !== 1 || targetScope(matches[0]!, input.context) === null;
    });
  const aliases = input.aliases.filter(alias => alias.tenantId === input.tenantId &&
    evidenceValid(alias.evidenceIds, false) && alias.evidenceIds.some(id => containsMention(evidence.get(id)!.text, alias.text)));
  const aliasesByMention = new Map<string, EntityAlias[]>();
  for (const alias of aliases) {
    const key = `${alias.targetKind}\0${normalized(alias.text)}`;
    const group = aliasesByMention.get(key) ?? [];
    group.push(alias);
    aliasesByMention.set(key, group);
  }

  const links = input.mentions.map((mention): ResolvedEntityLink => {
    const result: ResolvedEntityLink = {
      mentionId: mention.id, targetKind: mention.targetKind, status: "unassigned", targetId: null,
      candidates: [], evidenceIds: [], reasons: [],
    };
    if (contextInvalid || !evidenceValid(mention.evidenceIds, true)) {
      result.status = "blocked_scope";
      result.reasons = [contextInvalid ? "invalid_context" : "evidence_unavailable"];
      return result;
    }
    if (mention.text && !mention.evidenceIds.some(id => containsMention(evidence.get(id)!.text, mention.text!))) {
      result.status = "blocked_scope";
      result.reasons = ["mention_not_in_evidence"];
      return result;
    }
    result.evidenceIds = unique(mention.evidenceIds);
    if ((input.documentScope === "common" || input.documentScope === "product") &&
      ["project", "contract", "bundle", "item_instance"].includes(mention.targetKind)) {
      result.reasons = ["company_common_material"];
      return result;
    }
    const candidates = new Map<string, EntityLinkCandidate>();
    const matchingAliases = new Map<string, { alias: EntityAlias; reasons: string[] }[]>();
    if (!mention.existingId) for (const alias of aliasesByMention.get(`${mention.targetKind}\0${normalized(mention.text ?? "")}`) ?? []) {
      const reasons = aliasScope(alias, input);
      if (reasons === null) continue;
      const matches = matchingAliases.get(alias.targetId) ?? [];
      matches.push({ alias, reasons });
      matchingAliases.set(alias.targetId, matches);
    }
    for (const reference of references.filter(item => item.targetKind === mention.targetKind)) {
      const scopeReasons = targetScope(reference, input.context);
      if (scopeReasons === null) continue;
      const existingId = mention.existingId && reference.id === mention.existingId;
      if (mention.existingId && !existingId) continue;
      const matchesName = !mention.existingId && !!mention.text?.trim() &&
        normalized(mention.text) === normalized(reference.displayName);
      const matchedAliases = matchingAliases.get(reference.id) ?? [];
      if (!existingId && !matchesName && matchedAliases.length === 0) continue;
      const candidate: EntityLinkCandidate = {
        targetKind: reference.targetKind, targetId: reference.id, label: reference.displayName,
        matchedBy: existingId ? ["existing_id"] : [ ...(matchesName ? ["name" as const] : []),
          ...(matchedAliases.length ? ["alias" as const] : []) ],
        aliasIds: unique(matchedAliases.map(match => match.alias.id)),
        evidenceIds: unique([...mention.evidenceIds, ...matchedAliases.flatMap(match => match.alias.evidenceIds)]),
        reasons: unique([...scopeReasons, ...matchedAliases.flatMap(match => match.reasons ?? [])]),
      };
      // Duplicate catalog rows must not silently hide incompatible scope information.
      const prior = candidates.get(reference.id);
      if (prior) candidate.reasons = unique([...prior.reasons, ...candidate.reasons, "duplicate_reference"]);
      candidates.set(reference.id, candidate);
    }
    result.candidates = [...candidates.values()].sort((a, b) => a.targetId.localeCompare(b.targetId));
    if (result.candidates.length === 0) {
      if (mention.existingId) { result.status = "blocked_scope"; result.reasons = ["existing_id_unavailable"]; }
      else result.reasons = ["no_matching_entity"];
      return result;
    }
    result.reasons = unique(result.candidates.flatMap(candidate => candidate.reasons));
    if (result.candidates.length > 1) result.reasons = unique([...result.reasons, "ambiguous_entity"]);
    if (result.candidates.length === 1 && result.reasons.length === 0) {
      result.status = "linked";
      result.targetId = result.candidates[0]!.targetId;
    } else result.status = "candidate_only";
    return result;
  });
  return { version: ENTITY_LINK_RESOLVER_VERSION, revisionId: input.revisionId, links };
}
