import {calculateQuote} from "./quote.js";
import {allocateScopeSupply} from "./quote-scope.js";

export type DocumentType="estimate"|"purchase_order"|"invoice"|"delivery_statement";
export type DraftLine={id:string;description:string;spec:string;unit:string;quantity:string|null;purchaseRate:string|null;salesRate:string|null;ordered:string;sourceRevision:string;locator:string;rateCurrent:boolean};
export type DraftPolicy={marginBps:number|null;taxBps:number|null;taxMode:"exclusive"|"inclusive"|"not_applicable"|"unknown"};
export const draftCalculationVersion="document-draft-v1";
export function decimalMicros(value:string):bigint{
 if(!/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value))throw new Error("INVALID_QUANTITY");
 const [whole="0",part=""]=value.split('.');return BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));
}
function decimal(value:bigint){const whole=value/1000000n,part=(value%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return `${whole}${part?`.${part}`:''}`;}
export function remainingQuantity(needed:string,ordered:string){const result=decimalMicros(needed)-decimalMicros(ordered);if(result<0n)throw new Error('OVER_ORDERED');return decimal(result);}
export function remainingBillable(confirmed:string,invoiced:string,reserved:string){for(const v of [confirmed,invoiced,reserved])if(!/^-?(0|[1-9][0-9]{0,15})$/.test(v))throw new Error('INVALID_MONEY');const n=BigInt(confirmed)-BigInt(invoiced)-BigInt(reserved);if(n<0n)throw new Error('OVER_BILLED');return n.toString();}
export function calculateDocument(type:DocumentType,source:DraftLine[],policy:DraftPolicy){
 const missing:string[]=[];
 if(source.length===0)missing.push('품목과 수량');if(source.length>100||new Set(source.map(l=>l.id)).size!==source.length)throw new Error('INVALID_LINES');
 if(policy.taxMode==='unknown'||(policy.taxMode!=='not_applicable'&&policy.taxBps===null))missing.push('부가세 조건');
 if(policy.taxBps!==null&&(!Number.isInteger(policy.taxBps)||policy.taxBps<0||policy.taxBps>10000))throw new Error('INVALID_TAX');
 if(type==='estimate'&&policy.marginBps===null)missing.push('마진 기준');
 const prepared=source.map(line=>{
  let quantity=line.quantity;
  if(quantity!==null&&type==='purchase_order')try{quantity=remainingQuantity(quantity,line.ordered);}catch{quantity=null;missing.push(`${line.description}의 이미 발주한 수량`);}
  const rate=type==='estimate'||type==='purchase_order'?line.purchaseRate:line.salesRate;
  if(quantity===null||rate===null||!line.rateCurrent)missing.push(`${line.description}의 ${quantity===null?'수량':rate===null?'단가':'최신 단가'}`);
  if(rate!==null&&!/^(0|[1-9][0-9]{0,14})$/.test(rate))throw new Error('INVALID_RATE');
  const amount=quantity!==null&&rate!==null&&line.rateCurrent?((decimalMicros(quantity)*BigInt(rate)+500000n)/1000000n).toString():null;
  return {...line,quantity,amount};
 }).filter(l=>l.quantity===null||decimalMicros(l.quantity)!==0n);
 if(!prepared.length&&!missing.length)missing.push(type==='purchase_order'?'추가 발주할 품목':'작성할 품목');
 let supply:string|null=null,tax:string|null=null,total:string|null=null;
 let allocations=new Map<string,string>();
 if(!missing.length){
  // Reuse quote arithmetic for margin. Explicit VAT is applied below, not its legacy default.
  if(type==='estimate'){
   const quote=calculateQuote(prepared.map(l=>({category:'material',quantity:l.quantity!,unitCode:'unit',rateMinor:l.purchaseRate,included:true,exclusionReason:null,rateFresh:l.rateCurrent,sourceRateId:l.sourceRevision})),policy.marginBps!,'not_applicable');
   supply=quote.supplyMinor;
  }else supply=prepared.reduce((s,l)=>s+BigInt(l.amount!),0n).toString();
  if(supply===null)throw new Error('INVALID_TOTAL');
  const rate=BigInt(policy.taxMode==='not_applicable'?0:policy.taxBps!);
  if(policy.taxMode==='inclusive'&&type!=='estimate'){total=supply;supply=((BigInt(total)*10000n+(10000n+rate)/2n)/(10000n+rate)).toString();tax=(BigInt(total)-BigInt(supply)).toString();}
  else{tax=((BigInt(supply)*rate+5000n)/10000n).toString();total=(BigInt(supply)+BigInt(tax)).toString();}
  if(BigInt(total)>9999999999999999n)throw new Error('AMOUNT_LIMIT');
  allocations=allocateScopeSupply(prepared.map(l=>({id:l.id,costMinor:l.amount!})),supply);
 }
 const taxes=tax!==null?allocateScopeSupply(prepared.map(l=>({id:l.id,costMinor:allocations.get(l.id)!})),tax):new Map<string,string>();
 return {state:missing.length?'needs_inputs':'draft_ready',missing:[...new Set(missing)],lines:prepared.map(l=>{
  const allocated=allocations.get(l.id)??null,q=l.quantity===null?0n:decimalMicros(l.quantity);
  const price=type==='estimate'?(allocated===null||q===0n?null:((BigInt(allocated)*1000000n+q/2n)/q).toString()):type==='purchase_order'?l.purchaseRate:l.salesRate;
  const adjustment=type==='estimate'&&allocated!==null&&price!==null?(BigInt(allocated)-(q*BigInt(price)+500000n)/1000000n).toString():'0';
  return {id:l.id,description:l.description,spec:l.spec,unit:l.unit,quantity:l.quantity,unit_price:price,price_tax_mode:type==='estimate'?'exclusive':policy.taxMode,rounding_adjustment:adjustment,supply:allocated,tax:taxes.get(l.id)??null};
 }),totals:{supply,tax,total},calculation_version:draftCalculationVersion};
}
/** Suitability is about measured work/cost/conditions; settlement may remain open. */
export function reusableOutcome(value:{quantity:string;actualCost:string|null;unknownCosts:number;completed:boolean;ownerLabor:boolean|null;observedOn:string;asOf:string;conditions:string[];targetConditions:string[];current:boolean}){
 const age=(Date.parse(value.asOf)-Date.parse(value.observedOn))/86400000;
 return value.current&&value.completed&&value.actualCost!==null&&/^[0-9]+$/.test(value.actualCost)&&value.unknownCosts===0&&value.ownerLabor!==null&&decimalMicros(value.quantity)>0n&&Number.isFinite(age)&&age>=0&&age<=90&&value.conditions.every(t=>value.targetConditions.includes(t));
}
