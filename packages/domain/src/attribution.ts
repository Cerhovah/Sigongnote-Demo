/** Candidate-only attribution. Evidence links never confirm a project or money. */

export type Clue = {
  source: "filename" | "header" | "body" | "address" | "sender" | "item_line";
  text: string;
  locator: string;
};

export type ProjectReference = {
  tenantId: string;
  id: string;
  displayName: string;
  aliases: { text: string; validFrom?: string; validUntil?: string }[];
  addressHint?: string;
};

export type BundleReference = {
  tenantId: string;
  id: string;
  projectId: string;
  label: string;
};

export type PartyReference = {
  tenantId: string;
  id: string;
  displayName: string;
  role: string;
  projectId?: string;
};

export type ItemTypeReference = {
  tenantId: string;
  id: string;
  typeCode: string;
  specification: string;
};

export type AttributionCandidate = {
  targetKind: "project" | "bundle" | "party" | "item_type";
  targetId: string;
  label: string;
  clues: { source: Clue["source"]; locator: string }[];
  reason: string;
};

export type AttributionInput = {
  tenantId: string;
  revisionId: string;
  documentScope: "project" | "common" | "product" | "unknown";
  observedAt: string | null;
  clues: Clue[];
  projects: ProjectReference[];
  bundles: BundleReference[];
  parties: PartyReference[];
  itemTypes: ItemTypeReference[];
};

export type AttributionResult = {
  revisionId: string;
  status: "candidate" | "conflict" | "unassigned";
  projectConfirmed: null;
  bundleConfirmed: null;
  candidates: AttributionCandidate[];
  conflicts: { code: string; targetIds: string[]; locators: string[] }[];
  issues: string[];
};

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
}

function parsedTime(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function activeAlias(alias: ProjectReference["aliases"][number], observedAt: string | null): boolean {
  if (!alias.validFrom && !alias.validUntil) return true;
  const observed = parsedTime(observedAt);
  if (observed === null) return false;
  const from = alias.validFrom ? parsedTime(alias.validFrom) : null;
  const until = alias.validUntil ? parsedTime(alias.validUntil) : null;
  if ((alias.validFrom && from === null) || (alias.validUntil && until === null)) return false;
  return (from === null || observed >= from) && (until === null || observed < until);
}

function clueMatches(clue: Clue, needle: string): boolean {
  const value = normalized(needle);
  return value.length >= 2 && normalized(clue.text).includes(value);
}

function candidate(kind: AttributionCandidate["targetKind"], id: string, label: string,
  clues: Clue[], reason: string): AttributionCandidate {
  return { targetKind: kind, targetId: id, label,
    clues: clues.map(clue => ({ source: clue.source, locator: clue.locator })), reason };
}

export function proposeAttribution(input: AttributionInput): AttributionResult {
  const result: AttributionResult = {
    revisionId: input.revisionId, status: "unassigned",
    projectConfirmed: null, bundleConfirmed: null,
    candidates: [], conflicts: [], issues: [],
  };
  if (!input.tenantId || !input.revisionId || input.clues.length > 100 ||
      input.clues.some(clue => !clue.locator || !clue.text.trim())) {
    throw new Error("INVALID_ATTRIBUTION_INPUT");
  }
  // Shared product/reference material may still have item or party candidates,
  // but names mentioned as examples must never force a site.
  const projects = input.documentScope === "common" || input.documentScope === "product"
    ? [] : input.projects.filter(project => project.tenantId === input.tenantId);
  const projectClues = new Map<string, Clue[]>();
  for (const project of projects) {
    if (parsedTime(input.observedAt) === null && project.aliases.some(alias =>
      (alias.validFrom || alias.validUntil) && input.clues.some(clue => clueMatches(clue, alias.text)))) {
      if (!result.issues.includes("alias_time_unverified")) result.issues.push("alias_time_unverified");
    }
    const names = [project.displayName, ...project.aliases.filter(alias =>
      activeAlias(alias, input.observedAt)).map(alias => alias.text)];
    const matched = input.clues.filter(clue =>
      (clue.source === "address" && project.addressHint && clueMatches(clue, project.addressHint)) ||
      (clue.source !== "address" && names.some(name => clueMatches(clue, name))));
    if (matched.length) {
      projectClues.set(project.id, matched);
      result.candidates.push(candidate("project", project.id, project.displayName, matched,
        "name_or_address_candidate"));
    }
  }
  const bySource = new Map<Clue["source"], Set<string>>();
  for (const [id, clues] of projectClues) for (const clue of clues) {
    const ids = bySource.get(clue.source) ?? new Set<string>();
    ids.add(id);
    bySource.set(clue.source, ids);
  }
  const distinct = new Set(projectClues.keys());
  if (distinct.size > 1) {
    result.conflicts.push({ code: "project_clues_disagree", targetIds: [...distinct].sort(),
      locators: [...projectClues.values()].flat().map(clue => clue.locator) });
  }
  for (const [source, ids] of bySource) if (ids.size > 1) {
    result.conflicts.push({ code: `ambiguous_${source}`, targetIds: [...ids].sort(),
      locators: input.clues.filter(clue => clue.source === source).map(clue => clue.locator) });
  }
  for (const bundle of input.bundles.filter(item => item.tenantId === input.tenantId &&
    projectClues.has(item.projectId))) {
    const matched = input.clues.filter(clue => clueMatches(clue, bundle.label));
    if (matched.length) result.candidates.push(candidate("bundle", bundle.id, bundle.label,
      matched, "work_label_candidate"));
  }
  const partyClues = new Map<string, Clue[]>();
  for (const party of input.parties.filter(item => item.tenantId === input.tenantId)) {
    const matched = input.clues.filter(clue => clue.source === "sender" &&
      clueMatches(clue, party.displayName));
    if (matched.length) {
      partyClues.set(party.id, matched);
      result.candidates.push(candidate("party", party.id,
        `${party.displayName} · ${party.role}`, matched, "name_only_unconfirmed"));
    }
  }
  for (const clue of input.clues.filter(item => item.source === "sender")) {
    const ids = [...partyClues].filter(([, clues]) => clues.includes(clue)).map(([id]) => id);
    if (ids.length > 1) result.conflicts.push({
      code: "ambiguous_party_name", targetIds: ids.sort(), locators: [clue.locator],
    });
  }
  for (const item of input.itemTypes.filter(item => item.tenantId === input.tenantId)) {
    const matched = input.clues.filter(clue => clue.source === "item_line" &&
      clueMatches(clue, item.typeCode) && clueMatches(clue, item.specification));
    if (matched.length) result.candidates.push(candidate("item_type", item.id,
      `${item.typeCode} ${item.specification}`, matched, "type_not_individual_object"));
  }
  result.candidates.sort((a, b) => a.targetKind.localeCompare(b.targetKind) ||
    a.label.localeCompare(b.label, "ko-KR") || a.targetId.localeCompare(b.targetId));
  result.status = result.conflicts.length ? "conflict" : result.candidates.length ? "candidate" : "unassigned";
  return result;
}
