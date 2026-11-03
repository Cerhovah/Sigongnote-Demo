import { createHash } from "node:crypto";
import { z } from "zod";

const unitSchema = z.object({ code: z.string().min(1), dimension: z.enum(["count", "area", "labor", "lump"]), label: z.string().min(1) }).strict();
const nodeSchema = z.object({ id: z.string().min(1), label: z.string().min(1), after: z.array(z.string()).default([]) }).strict();
const attributeSchema = z.object({ key: z.string().min(1), type: z.enum(["text", "decimal", "boolean"]), required: z.boolean() }).strict();

export type Rule =
  | { op: "all"; rules: Rule[] }
  | { op: "any"; rules: Rule[] }
  | { op: "equal"; field: string; value: string | boolean }
  | { op: "exists"; field: string }
  | { op: "decimalCompare"; field: string; cmp: "gt" | "gte" | "lt" | "lte" | "eq"; value: string; unitCode: string };

function parseRule(input: unknown, depth = 0): Rule {
  if (depth > 8 || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_PACK_RULE");
  const raw = input as Record<string, unknown>;
  if (raw.op === "all" || raw.op === "any") {
    if (Object.keys(raw).sort().join() !== "op,rules" || !Array.isArray(raw.rules) || raw.rules.length > 20) throw new Error("INVALID_PACK_RULE");
    return { op: raw.op, rules: raw.rules.map(rule => parseRule(rule, depth + 1)) };
  }
  if (raw.op === "equal") return z.object({ op: z.literal("equal"), field: z.string().min(1), value: z.union([z.string(), z.boolean()]) }).strict().parse(raw);
  if (raw.op === "exists") return z.object({ op: z.literal("exists"), field: z.string().min(1) }).strict().parse(raw);
  if (raw.op === "decimalCompare") return z.object({ op: z.literal("decimalCompare"), field: z.string().min(1), cmp: z.enum(["gt", "gte", "lt", "lte", "eq"]), value: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/), unitCode: z.string().min(1) }).strict().parse(raw);
  throw new Error("INVALID_PACK_RULE");
}

const packSchema = z.object({
  packId: z.string().regex(/^[a-z][a-z-]*$/), version: z.string().regex(/^\d+\.\d+\.\d+$/), schemaVersion: z.literal(1),
  labels: z.object({ ko: z.string().min(1) }).strict(), units: z.array(unitSchema).min(1),
  itemAttributes: z.array(attributeSchema), workflowNodes: z.array(nodeSchema).min(1),
  prerequisiteRules: z.array(z.object({ nodeId: z.string(), rule: z.unknown() }).strict()),
  exceptionRules: z.array(z.object({ code: z.string(), rule: z.unknown() }).strict()),
  costCategories: z.array(z.string()), quoteTemplate: z.object({ unitCodes: z.array(z.string()), requiredApprovalRevision: z.boolean() }).strict(),
  requiredEvidence: z.array(z.object({ nodeId: z.string(), kind: z.string() }).strict()),
  templateAdapters: z.array(z.string()),
}).strict();

export type TradePack = Omit<z.infer<typeof packSchema>, "prerequisiteRules" | "exceptionRules"> & {
  contentHash: string;
  prerequisiteRules: { nodeId: string; rule: Rule }[];
  exceptionRules: { code: string; rule: Rule }[];
};

