import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptLegacyClaimsToSemanticCandidates, SEMANTIC_CANDIDATE_SCHEMA_VERSION,
  validateSemanticCandidates, validateSemanticBatchPartial, semanticRejectionCode, type SemanticCandidate, type SemanticValidationContext }
  from "../packages/domain/src/semantic-candidates.ts";
import type { ModelResponse } from "../packages/domain/src/claims.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const REVISION = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-000000000003";
function context(text: string): SemanticValidationContext {
  return { tenantId: TENANT, revisionId: REVISION, indexJobId: JOB,
    observedAt: "2026-10-03T03:00:00Z", modelVersion: "internal-fixture", promptVersion: "candidate-v2",
    chunks: [{ ordinal: 1001, contentHash: "a".repeat(64), locator: "sheet:0/cell:A1002", text, active: true }] };
}
function candidate(quote: string, eventKind: SemanticCandidate["eventKind"] = "receipt",
  value: string | null = "28"): SemanticCandidate {
  return { key: "receipt_1", eventKind, actor: null, subject: null, predicate: "material_quantity", object: null,
    quantity: value === null ? null : { value, unitCode: "ea" }, amount: null, effectiveAt: null,
    assertion: { polarity: "positive", modality: "actual", speech: "direct", speaker: null },
    evidence: [{ indexJobId: JOB, ordinal: 1001, contentHash: "a".repeat(64), locator: "sheet:0/cell:A1002", quote }],
    uncertaintyReasons: [] };
}
function batch(candidates: SemanticCandidate[]) {
  return { schemaVersion: SEMANTIC_CANDIDATE_SCHEMA_VERSION, modelVersion: "internal-fixture", promptVersion: "candidate-v2", candidates };
}
function legacy(claims: ModelResponse["claims"]): ModelResponse {
  return { modelRunId: "00000000-0000-4000-8000-000000000004", claims,
    candidateLinks: [], uncertainties: [], evidenceLocators: ["section:1001"] };
}

test('observed table quantities require real headers, same-row item and unit; never imply approval',()=>{
 const cells=[['A1','품명'],['B1','단위'],['C1','수량'],['D1','금액'],['E1','단위: 원'],['A2','석고보드'],['B2','EA'],['C2','28'],['D2','56000'],['A3','다른 품목'],['B3','EA'],['C3','30'],['D3','60000']];
 const ctx=context('');ctx.chunks=cells.map(([address,text],ordinal)=>({ordinal,locator:`sheet:0/cell:${address}`,text:text!,contentHash:'a'.repeat(64),active:true,contextOnly:ordinal<5}));
 const refs=(ordinals:number[])=>ordinals.map(ordinal=>{const c=ctx.chunks[ordinal]!;return {indexJobId:JOB,ordinal,locator:c.locator,contentHash:c.contentHash,quote:c.text};});
 const c:SemanticCandidate={...candidate('', 'observation'),subject:{kind:'item_type',mention:'석고보드',role:null},amount:{minor:'56000',knowledge:'known',currency:'KRW'},evidence:refs([5,6,7,8])};
 assert.equal(validateSemanticCandidates(batch([c]),ctx).candidates[0]!.quantity!.value,'28');
 const priceContext={...ctx,chunks:ctx.chunks.map(x=>x.ordinal===3?{...x,text:'단가'}:x)};
 assert.ok(validateSemanticCandidates(batch([c]),priceContext).candidates[0]!.uncertaintyReasons.includes('table_unit_price'));
 assert.ok(!validateSemanticCandidates(batch([c]),ctx).candidates[0]!.uncertaintyReasons.includes('table_unit_price'));
 assert.throws(()=>validateSemanticCandidates(batch([c]),{...ctx,chunks:ctx.chunks.filter(x=>x.ordinal!==2)}),/SEMANTIC_QUANTITY_UNSUPPORTED/);
 assert.throws(()=>validateSemanticCandidates(batch([{...c,quantity:{value:'30',unitCode:'ea'},evidence:refs([5,10,11,12])}]),ctx),/SEMANTIC_QUANTITY_UNSUPPORTED/);
 assert.throws(()=>validateSemanticCandidates(batch([{...c,amount:{minor:'60000',knowledge:'known',currency:'KRW'},evidence:refs([5,6,7,12])}]),ctx),/SEMANTIC_QUANTITY_UNSUPPORTED|SEMANTIC_AMOUNT_UNSUPPORTED/);
 assert.throws(()=>validateSemanticCandidates(batch([c]),{...ctx,chunks:ctx.chunks.filter(x=>x.ordinal!==4)}),/SEMANTIC_QUANTITY_UNSUPPORTED|SEMANTIC_AMOUNT_UNSUPPORTED/);
 assert.throws(()=>validateSemanticCandidates(batch([{...c,eventKind:'acceptance'}]),ctx),/SEMANTIC_EVENT_UNSUPPORTED/);
 assert.throws(()=>validateSemanticCandidates(batch([{...c,subject:null,quantity:null,amount:null,evidence:refs([0])}]),ctx),/SEMANTIC_CONTEXT_ONLY/);
 ctx.chunks.push({ordinal:13,locator:'sheet:0/cell:E2',text:'인수하지 않았음',contentHash:'b'.repeat(64),active:true});
 assert.equal(validateSemanticCandidates(batch([c]),ctx).candidates[0]!.assertionStatus,'unasserted');
});

