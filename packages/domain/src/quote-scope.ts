const q=/^-?(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
function micros(value:string):bigint {
  if (!q.test(value)) throw new Error("INVALID_SCOPE_QUANTITY");
  const negative=value.startsWith("-");
  const [whole="0",fraction=""]=(negative?value.slice(1):value).split(".");
  const amount=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,"0"));
  return negative?-amount:amount;
}
function quantity(value:bigint):string {
  const sign=value<0n?"-":"";
  const magnitude=value<0n?-value:value;
  const fraction=(magnitude%1_000_000n).toString().padStart(6,"0").replace(/0+$/,"");
  return sign+(magnitude/1_000_000n).toString()+(fraction?`.${fraction}`:"");
}
function money(value:string):bigint {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error("INVALID_SCOPE_MONEY");
  return BigInt(value);
}
export type ScopeOperation="add"|"delta"|"replace"|"remove";
export type ContractAmount={quantityValue:string;supplyMinor:string};
export function isScopeReduction(before:string,after:string):boolean {
  return micros(after)<micros(before);
}
export function applyContractOperation(current:ContractAmount|null,operation:ScopeOperation,
  quantityValue:string,supplyMinor:string):ContractAmount {
  const change=micros(quantityValue),supply=money(supplyMinor);
  if (operation==="add") {
    if (current || change<=0n) throw new Error("INVALID_SCOPE_OPERATION");
    return {quantityValue:quantity(change),supplyMinor:supply.toString()};
  }
  if (!current) throw new Error("MISSING_CONTRACT_LINE");
  const old=micros(current.quantityValue),oldSupply=money(current.supplyMinor);
  if (old<0n) throw new Error("INVALID_SCOPE_OPERATION");
  if (operation==="replace") {
    if (change<=0n) throw new Error("INVALID_SCOPE_OPERATION");
    return {quantityValue:quantity(change),supplyMinor:supply.toString()};
  }
  if (operation==="remove") {
    if (change!==0n || supply!==0n) throw new Error("INVALID_SCOPE_OPERATION");
    return {quantityValue:"0",supplyMinor:"0"};
  }
  if (change===0n || old+change<0n || (change<0n && oldSupply<supply))
    throw new Error("INVALID_SCOPE_OPERATION");
  return {quantityValue:quantity(old+change),
    supplyMinor:(oldSupply+(change<0n?-supply:supply)).toString()};
}

export function allocateScopeSupply(lines:readonly {id:string;costMinor:string}[],
  supplyMinor:string):Map<string,string> {
  if (lines.length<1 || new Set(lines.map(item=>item.id)).size!==lines.length)
    throw new Error("INVALID_SCOPE_ALLOCATION");
  const total=money(supplyMinor),base=lines.reduce((sum,item)=>sum+money(item.costMinor),0n);
  if (base===0n && total!==0n) throw new Error("INVALID_SCOPE_ALLOCATION");
  const portions=lines.map(item=>{
    const numerator=base===0n?0n:total*money(item.costMinor);
    return {id:item.id,amount:base===0n?0n:numerator/base,
      remainder:base===0n?0n:numerator%base};
  });
  let remaining=total-portions.reduce((sum,item)=>sum+item.amount,0n);
  for (const item of [...portions].sort((a,b)=>
    a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1)) {
    if (remaining<=0n) break;
    item.amount++;remaining--;
  }
  return new Map(portions.map(item=>[item.id,item.amount.toString()]));
}