function unique(values: string[]): boolean { return new Set(values).size === values.length; }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(",")}}`;
  return JSON.stringify(value);
}

function rules(pack: z.infer<typeof packSchema>): { prerequisiteRules: TradePack["prerequisiteRules"]; exceptionRules: TradePack["exceptionRules"] } {
  return { prerequisiteRules: pack.prerequisiteRules.map(item => ({ nodeId: item.nodeId, rule: parseRule(item.rule) })),
    exceptionRules: pack.exceptionRules.map(item => ({ code: item.code, rule: parseRule(item.rule) })) };
}

function ruleUnits(rule: Rule): string[] {
  return rule.op === "all" || rule.op === "any" ? rule.rules.flatMap(ruleUnits) :
    rule.op === "decimalCompare" ? [rule.unitCode] : [];
}

export function parseTradePack(input: unknown): TradePack {
  const pack = packSchema.parse(input);
  const ids = pack.workflowNodes.map(node => node.id);
  const units = pack.units.map(unit => unit.code);
  if (!unique(ids) || !unique(units) || !unique(pack.itemAttributes.map(item => item.key)) ||
      !unique(pack.exceptionRules.map(item => item.code)) || !unique(pack.prerequisiteRules.map(item => item.nodeId)) ||
      pack.quoteTemplate.unitCodes.some(unit => !units.includes(unit)) ||
      pack.prerequisiteRules.some(item => !ids.includes(item.nodeId)) ||
      pack.requiredEvidence.some(item => !ids.includes(item.nodeId))) throw new Error("INVALID_PACK_REFERENCE");
  const byId = new Map(pack.workflowNodes.map(node => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("CYCLIC_PACK_WORKFLOW");
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new Error("INVALID_PACK_REFERENCE");
    visiting.add(id);
    for (const prior of node.after) visit(prior);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  const parsedRules = rules(pack);
  if ([...parsedRules.prerequisiteRules, ...parsedRules.exceptionRules]
    .some(item => ruleUnits(item.rule).some(unit => !units.includes(unit)))) throw new Error("INVALID_PACK_UNIT");
  return { ...pack, ...parsedRules, contentHash: createHash("sha256").update(canonical(pack)).digest("hex") };
}

function decimal(value: string): bigint | null {
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (!whole) return null;
  const negative = whole.startsWith("-");
  const absolute = BigInt(negative ? whole.slice(1) : whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -absolute : absolute;
}

export type RuleResult = "true" | "false" | "unknown";
export function evaluatePackRule(rule: Rule, facts: Record<string, unknown>): RuleResult {
  if (rule.op === "all") {
    const results = rule.rules.map(child => evaluatePackRule(child, facts));
    return results.includes("false") ? "false" : results.includes("unknown") ? "unknown" : "true";
  }
  if (rule.op === "any") {
    const results = rule.rules.map(child => evaluatePackRule(child, facts));
    return results.includes("true") ? "true" : results.includes("unknown") ? "unknown" : "false";
  }
  const fact = Object.hasOwn(facts, rule.field) ? facts[rule.field] : undefined;
  if (fact === null || fact === undefined) return "unknown";
  if (rule.op === "exists") return fact === "" ? "false" : "true";
  if (rule.op === "equal") return fact === rule.value ? "true" : "false";
  const amount = fact && typeof fact === "object" ? fact as Record<string, unknown> : null;
  if (amount?.unitCode !== rule.unitCode || typeof amount.value !== "string") return "unknown";
  const left = decimal(amount.value);
  const right = decimal(rule.value);
  if (left === null || right === null) return "unknown";
  const truth = rule.cmp === "gt" ? left > right : rule.cmp === "gte" ? left >= right :
    rule.cmp === "lt" ? left < right : rule.cmp === "lte" ? left <= right : left === right;
  return truth ? "true" : "false";
}

export function evaluatePackExceptions(pack: TradePack, facts: Record<string, unknown>): { code: string; status: "triggered" | "needs_check" }[] {
  return pack.exceptionRules.flatMap(item => {
    const result = evaluatePackRule(item.rule, facts);
    return result === "false" ? [] : [{ code: item.code, status: result === "true" ? "triggered" as const : "needs_check" as const }];
  });
}

export type PackBoundWork = { bundleId: string; packId: string; packVersion: string; packHash: string; facts: Record<string, unknown>; completedNodeIds: string[] };
export function projectPackWork(work: PackBoundWork, packs: TradePack[]): { readyNodeIds: string[]; blockedNodeIds: string[]; packVersion: string } {
  const pack = packs.find(item => item.packId === work.packId && item.version === work.packVersion);
  if (!pack) throw new Error("PINNED_PACK_VERSION_MISSING");
  if (work.packHash !== pack.contentHash) throw new Error("PINNED_PACK_HASH_MISMATCH");
  const done = new Set(work.completedNodeIds);
  if ([...done].some(id => !pack.workflowNodes.some(node => node.id === id))) throw new Error("INVALID_COMPLETED_NODE");
  const readyNodeIds: string[] = [];
  const blockedNodeIds: string[] = [];
  for (const node of pack.workflowNodes) {
    if (done.has(node.id)) continue;
    const rule = pack.prerequisiteRules.find(item => item.nodeId === node.id)?.rule;
    const ready = node.after.every(id => done.has(id)) && (!rule || evaluatePackRule(rule, work.facts) === "true");
    (ready ? readyNodeIds : blockedNodeIds).push(node.id);
  }
  return { readyNodeIds, blockedNodeIds, packVersion: pack.version };
}

export function previewPackMigration(work: PackBoundWork, current: TradePack, next: TradePack): { decisionRequired: true; removedNodes: string[]; addedNodes: string[]; projected: ReturnType<typeof projectPackWork> } {
  if (work.packId !== next.packId || work.packId !== current.packId || work.packVersion !== current.version) throw new Error("PACK_ID_MISMATCH");
  const currentIds = new Set(current.workflowNodes.map(node => node.id));
  const nextIds = new Set(next.workflowNodes.map(node => node.id));
  const projected = projectPackWork({ ...work, packVersion: next.version, packHash: next.contentHash,
    completedNodeIds: work.completedNodeIds.filter(id => nextIds.has(id)) }, [next]);
  return { decisionRequired: true, removedNodes: current.workflowNodes.filter(node => !nextIds.has(node.id)).map(node => node.id),
    addedNodes: next.workflowNodes.filter(node => !currentIds.has(node.id)).map(node => node.id), projected };
}
