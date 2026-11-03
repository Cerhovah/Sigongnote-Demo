import { z } from "zod";
import { maskSensitive, validateModelResponse, type ModelResponse } from "./claims.js";

export const SEMANTIC_CANDIDATE_SCHEMA_VERSION = "semantic-candidates-v1";
const uuid = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const decimal = z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,6})?$/);
function validUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
const utc = z.string().refine(validUtc);
export const SemanticEntityMentionSchema = z.strictObject({
  kind: z.enum(["project", "contract", "bundle", "party", "item_type", "item_instance", "unknown"]),
  mention: z.string().trim().min(1).max(240),
  role: z.string().trim().min(1).max(80).nullable(),
});
export const SemanticEvidenceRefSchema = z.strictObject({
  indexJobId: uuid, ordinal: z.number().int().min(0).max(10_000_000), contentHash: hash,
  locator: z.string().min(1).max(1000), quote: z.string().min(1).max(4096),
});
export const SemanticCandidateSchema = z.strictObject({
  key: code,
  eventKind: z.enum(["observation", "request", "proposal", "acceptance", "dispatch", "receipt", "inspection", "correction", "cancellation"]),
  actor: SemanticEntityMentionSchema.nullable(), subject: SemanticEntityMentionSchema.nullable(),
  predicate: code, object: SemanticEntityMentionSchema.nullable(),
  quantity: z.strictObject({ value: decimal, unitCode: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/) }).nullable(),
  amount: z.strictObject({ minor: z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})$/).nullable(),
    currency: z.literal("KRW"), knowledge: z.enum(["known", "unknown"]) })
    .refine(value => (value.knowledge === "known") === (value.minor !== null)).nullable(),
  effectiveAt: utc.nullable(),
  assertion: z.strictObject({ polarity: z.enum(["positive", "negative", "unknown"]),
    modality: z.enum(["actual", "conditional", "planned", "uncertain"]),
    speech: z.enum(["direct", "quoted"]), speaker: SemanticEntityMentionSchema.nullable() }),
  evidence: z.array(SemanticEvidenceRefSchema).min(1).max(8),
  uncertaintyReasons: z.array(code).max(30),
});
export const SemanticCandidateBatchSchema = z.strictObject({
  schemaVersion: z.literal(SEMANTIC_CANDIDATE_SCHEMA_VERSION),
  modelVersion: z.string().min(1).max(160), promptVersion: z.string().min(1).max(160),
  candidates: z.array(SemanticCandidateSchema).max(100),
});
export type SemanticCandidate = z.infer<typeof SemanticCandidateSchema>;
export type SemanticEvidenceChunk = {
  ordinal: number; contentHash: string; locator: string; text: string; active: boolean; contextOnly?:boolean; speakerLabel?:string;
};
export type SemanticValidationContext = {
  tenantId: string; revisionId: string; indexJobId: string; observedAt: string;
  modelVersion: string; promptVersion: string; chunks: SemanticEvidenceChunk[];
};
export type ValidatedSemanticCandidate = SemanticCandidate & {
  tenantId: string; revisionId: string; observedAt: string;
  status: "candidate_only"; assertionStatus: "asserted" | "unasserted";
};
export type ValidatedSemanticCandidateBatch = Omit<z.infer<typeof SemanticCandidateBatchSchema>, "candidates"> & {
  candidates: ValidatedSemanticCandidate[];
};
const events: Record<Exclude<SemanticCandidate["eventKind"], "observation">, RegExp> = {
  request: /요청|부탁|주문|발주|해\s*주세요|request|order/iu,
  proposal: /제안|어떨|할까|하면 어떨|proposal|propose/iu,
  acceptance: /승인|승낙|합의|수락|approve|agreed|acceptance/iu,
  dispatch: /출고|발송|배송|보냈|보내었|dispatch|shipped|sent/iu,
  receipt: /인수|수령|받았|받음|도착|received|receipt/iu,
  inspection: /검수|검사|점검|검측|inspection|inspect/iu,
  correction: /정정|수정|바꿉|변경합니다|corrected|correction/iu,
  cancellation: /취소|철회|cancel|withdraw/iu,
};
function eventKinds(text: string): SemanticCandidate["eventKind"][] {
  return (Object.entries(events) as [Exclude<SemanticCandidate["eventKind"], "observation">, RegExp][])
    .filter(([, expression]) => expression.test(text)).map(([kind]) => kind);
}
function scaled(text: string): bigint | null {
  const value = text.replaceAll(",", "");
  if (!decimal.safeParse(value).success) return null;
  const [whole = "0", fraction = ""] = value.replace("-", "").split(".");
  const integer = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return value.startsWith("-") ? -integer : integer;
}
const unitAliases: Record<string, string[]> = {
  ea: ["개", "EA", "매", "장", "대", "본", "짝"], m: ["m", "미터"],
  m2: ["m2", "m²", "㎡", "제곱미터"], m3: ["m3", "m³", "㎥"],
  kg: ["kg", "킬로그램"], ton: ["t", "ton", "톤"], box: ["box", "박스", "상자"],
};
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function quantityValues(text: string, unitCode: string): bigint[] {
  const units = unitAliases[unitCode] ?? [unitCode];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_.])-?[0-9][0-9,]*(?:\\.[0-9]{1,6})?\\s*(?:${units.map(escapeRegex).join("|")})(?![A-Za-z0-9_²³])`, "giu");
  return [...text.matchAll(pattern)].flatMap(match => {
    const number = /^-?[0-9][0-9,]*(?:\.[0-9]{1,6})?/.exec(match[0])?.[0];
    const value = number === undefined ? null : scaled(number);
    return value === null ? [] : [value];
  });
}
function supportsQuantity(text: string, quantity: NonNullable<SemanticCandidate["quantity"]>): boolean {
  return quantityValues(text, quantity.unitCode).some(value => value === scaled(quantity.value));
}
function supportsAmount(text: string, minor: string): boolean {
  const compounds=[...text.matchAll(/((?:[0-9][0-9,]*(?:\.[0-9]{1,6})?\s*(?:억|천만|백만|십만|만|천)\s*){2,})원/gu)];
  const scales:Record<string,bigint>={'억':100000000n,'천만':10000000n,'백만':1000000n,'십만':100000n,'만':10000n,'천':1000n};
  if(compounds.some(m=>{let prior=1000000000n,total=0n;for(const part of m[1]!.matchAll(/([0-9][0-9,]*(?:\.[0-9]{1,6})?)\s*(억|천만|백만|십만|만|천)/gu)){const scale=scales[part[2]!]!,n=scaled(part[1]!);if(n===null||scale>=prior)return false;prior=scale;total+=n*scale;}return total===scaled(minor);}))return true;
  return [...text.matchAll(/(?<![\p{L}\p{N}_.])(-?[0-9][0-9,]*(?:\.[0-9]{1,6})?)\s*(억|만|천)?\s*(?:원|KRW)(?![A-Za-z0-9_])/giu)]
    .some(match => {
      const number = scaled(match[1]!);
      const multiplier = match[2] === "억" ? 100_000_000n : match[2] === "만" ? 10_000n : match[2] === "천" ? 1000n : 1n;
      return number !== null && number * multiplier === scaled(minor);
    });
}
function tableCell(locator:string){
 const sheet=/^(sheet:\d+)\/cell:([A-Z]+)(\d+)$/.exec(locator);
 if(sheet)return {table:sheet[1]!,column:sheet[2]!,row:Number(sheet[3])};
 const cell=/^(.*\/table:\d+)\/cell:(\d+),(\d+)$/.exec(locator);
 return cell?{table:cell[1]!,column:cell[3]!,row:Number(cell[2])}:null;
}
/** Separate cells may support an observed value only with their actual column header. */
function tableSupport(candidate:SemanticCandidate,context:SemanticValidationContext){
 if(candidate.eventKind!=='observation')return {quantity:false,amount:false,unitPrice:false,surrounding:[] as string[]};
 const refs=candidate.evidence.map(ref=>({ref,cell:tableCell(ref.locator)})).filter(x=>x.cell);
 const data=context.chunks.filter(chunk=>chunk.active).map(chunk=>({chunk,cell:tableCell(chunk.locator)})).filter(x=>x.cell);
 const header=(at:NonNullable<ReturnType<typeof tableCell>>,pattern:RegExp)=>data
  .filter(x=>x.cell!.table===at.table&&x.cell!.column===at.column&&x.cell!.row<at.row&&pattern.test(x.chunk.text.replace(/\s/g,'')))
  .sort((a,b)=>b.cell!.row-a.cell!.row)[0];
 const exact=(text:string,value:string)=>scaled(text.trim().replace(/,/g,''))===scaled(value);
 let quantity=false,amount=false,unitPrice=false;const quantityRows=new Set<string>(),amountRows=new Set<string>(),surrounding:string[]=[];
 for(const {ref,cell}of refs){
  const at=cell!;
  const itemMentions=[candidate.subject,candidate.object].filter(m=>m&&['item_type','item_instance'].includes(m.kind));
  if(itemMentions.some(m=>!refs.some(x=>x.cell!.table===at.table&&x.cell!.row===at.row&&x.ref.quote.includes(m!.mention))))continue;
  if(candidate.quantity&&exact(ref.quote,candidate.quantity.value)&&header(at,/^(수량|산정수량|산출수량|물량)$/u)){
   const supported=refs.some(other=>other.cell!.table===at.table&&other.cell!.row===at.row&&header(other.cell!,/^단위$/u)&&
    (unitAliases[candidate.quantity!.unitCode]??[candidate.quantity!.unitCode]).some(unit=>other.ref.quote.trim().toLowerCase()===unit.toLowerCase()));
   if(supported)quantityRows.add(`${at.table}/${at.row}`);
  }
  const amountHeader=header(at,/^(금액|합계금액|공급가액|단가|판매단가)(\(원\))?$/u);
  if(candidate.amount?.minor!=null&&exact(ref.quote,candidate.amount.minor)&&amountHeader){
   if(data.some(x=>x.cell!.table===at.table&&x.cell!.row<=at.row&&/단위[:：]?원$|(?:금액|단가)\(원\)/u.test(x.chunk.text.replace(/\s/g,'')))){
    amountRows.add(`${at.table}/${at.row}`);unitPrice ||= /단가/u.test(amountHeader.chunk.text.replace(/\s/g,''));
   }
  }
  surrounding.push(...data.filter(x=>x.cell!.table===at.table&&x.cell!.row===at.row).map(x=>x.chunk.text));
 }
 quantity=quantityRows.size>0;amount=amountRows.size>0;
 if(candidate.quantity&&candidate.amount?.minor!=null&&!([...quantityRows].some(row=>amountRows.has(row))))quantity=amount=false;
 return {quantity,amount,unitPrice,surrounding};
}
function clauses(text: string): string[] {
  return text.split(/\n|[。;!?]|(?<!\d)\.|\.(?!\d)|,(?!\d)|(?<=했고|했으나|하며|이고|지만)\s+/u).map(value => value.trim()).filter(Boolean);
}
function sentenceBoundary(text:string,at:number){return /[\n。;!?]/u.test(text[at]!)||(text[at]==='.'&&!(/\d/.test(text[at-1]??'')&&/\d/.test(text[at+1]??'')));}
function quoteContexts(text: string, quote: string): string[] {
  const contexts: string[] = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    let start = at, end = at + quote.length;
    while (start > 0 && !sentenceBoundary(text,start-1)) start--;
    while (end < text.length && !sentenceBoundary(text,end)) end++;
    contexts.push(text.slice(start, end));
    if (contexts.length >= 32) break;
  }
  return contexts;
}
function validateContext(context: SemanticValidationContext): void {
  if (!uuid.safeParse(context.tenantId).success || !uuid.safeParse(context.revisionId).success ||
    !uuid.safeParse(context.indexJobId).success || !validUtc(context.observedAt) ||
    !context.modelVersion || !context.promptVersion || context.chunks.length > 1000 ||
    new Set(context.chunks.map(chunk => chunk.ordinal)).size !== context.chunks.length ||
    context.chunks.some(chunk => !Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0 ||
      !hash.safeParse(chunk.contentHash).success || !chunk.locator || chunk.locator.length > 1000 ||
      chunk.text.length > 8192) || context.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > 262144) {
    throw new Error("SEMANTIC_CONTEXT_INVALID");
  }
}

export function validateSemanticCandidates(raw: unknown, context: SemanticValidationContext): ValidatedSemanticCandidateBatch {
  validateContext(context);
  const result = SemanticCandidateBatchSchema.parse(raw);
  if (result.modelVersion !== context.modelVersion || result.promptVersion !== context.promptVersion ||
    new Set(result.candidates.map(candidate => candidate.key)).size !== result.candidates.length) {
    throw new Error("SEMANTIC_VERSION_OR_KEY_INVALID");
  }
  const chunks = new Map(context.chunks.map(chunk => [chunk.ordinal, chunk]));
  const candidates = result.candidates.map((candidate): ValidatedSemanticCandidate => {
    const surrounding: string[] = [];
    let ambiguousQuote = false;
    for (const ref of candidate.evidence) {
      const chunk = chunks.get(ref.ordinal);
      if (!chunk || !chunk.active || ref.indexJobId !== context.indexJobId ||
        ref.contentHash !== chunk.contentHash || ref.locator !== chunk.locator ||
        !maskSensitive(chunk.text).includes(ref.quote)) throw new Error("SEMANTIC_EVIDENCE_REJECTED");
      const contexts = quoteContexts(maskSensitive(chunk.text), ref.quote);
      surrounding.push(...contexts);
      ambiguousQuote ||= contexts.length > 1;
    }
    const quotes = candidate.evidence.map(ref => ref.quote);
    if(chunks.get(candidate.evidence[0]!.ordinal)?.contextOnly)throw new Error("SEMANTIC_CONTEXT_ONLY");
    const text = quotes.join("\n");
    const local = quotes.flatMap(clauses);
    const table=tableSupport(candidate,context);surrounding.push(...table.surrounding);
    if (candidate.eventKind !== "observation" && !local.some(clause => events[candidate.eventKind as Exclude<SemanticCandidate["eventKind"], "observation">].test(clause))) {
      throw new Error("SEMANTIC_EVENT_UNSUPPORTED");
    }
    if (candidate.quantity && !table.quantity && !local.some(clause => supportsQuantity(clause, candidate.quantity!) &&
      (candidate.eventKind === "observation" || (events[candidate.eventKind].test(clause) &&
        (["correction", "cancellation"].includes(candidate.eventKind)
          ? new Set(quantityValues(clause, candidate.quantity!.unitCode)).size === 1
          : eventKinds(clause).filter(kind => kind !== candidate.eventKind && !["correction", "cancellation"].includes(kind)).length === 0))))) {
      throw new Error("SEMANTIC_QUANTITY_UNSUPPORTED");
    }
    if (candidate.amount?.minor !== null && candidate.amount?.minor !== undefined && !table.amount &&
      !local.some(clause => supportsAmount(clause, candidate.amount!.minor!) &&
        (candidate.eventKind === "observation" || events[candidate.eventKind].test(clause)))) {
      throw new Error("SEMANTIC_AMOUNT_UNSUPPORTED");
    }
    for (const entity of [candidate.actor, candidate.subject, candidate.object, candidate.assertion.speaker]) {
      if (entity && !text.includes(entity.mention)) throw new Error("SEMANTIC_MENTION_UNSUPPORTED");
    }
    const assertion = { ...candidate.assertion };
    const reasons = new Set(candidate.uncertaintyReasons);
    if(table.amount&&table.unitPrice)reasons.add('table_unit_price');
    // A model cannot remove a following negation, condition or reporting clause by shortening its quote.
    const assertionText = surrounding.join("\n");
    if (ambiguousQuote) reasons.add("ambiguous_quote_context");
    if (/아니|않|못(?!\s*\d)|없|미(?:인수|수령|승인|출고|지급|납|완료|확인|도착|검수)|(?<!\p{L})안\s*(?:함|했|됨|되|하|받|왔|옴)|거절|거부|반려|보류|불가|반품|반송|\bnot\b|\bnever\b/iu.test(assertionText) ||
      (candidate.eventKind !== "cancellation" && /취소|철회/iu.test(assertionText))) {
      assertion.polarity = "negative"; reasons.add("source_negation");
    }
    if (/하면|라면|경우|조건|\bif\b|\bunless\b/iu.test(assertionText)) {
      assertion.modality = "conditional"; reasons.add("source_condition");
    }
    if (/[“”‘’"「」『』]|(?:다고|라고|했다는|했다며|전해)\s*(?:말|전|하|들|보고)|\bsaid\b|\breported\b/iu.test(assertionText)) {
      assertion.speech = "quoted"; reasons.add("reported_speech");
    }
    if (/예정|계획|하기로|\bplanned\b|\bwill\b/iu.test(assertionText) && assertion.modality === "actual") {
      assertion.modality = "planned"; reasons.add("source_plan");
    }
    if (assertion.speech === "quoted" && !assertion.speaker) reasons.add("quoted_speaker_unknown");
    if (candidate.effectiveAt && Date.parse(candidate.effectiveAt) > Date.parse(context.observedAt)) reasons.add("future_effective_time");
    const asserted = assertion.polarity === "positive" && assertion.modality === "actual" &&
      assertion.speech === "direct" && !ambiguousQuote && !reasons.has("future_effective_time");
    return { ...candidate, assertion, uncertaintyReasons: [...reasons].sort(),
      tenantId: context.tenantId, revisionId: context.revisionId, observedAt: context.observedAt,
      status: "candidate_only", assertionStatus: asserted ? "asserted" : "unasserted" };
  });
  return { ...result, candidates };
}

/** Keep good candidates when a sibling is malformed; store reason codes without source text. */
export function validateSemanticBatchPartial(raw:unknown,context:SemanticValidationContext){
 validateContext(context);
 const envelope=SemanticCandidateBatchSchema.omit({candidates:true}).extend({candidates:z.array(z.unknown()).max(100)}).parse(raw);
 if(envelope.modelVersion!==context.modelVersion||envelope.promptVersion!==context.promptVersion)throw Error('SEMANTIC_VERSION_OR_KEY_INVALID');
 const keys=envelope.candidates.map(c=>c&&typeof c==='object'&&'key'in c?c.key:null).filter(k=>typeof k==='string');
 if(new Set(keys).size!==keys.length)throw Error('SEMANTIC_VERSION_OR_KEY_INVALID');
 const candidates:ValidatedSemanticCandidate[]=[],rejected:{key:string;code:string}[]=[];
 for(const [index,candidate]of envelope.candidates.entries())try{candidates.push(...validateSemanticCandidates({...envelope,candidates:[candidate]},context).candidates);}
 catch(error){const code=semanticRejectionCode(error);if(!code)throw error;const key=candidate&&typeof candidate==='object'&&'key'in candidate?String(candidate.key):'';rejected.push({key:/^[a-z][a-z0-9_]{0,63}$/.test(key)?key:`candidate_${index}`,code});}
 return {...envelope,candidates,rejected};
}
export function semanticRejectionCode(error:unknown):string|null{
 if(error instanceof z.ZodError)return 'SCHEMA_INVALID';
 const message=error instanceof Error?error.message:'';
 if(message==='SEMANTIC_CONTEXT_INVALID')return null;
 return /^(?:SEMANTIC_[A-Z_]+|MODEL_LOCATOR_REJECTED|MODEL_RESPONSE_INVALID)$/.test(message)?message:null;
}

/** Compatibility bridge for N03 output; model-supplied canonical link IDs are never imported. */
export function adaptLegacyClaimsToSemanticCandidates(response: ModelResponse,
  context: SemanticValidationContext): ValidatedSemanticCandidateBatch {
  validateContext(context);
  const validated = validateModelResponse(response, context.chunks.map(chunk => ({
    revisionId: context.revisionId, locator: `section:${chunk.ordinal}`, kind: "text", text: chunk.text,
  })));
  const candidates: SemanticCandidate[] = validated.claims.map((claim, index) => {
    const ordinal = Number(claim.evidenceLocator.slice("section:".length));
    const chunk = context.chunks.find(item => item.ordinal === ordinal);
    if (!chunk || claim.evidenceLocator !== `section:${ordinal}`) throw new Error("SEMANTIC_EVIDENCE_REJECTED");
    const detected = eventKinds(claim.quote);
    let eventKind: SemanticCandidate["eventKind"] = detected.length === 1 ? detected[0]! : "observation";
    if (claim.speechKind === "request" && events.request.test(claim.quote)) eventKind = "request";
    if (claim.value.kind === "quantity") {
      const preferred = claim.value.semantic === "moved" ? "dispatch" : claim.value.semantic === "accepted" ? "receipt" :
        claim.value.semantic === "ordered" ? "request" : null;
      if (preferred && detected.includes(preferred)) eventKind = preferred;
    }
    const quantity = claim.value.kind === "quantity" ? { value: claim.value.value, unitCode: claim.value.unitCode } : null;
    const matchingClause = quantity ? clauses(claim.quote).find(clause => supportsQuantity(clause, quantity) &&
      (eventKind === "observation" || (events[eventKind].test(clause) && eventKinds(clause).length === 1))) : undefined;
    const quote = matchingClause ?? claim.quote;
    const uncertaintyReasons = ["legacy_claim_adapter", ...validated.uncertainties
      .filter(item => item.evidenceLocator === undefined || item.evidenceLocator === claim.evidenceLocator).map(item => item.code)];
    if (validated.candidateLinks.some(link => link.claimIndex === index)) uncertaintyReasons.push("model_entity_ids_ignored");
    if (eventKind === "observation" && detected.length > 1) uncertaintyReasons.push("event_kind_ambiguous");
    return { key: `claim_${index}`, eventKind, actor: null, subject: null, predicate: claim.predicate, object: null,
      quantity, amount: claim.value.kind === "money" ? { minor: claim.value.minor, currency: claim.value.currency, knowledge: claim.value.knowledge } : null,
      effectiveAt: null,
      assertion: { polarity: "positive", modality: claim.speechKind === "plan" ? "planned" :
        claim.speechKind === "inference" ? "uncertain" : "actual", speech: claim.speechKind === "reported_approval" ? "quoted" : "direct", speaker: null },
      evidence: [{ indexJobId: context.indexJobId, ordinal, contentHash: chunk.contentHash, locator: chunk.locator, quote }],
      uncertaintyReasons: [...new Set(uncertaintyReasons)].slice(0, 30) };
  });
  return validateSemanticBatchPartial({ schemaVersion: SEMANTIC_CANDIDATE_SCHEMA_VERSION,
    modelVersion: context.modelVersion, promptVersion: context.promptVersion, candidates }, context);
}