test("N06 30 requested/proposed/dispatched remains distinct from 28 actually received", () => {
  const lines = ["30개 요청", "30개 제안", "30개 출고", "28개 인수"];
  const candidates = lines.map((quote, index) => ({ ...candidate(quote,
    (["request", "proposal", "dispatch", "receipt"] as const)[index]!, index === 3 ? "28" : "30"), key: `quantity_${index}` }));
  const validated = validateSemanticCandidates(batch(candidates), context(lines.join("\n")));
  assert.deepEqual(validated.candidates.map(item => [item.eventKind, item.quantity!.value]),
    [["request", "30"], ["proposal", "30"], ["dispatch", "30"], ["receipt", "28"]]);
  assert.ok(validated.candidates.every(item => item.status === "candidate_only"));
  assert.ok(validated.candidates.every(item => !("bundleId" in item) && !("transactionId" in item)));
  assert.throws(() => validateSemanticCandidates(batch([candidate(lines.join("\n"), "receipt", "30")]), context(lines.join("\n"))), /SEMANTIC_QUANTITY_UNSUPPORTED/);
  assert.throws(() => validateSemanticCandidates(batch([candidate("30개 출고", "receipt", "30")]), context("30개 출고")), /SEMANTIC_EVENT_UNSUPPORTED/);
});

test("N06 source negation, condition, plan and quoted speech override positive model flags", () => {
  const samples = [
    ["28개 인수하지 않았습니다", "source_negation"],
    ["28개 인수하면 정산", "source_condition"],
    ["28개 인수 예정", "source_plan"],
    ["김 가명은 ‘28개 인수했다고’ 전했다", "reported_speech"],
    ['김 가명은 "28개 인수"라고 말했다', "reported_speech"],
  ];
  for (const [quote, reason] of samples) {
    const result = validateSemanticCandidates(batch([candidate(quote!)]), context(quote!)).candidates[0]!;
    assert.equal(result.assertionStatus, "unasserted", quote);
    assert.ok(result.uncertaintyReasons.includes(reason!), quote);
    assert.equal(result.quantity!.value, "28");
  }
});

test("N06 actor and quotation speaker remain evidence-backed mentions with no canonical IDs", () => {
  const text = '김 가명은 "28개 인수"라고 말했다';
  const item = candidate(text);
  item.actor = { kind: "party", mention: "김 가명", role: "supplier" };
  item.assertion.speaker = { kind: "party", mention: "김 가명", role: null };
  const result = validateSemanticCandidates(batch([item]), context(text)).candidates[0]!;
  assert.equal(result.assertionStatus, "unasserted");
  assert.equal(result.assertion.speaker?.mention, "김 가명");
  assert.ok(!result.uncertaintyReasons.includes("quoted_speaker_unknown"));
  assert.throws(() => validateSemanticCandidates(batch([{ ...item, actor: { ...item.actor!, existingId: TENANT } } as SemanticCandidate]), context(text)));
  item.actor.mention = "다른 사람";
  assert.throws(() => validateSemanticCandidates(batch([item]), context(text)), /SEMANTIC_MENTION_UNSUPPORTED/);
});

test("N06 shortening a quote cannot hide following negation, conditions or reported speech", () => {
  for (const text of ["28개 인수하지 않았습니다", "28개 인수하면 정산", '김 가명은 "28개 인수"라고 말했다',
    "28개 인수\n다음 기록은 28개 인수하지 않았음"]) {
    const result = validateSemanticCandidates(batch([candidate("28개 인수")]), context(text)).candidates[0]!;
    assert.equal(result.assertionStatus, "unasserted", text);
  }
});

