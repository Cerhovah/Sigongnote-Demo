import { MoneySchema, QuantitySchema, type Money } from "./schemas.js";

export const BASE_UNITS: ReadonlySet<string> = new Set(["ea","m","m2","m3","kg","ton","day","hour","lump","set","box","sheet","roll","l"]);
export class ContractViolation extends Error {
 constructor() { super("INVALID_CONTRACT"); this.name="ContractViolation"; }
}
export function parseMoney(input: unknown): Money {
 const result = MoneySchema.safeParse(input);
 if(!result.success) throw new ContractViolation();
 return result.data;
}
export function knownMinor(input: unknown): bigint {
 const money = parseMoney(input);
 if(money.knowledge !== "known") throw new ContractViolation();
 return BigInt(money.minor);
}
// Unit syntax is extensible; only a server-validated trade-pack registry may extend this set.
export function parseQuantity(input: unknown, registeredUnits: ReadonlySet<string> = BASE_UNITS) {
 const result = QuantitySchema.safeParse(input);
 if(!result.success || !registeredUnits.has(result.data.unit_code)) throw new ContractViolation();
 return result.data;
}
export function quantityMicros(input: unknown, registeredUnits: ReadonlySet<string> = BASE_UNITS): bigint {
 const quantity=parseQuantity(input,registeredUnits);
 const [whole="0", fraction=""] = quantity.value.replace(/^-/,"").split(".");
 const magnitude=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,"0"));
 return quantity.value.startsWith("-") ? -magnitude : magnitude;
}

// Use on numeric quantity fields before canonical command hashing; preserve raw_text.
export function canonicalQuantity(input: unknown, registeredUnits: ReadonlySet<string> = BASE_UNITS) {
 const quantity=parseQuantity(input,registeredUnits);
 const scaled=quantityMicros(quantity,registeredUnits);
 const absolute=scaled<0n ? -scaled : scaled;
 const fractional=(absolute%1000000n).toString().padStart(6,"0").replace(/0+$/,"");
 const value=`${scaled<0n?"-":""}${absolute/1000000n}${fractional?`.${fractional}`:""}`;
 return {...quantity,value};
}
