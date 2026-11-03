export type QuoteCostLine = { category:string; quantity:string; unitCode:string;
  rateMinor:string|null; included:boolean; exclusionReason:string|null;
  rateFresh:boolean; sourceRateId:string|null };
export type QuoteCalculation = { state:"draft_ready"|"needs_inputs";
  baseCostMinor:string|null; supplyMinor:string|null; vatMinor:string|null;
  totalMinor:string|null; missing:string[]; lines:(QuoteCostLine & {costMinor:string|null})[] };

function quantityMicros(value:string):bigint {
  if (!/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value))
    throw new Error("INVALID_QUANTITY");
  const [whole="0",fraction=""]=value.split(".");
  return BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,"0"));
}
function money(value:string):bigint {
  if (!/^(0|[1-9][0-9]{0,14})$/.test(value)) throw new Error("INVALID_MONEY");
  return BigInt(value);
}
function ceilDiv(value:bigint,denominator:bigint):bigint {
  return (value+denominator-1n)/denominator;
}

export function calculateQuote(lines:readonly QuoteCostLine[],marginBps:number,
  vatMode:"exclusive"|"inclusive"|"not_applicable"|"unknown"):QuoteCalculation {
  if (!Number.isInteger(marginBps) || marginBps<0 || marginBps>=10000 ||
      lines.length<1 || lines.length>100) throw new Error("INVALID_QUOTE_INPUT");
  const missing:string[]=[];
  let base=0n;
  const results=lines.map((line,index)=>{
    const micros=quantityMicros(line.quantity);
    if (micros<=0n || !/^[a-z][a-z0-9_]{0,31}$/.test(line.unitCode))
      throw new Error("INVALID_QUOTE_LINE");
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(line.category)) throw new Error("INVALID_QUOTE_LINE");
    if (!line.included) {
      if (!line.exclusionReason?.trim()) throw new Error("EXCLUSION_REASON_REQUIRED");
      return {...line,costMinor:null};
    }
    if (line.rateMinor===null || line.sourceRateId===null || !line.rateFresh) {
      missing.push(`line_${index+1}_rate_${line.rateMinor===null?"unknown":"stale"}`);
      return {...line,costMinor:null};
    }
    const amount=(micros*money(line.rateMinor)+500_000n)/1_000_000n;
    if (amount>9_999_999_999_999_999n) throw new Error("QUOTE_AMOUNT_LIMIT");
    base+=amount;
    return {...line,costMinor:amount.toString()};
  });
  if (vatMode==="unknown" || vatMode==="inclusive") missing.push("vat_policy_unknown");
  if (missing.length) return {state:"needs_inputs",baseCostMinor:null,
    supplyMinor:null,vatMinor:null,totalMinor:null,missing,lines:results};
  const supply=ceilDiv(base*10_000n,BigInt(10_000-marginBps));
  const vat=vatMode==="exclusive"?(supply*10n+50n)/100n:0n;
  const total=supply+vat;
  if (total>9_999_999_999_999_999n) throw new Error("QUOTE_AMOUNT_LIMIT");
  return {state:"draft_ready",baseCostMinor:base.toString(),
    supplyMinor:supply.toString(),vatMinor:vat.toString(),
    totalMinor:total.toString(),missing:[],lines:results};
}
