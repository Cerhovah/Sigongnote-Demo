import {allocateScopeSupply} from './quote-scope.js';

/** A partial claim allocates money, never invents observed quantities. */
export function partialDocument<T extends {lines:{id:string;supply:string|null;tax:string|null;quantity:string|null;unit_price:string|null}[];totals:{supply:string|null;tax:string|null;total:string|null}}>(snapshot:T,requested?:string,taxMode?:string):T {
 const copy=structuredClone(snapshot);
 for(const l of copy.lines){if(l.tax===null&&taxMode==='not_applicable')l.tax='0';if(l.supply===null||l.tax===null)throw new Error('UNKNOWN_ISSUE_AMOUNT');}
 if(copy.totals.tax===null&&taxMode==='not_applicable')copy.totals.tax='0';
 if(copy.totals.supply===null||copy.totals.tax===null||copy.totals.total===null)throw new Error('UNKNOWN_ISSUE_AMOUNT');
 const total=BigInt(copy.totals.total);
 const amount=requested===undefined?total:BigInt(requested);
 if(total<=0n||amount<=0n||amount>total)throw new Error('INVALID_PARTIAL_AMOUNT');
 if(amount===total)return copy;
 const gross=allocateScopeSupply(copy.lines.map(l=>({id:l.id,costMinor:(BigInt(l.supply!)+BigInt(l.tax!)).toString()})),amount.toString());
 let supply=0n,tax=0n;
 for(const line of copy.lines){const original=BigInt(line.supply!)+BigInt(line.tax!),part=BigInt(gross.get(line.id)!);const net=original===0n?0n:(part*BigInt(line.supply!)+original/2n)/original;line.supply=net.toString();line.tax=(part-net).toString();line.quantity=null;line.unit_price=null;supply+=net;tax+=part-net;}
 copy.totals={supply:supply.toString(),tax:tax.toString(),total:amount.toString()};return copy;
}
