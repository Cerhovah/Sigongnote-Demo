import {z} from 'zod';
const amount=z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
const date=z.iso.date();
export const WorkEffectSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('schedule'),date}),
 z.strictObject({kind:z.literal('acceptance'),quantity:z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$/),unit:z.string().min(1).max(12),ordered:z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$/)}),
 z.strictObject({kind:z.literal('quality'),action:z.string().trim().min(1).max(200)}),
 z.strictObject({kind:z.literal('liability'),party:z.enum(['company','customer','supplier'])}),
 z.strictObject({kind:z.literal('charge_adjustment'),charge_id:z.uuid(),version:z.number().int().positive(),amount_minor:amount,liability:z.enum(['company','customer','supplier']),reason:z.enum(['change','defect'])}),
 z.strictObject({kind:z.literal('prepare_invoice')})
]);
export type WorkEffect=z.infer<typeof WorkEffectSchema>;
export type WorkSignal={category:'schedule'|'material'|'defect'|'change'|'billing';prompt:string;effects:WorkEffect[];indices:number[];due:string|null;cost:string|null;ambiguousCost?:boolean};
/** Only explicitly labelled observations are parsed. Narrative/conditional amounts stay unresolved. */
export function workSignals(spans:{text:string}[],today:string):WorkSignal[]{
 const records=spans.flatMap((s,index)=>s.text.split('\n').map(text=>({text:text.trim(),index})));const signals:WorkSignal[]=[];
 const field=(name:string)=>{const found=records.filter(r=>new RegExp(`^${name}\\s*[:：]\\s*[^\\n]+$`).test(r.text));return found.length===1?{value:found[0]!.text.replace(/^[^:：]+[:：]\s*/,''),index:found[0]!.index}:null;};
 const due=field('약속일'),next=field('다음 일정');
 if(due&&date.safeParse(due.value).success&&due.value<today&&next&&date.safeParse(next.value).success)signals.push({category:'schedule',prompt:`약속한 ${due.value}이 지났어요. 다음 일정을 ${next.value}로 바꿀까요?`,effects:[{kind:'schedule',date:next.value}],indices:[due.index,next.index],due:due.value,cost:null});
 const ordered=field('발주수량'),accepted=field('인수수량'),q=/^((?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,3})?)\s+([^\s]{1,12})$/;
 const o=ordered?.value.match(q),a=accepted?.value.match(q);
 if(o&&a&&o[2]===a[2]&&Number(o[1])!==Number(a[1]))signals.push({category:'material',prompt:`발주 ${o[1]}${o[2]}, 인수 기록은 ${a[1]}${a[2]}예요. 받은 수량으로 반영할까요?`,effects:[{kind:'acceptance',quantity:a[1]!,ordered:o[1]!,unit:a[2]!}],indices:[ordered!.index,accepted!.index],due:null,cost:null});
 const defect=field('하자'),action=field('조치'),liability=field('부담'),cost=field('추가비'),change=field('변경합의');
 const parties:Record<string,'company'|'customer'|'supplier'>={'회사':'company','고객':'customer','공급처':'supplier'};const party=liability?parties[liability.value]:undefined;
 const minor=cost?.value.match(/^([1-9][0-9]{0,14})원$/)?.[1]??null;
 if(defect&&action&&action.value.length<=200){const effects:WorkEffect[]=[{kind:'quality',action:action.value}];if(party)effects.push({kind:'liability',party});signals.push({category:'defect',prompt:`${defect.value.slice(0,100)} — ${action.value}. 이 조치와 확인된 부담을 반영할까요?`,effects,indices:[defect.index,action.index,...(liability?[liability.index]:[]),...(cost?[cost.index]:[])],due:null,cost:minor});}
 if(change&&party&&minor)signals.push({category:'change',prompt:`${change.value.slice(0,100)} 추가비 ${BigInt(minor).toLocaleString('ko-KR')}원, ${liability!.value} 부담으로 기록할까요?`,effects:[{kind:'liability',party}],indices:[change.index,liability!.index,cost!.index],due:null,cost:minor});
 if(defect&&change&&minor){const related=signals.filter(s=>s.category==='defect'||s.category==='change');if(related.length===2){const keep=signals.filter(s=>!related.includes(s));keep.push({category:'change',prompt:`${BigInt(minor).toLocaleString('ko-KR')}원은 하자 보완 비용인가요, 변경 추가비인가요? 조치와 부담도 함께 기록해요.`,effects:related[0]!.effects,indices:[...new Set(related.flatMap(s=>s.indices))],due:null,cost:minor,ambiguousCost:true});return keep;}}
 return signals;
}