test("N06 forged job, ordinal, hash, locator, quote and withdrawn chunks are rejected", () => {
  const quote = "28개 인수";
  for (const change of ["job", "ordinal", "hash", "locator", "quote", "withdrawn"] as const) {
    const item = candidate(quote), source = context(quote);
    if (change === "job") item.evidence[0]!.indexJobId = TENANT;
    if (change === "ordinal") item.evidence[0]!.ordinal = 1002;
    if (change === "hash") item.evidence[0]!.contentHash = "b".repeat(64);
    if (change === "locator") item.evidence[0]!.locator = "page:3";
    if (change === "quote") item.evidence[0]!.quote = "30개 인수";
    if (change === "withdrawn") source.chunks[0]!.active = false;
    assert.throws(() => validateSemanticCandidates(batch([item]), source), /SEMANTIC_EVIDENCE_REJECTED/, change);
  }
});

test("N06 exact decimal values and units survive without number rounding or unit substitution", () => {
  const text = "9007199254740993.000001 m2 검수";
  const item = candidate(text, "inspection", "9007199254740993.000001");
  item.quantity!.unitCode = "m2";
  assert.equal(validateSemanticCandidates(batch([item]), context(text)).candidates[0]!.quantity!.value, "9007199254740993.000001");
  item.quantity!.unitCode = "m";
  assert.throws(() => validateSemanticCandidates(batch([item]), context(text)), /SEMANTIC_QUANTITY_UNSUPPORTED/);
  item.quantity = { value: "9007199254740992.000001", unitCode: "m2" };
  assert.throws(() => validateSemanticCandidates(batch([item]), context(text)), /SEMANTIC_QUANTITY_UNSUPPORTED/);
});

test("N06 unknown money stays null and quoted Korean amount multipliers are exact", () => {
  const unknown = candidate("금액 미확정", "observation", null);
  unknown.amount = { minor: null, currency: "KRW", knowledge: "unknown" };
  assert.equal(validateSemanticCandidates(batch([unknown]), context("금액 미확정")).candidates[0]!.amount!.minor, null);
  unknown.amount.minor = "0";
  assert.throws(() => validateSemanticCandidates(batch([unknown]), context("금액 미확정")));
  const known = candidate("100만 원 요청", "request", null);
  known.amount = { minor: "1000000", currency: "KRW", knowledge: "known" };
  assert.equal(validateSemanticCandidates(batch([known]), context("100만 원 요청")).candidates[0]!.amount!.minor, "1000000");
  known.amount.minor = "1000001";
  assert.throws(() => validateSemanticCandidates(batch([known]), context("100만 원 요청")), /SEMANTIC_AMOUNT_UNSUPPORTED/);
  const unrelated = candidate("100만 원 요청\n28개 인수");
  unrelated.amount = { minor: "1000000", currency: "KRW", knowledge: "known" };
  assert.throws(() => validateSemanticCandidates(batch([unrelated]), context(unrelated.evidence[0]!.quote)), /SEMANTIC_AMOUNT_UNSUPPORTED/);
});

test("N06 effective time and server observed time remain separate; future facts stay unasserted", () => {
  const item = candidate("28개 인수");
  item.effectiveAt = "2026-10-02T00:00:00Z";
  const result = validateSemanticCandidates(batch([item]), context("28개 인수")).candidates[0]!;
  assert.equal(result.effectiveAt, "2026-10-02T00:00:00Z");
  assert.equal(result.observedAt, "2026-10-03T03:00:00Z");
  item.effectiveAt = "2026-10-04T00:00:00Z";
  assert.equal(validateSemanticCandidates(batch([item]), context("28개 인수")).candidates[0]!.assertionStatus, "unasserted");
  item.effectiveAt = "2026-02-30T00:00:00Z";
  assert.throws(() => validateSemanticCandidates(batch([item]), context("28개 인수")));
});

test("N06 corrections and cancellations are distinct candidates and do not rewrite earlier quantities", () => {
  const text = "인수 수량 28개로 정정\n30개 주문 취소";
  const correction = candidate("인수 수량 28개로 정정", "correction");
  const cancellation = { ...candidate("30개 주문 취소", "cancellation", "30"), key: "cancel_1" };
  const results = validateSemanticCandidates(batch([correction, cancellation]), context(text)).candidates;
  assert.deepEqual(results.map(item => item.eventKind), ["correction", "cancellation"]);
  assert.deepEqual(results.map(item => item.quantity!.value), ["28", "30"]);
  assert.ok(results.every(item => item.status === "candidate_only"));
  const ambiguous = candidate("인수 수량 30개에서 28개로 정정", "correction", "30");
  assert.throws(() => validateSemanticCandidates(batch([ambiguous]), context(ambiguous.evidence[0]!.quote)), /SEMANTIC_QUANTITY_UNSUPPORTED/);
});

