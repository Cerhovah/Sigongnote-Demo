/** Secure random IDs also work in the explicitly local HTTP LAN preview. */
export function workId():string {
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const b=crypto.getRandomValues(new Uint8Array(16));b[6]=((b[6]??0)&15)|64;b[8]=((b[8]??0)&63)|128;
 const h=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