test("N06 legacy adapter preserves source chunk identity and discards model canonical IDs", () => {
  const text = "30개 출고, 28개 인수";
  const response = legacy([
    { predicate: "quantity", value: { kind: "quantity", value: "30", unitCode: "ea", semantic: "moved" },
      speechKind: "observation", quote: text, evidenceLocator: "section:1001", confidence: 0.9 },
    { predicate: "quantity", value: { kind: "quantity", value: "28", unitCode: "ea", semantic: "accepted" },
      speechKind: "observation", quote: text, evidenceLocator: "section:1001", confidence: 1 },
  ]);
  response.candidateLinks.push({ claimIndex: 1, targetKind: "bundle", targetId: TENANT, evidenceLocator: "section:1001", confidence: 1 });
  const result = adaptLegacyClaimsToSemanticCandidates(response, context(text));
  assert.deepEqual(result.candidates.map(item => [item.eventKind, item.quantity!.value, item.evidence[0]!.quote]),
    [["dispatch", "30", "30개 출고"], ["receipt", "28", "28개 인수"]]);
  assert.equal(result.candidates[0]!.evidence[0]!.ordinal, 1001);
  assert.equal(result.candidates[0]!.evidence[0]!.locator, "sheet:0/cell:A1002");
  assert.ok(result.candidates[1]!.uncertaintyReasons.includes("model_entity_ids_ignored"));
  assert.ok(!JSON.stringify(result).includes("targetId"));
});

test("N06 bounded schema rejects duplicate keys, invented model versions and oversized output", () => {
  const item = candidate("28개 인수"), source = context("28개 인수");
  assert.throws(() => validateSemanticCandidates(batch([item, item]), source), /SEMANTIC_VERSION_OR_KEY_INVALID/);
  assert.throws(() => validateSemanticCandidates({ ...batch([item]), modelVersion: "invented-model" }, source), /SEMANTIC_VERSION_OR_KEY_INVALID/);
  assert.throws(() => validateSemanticCandidates(batch(Array.from({ length: 101 }, (_, index) => ({ ...item, key: `claim_${index}` }))), source));
  source.chunks.push({ ...source.chunks[0]! });
  assert.throws(() => validateSemanticCandidates(batch([item]), source), /SEMANTIC_CONTEXT_INVALID/);
});

test('N06 sentence boundaries preserve actual receipt; decimals and material nails remain positive',()=>{
 for(const text of ['28개 인수 완료. 30개 출고하지 않았음','못 28개 인수 완료']){
  const item=candidate(text.startsWith('못')?text:'28개 인수 완료');
  assert.equal(validateSemanticCandidates(batch([item]),context(text)).candidates[0]!.assertionStatus,'asserted');
 }
 const item=candidate('1.5 m 인수 완료','receipt','1.5');item.quantity!.unitCode='m';
 assert.equal(validateSemanticCandidates(batch([item]),context('1.5 m 인수 완료. 출고 안 함')).candidates[0]!.assertionStatus,'asserted');
 for(const text of ['28개 인수 안 함','28개 인수 거부','28개 인수 보류','28개 미인수','28개 인수 불가']){
  assert.equal(validateSemanticCandidates(batch([candidate(text)]),context(text)).candidates[0]!.assertionStatus,'unasserted',text);
 }
});

test('N06 partial validation retains good siblings and distinguishes runtime faults',()=>{
 const good=candidate('28개 인수'),bad={...good,key:'bad',quantity:{value:'999',unitCode:'ea'}};
 const result=validateSemanticBatchPartial(batch([good,bad]),context('28개 인수'));
 assert.equal(result.candidates.length,1);assert.deepEqual(result.rejected,[{key:'bad',code:'SEMANTIC_QUANTITY_UNSUPPORTED'}]);
 assert.equal(semanticRejectionCode(new TypeError('runtime fault')),null);
 assert.equal(semanticRejectionCode(new Error('SEMANTIC_CONTEXT_INVALID')),null);
 const compound=candidate('1억 2천만 원 요청','request',null);compound.amount={minor:'120000000',currency:'KRW',knowledge:'known'};
 assert.equal(validateSemanticCandidates(batch([compound]),context('1억 2천만 원 요청')).candidates[0]!.amount!.minor,'120000000');
});
