import {readDocumentSource,type DraftSource} from './document-source.js';
import {decimalMicros,type DraftLine,type DocumentType} from './document-draft.js';
export type DocumentFact={id:string;revision:string;version:string;transaction_key?:string|null;semantic:any};
export type DocumentObservation={id:string;revision:string;description:string;quantity:string|null;unit:string};
const units:Record<string,string[]>={ea:['개','장','매','대','ea'],m:['m','미터'],m2:['㎡','m2'],kg:['kg'],lump:['식'],day:['공수']};
const same=(a:string,b:string)=>a.normalize('NFKC').trim()===b.normalize('NFKC').trim();
const quote=(f:DocumentFact)=>(f.semantic.evidence??[]).map((e:any)=>e.quote).join('\n');
const number=(value:bigint)=>`${value/1000000n}${value%1000000n?'.'+(value%1000000n).toString().padStart(6,'0').replace(/0+$/,''):''}`;
/** Deterministic candidates from ordinary documents and validated observations; no ledger effect. */
export function composeDocumentEvidence(type:DocumentType,sources:DraftSource[],facts:DocumentFact[],asOf:string,observations:DocumentObservation[]=[]){
 let result=readDocumentSource(type,sources);
 if(type!=='estimate'&&!result.selected&&!result.issues.length){result=readDocumentSource('estimate',sources);if(type==='purchase_order')result.recipient=null;}
 const references=new Set<string>(result.selected?[result.selected.id]:[]),notes:string[]=[];
 const receiptSubjects:string[]=[];const receiptAmounts:{subject:string;quantity:string;unit:string;factIds:string[]}[]=[];
 const isPrepared=result.selected?.spans.some(s=>/견적\s*준비|발주\s*준비|청구\s*준비|거래\s*명세\s*준비/u.test(s.text))??false;
 // A customer quote's margin text is not an owner's current policy.
 if(type==='estimate'&&result.selected&&!isPrepared)result.policy.marginBps=null;
 const priceSources=sources.filter(s=>s.spans.some(p=>/^매입\s*단가표/u.test(p.text.trim())));
 const priceTables=priceSources.map(s=>({source:s,read:readDocumentSource('estimate',[{...s,spans:[{text:'견적 준비',locator:'adapter:price-table'},...s.spans.map(p=>({...p,text:p.text.replace(/(^|\|\s*)단가(?=\s*\||$)/g,'$1매입단가')}))]}])}));
 let lines=result.lines.map(l=>({...l,rateDate:result.rateDate??null}));
 // A validated item/quantity observation can start a new estimate without a preformatted quote table.
 // Prices, margin and tax remain empty until an actual source or the owner supplies them.
 if(type==='estimate'&&!result.selected&&!result.issues.length){
  const candidates:DocumentObservation[]=[...facts.flatMap(f=>{const s=f.semantic,q=s.quantity,linked=(s.entityLinks??[]).filter((l:any)=>l.status==='linked'&&l.mentionId===`${s.subject?.kind}:${s.subject?.mention}`);return s.assertionStatus==='asserted'&&s.entityCoverage==='complete'&&linked.length===1&&['item_type','item_instance'].includes(s.subject?.kind)&&['request','agreement'].includes(s.eventKind)&&q? [{id:f.id,revision:f.revision,description:String(s.subject.mention),quantity:String(q.value),unit:(units[q.unitCode]??[q.unitCode])[0]!}]:[];}),...observations].filter(c=>sources.some(s=>s.id===c.revision)&&c.description.trim()&&c.unit.trim()&&(c.quantity===null||/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(c.quantity)));
  const groups=new Map<string,DocumentObservation[]>();for(const c of candidates){const key=JSON.stringify([c.description.normalize('NFKC').trim(),c.unit]);groups.set(key,[...(groups.get(key)??[]),c]);references.add(c.revision);}
  for(const [key,group]of groups){const c=group[0]!;if(new Set(group.map(g=>g.quantity)).size!==1){result.issues.push(`${c.description}의 서로 다른 요청 수량`);continue;}lines.push({id:'observation:'+key,description:c.description.slice(0,180),spec:'',unit:c.unit.slice(0,20),quantity:c.quantity,purchaseRate:null,salesRate:null,ordered:'0',sourceRevision:c.revision,locator:'observation:'+c.id,rateCurrent:false,rateDate:null});}
  if(lines.length){notes.push('업무 연락에서 읽은 품목·수량 후보');if(references.size===1){const source=sources.find(s=>s.id===lines[0]!.sourceRevision);if(source)result={...result,selected:source};}}
 }
 if(result.selected){
  const applicable=facts.filter(f=>f.semantic.assertionStatus==='asserted'&&['request','acceptance','correction','cancellation'].includes(f.semantic.eventKind));
  const groups=new Map<string,DocumentFact[]>();
  for(const f of applicable){const s=f.semantic,links=(s.entityLinks??[]).filter((l:any)=>l.status==='linked'&&l.mentionId===`${s.subject?.kind}:${s.subject?.mention}`);if(s.entityCoverage!=='complete'||links.length!==1||!['item_type','item_instance'].includes(s.subject?.kind)){if(s.quantity&&/총|전체|최종|변경|정정/u.test(quote(f))){result.issues.push('변경 자료의 품목 연결');references.add(f.revision);}continue;}const key=String(links[0].targetId);groups.set(key,[...(groups.get(key)??[]),f]);}
  const matches=new Map<string,string>();
  for(const [subject,group]of groups){
   const name=String(group[0]!.semantic.subject.mention),matched=lines.filter(l=>same(l.description,name));
   if(matched.length>1||matched.some(l=>matches.has(l.id)&&matches.get(l.id)!==subject)){result.issues.push(`${name}의 서로 다른 규격·대상`);continue;}
   if(matched[0])matches.set(matched[0].id,subject);
   // Only explicitly expressed final quantities replace prior quote quantities. Additional quantities need transaction reconciliation.
   const changes=group.filter(f=>f.semantic.quantity&&/총|전체|최종|으로\s*(변경|정정)|로\s*(변경|정정)/u.test(quote(f)));
   if(group.some(f=>f.semantic.eventKind==='cancellation')){result.issues.push(`${name}의 취소 범위`);group.forEach(f=>{references.add(f.revision);});continue;}
   const ambiguous=group.filter(f=>!changes.includes(f)&&f.semantic.quantity).some(f=>{const q=f.semantic.quantity;return /추가|변경|정정/u.test(quote(f))||!matched[0]?.quantity||!/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(q.value)||decimalMicros(q.value)!==decimalMicros(matched[0]!.quantity!)||!(units[q.unitCode]??[q.unitCode]).includes(matched[0]!.unit);});
   if(ambiguous){result.issues.push(`${name}의 전체 수량과 추가 수량 구분`);group.forEach(f=>{references.add(f.revision);});continue;}
   if(!changes.length)continue;
   const newest=Math.max(...changes.map(f=>Date.parse(f.semantic.effectiveAt??f.semantic.observedAt??''))),selected=changes.filter(f=>Date.parse(f.semantic.effectiveAt??f.semantic.observedAt??'')===newest);
   if(!Number.isFinite(newest)||new Set(selected.map(f=>JSON.stringify(f.semantic.quantity))).size!==1||group.some(f=>f.semantic.eventKind==='correction'&&!changes.includes(f))){result.issues.push(`${name}의 변경 순서·수량`);group.forEach(f=>{references.add(f.revision);});continue;}
   const f=selected[0]!,q=f.semantic.quantity;
   if(!/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(q.value)){result.issues.push(`${name}의 수량 범위`);continue;}
   const existing=matched[0];if(existing&&!(units[q.unitCode]??[q.unitCode]).includes(existing.unit)){result.issues.push(`${name}의 변경 단위`);continue;}
   if(existing)existing.quantity=number(decimalMicros(q.value));
   else lines.push({id:'item:'+subject,description:name.slice(0,180),spec:'',unit:(units[q.unitCode]??[q.unitCode])[0]!,quantity:q.value,purchaseRate:null,salesRate:null,ordered:'0',sourceRevision:f.revision,locator:f.semantic.evidence[0].locator,rateCurrent:false,rateDate:null});
   selected.forEach(f=>{references.add(f.revision);});notes.push('현재 확인된 변경 요청·합의 수량을 반영한 초안');
  }
 }
 if(['invoice','delivery_statement'].includes(type)&&result.selected&&!isPrepared){
  const receipts=facts.filter(f=>f.semantic.assertionStatus==='asserted'&&['receipt','correction','cancellation'].includes(f.semantic.eventKind));
  const delivered:typeof lines=[];
  for(const l of lines){
   const related=receipts.filter(f=>same(f.semantic.subject?.mention??'',l.description));
   if(!related.length)continue;
   const ids=new Set<string>(),byTransaction=new Map<string,DocumentFact>();let invalid=false;
   for(const f of related){references.add(f.revision);const s=f.semantic,q=s.quantity,linked=(s.entityLinks??[]).filter((e:any)=>e.status==='linked'&&e.mentionId===`${s.subject?.kind}:${s.subject?.mention}`);
    if(s.eventKind!=='receipt'||s.entityCoverage!=='complete'||linked.length!==1||s.subject?.kind!=='item_instance'||typeof f.transaction_key!=='string'||!f.transaction_key||!q||!/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(q.value)||!(units[q.unitCode]??[q.unitCode]).includes(l.unit)){invalid=true;continue;}
    ids.add(linked[0].targetId);const old=byTransaction.get(f.transaction_key);if(old&&decimalMicros(old.semantic.quantity.value)!==decimalMicros(q.value))invalid=true;byTransaction.set(f.transaction_key,f);
   }
   if(invalid||ids.size!==1||lines.filter(r=>same(r.description,l.description)).length!==1){result.issues.push(`${l.description}의 인수 수량·대상 확인`);continue;}
   const qty=[...byTransaction.values()].reduce((n,f)=>n+decimalMicros(f.semantic.quantity.value),0n);
   if(l.quantity===null||qty>decimalMicros(l.quantity)){result.issues.push(`${l.description}의 합의 범위를 넘은 인수 수량`);continue;}
   if(qty>0n){delivered.push({...l,quantity:number(qty)});receiptSubjects.push([...ids][0]!);receiptAmounts.push({subject:[...ids][0]!,quantity:number(qty),unit:l.unit,factIds:related.map(f=>f.id)});}
  }
  lines=delivered;if(!lines.length)result.issues.push('확인된 인수 내역');
 }
 for(const l of lines){
  const prices=priceTables.flatMap(p=>p.read.lines.filter(r=>same(r.description,l.description)&&same(r.spec,l.spec)&&r.unit===l.unit).map(r=>({...p,line:r})));
  if(prices.length){
   const usable=prices.filter(p=>!p.source.partial&&!p.read.issues.length&&p.read.rateDate&&Number.isFinite(Date.parse(p.read.rateDate))&&Date.parse(p.read.rateDate)<=Date.parse(asOf));
   if(!usable.length){result.issues.push(`${l.description}의 단가표 날짜·읽기 범위 확인`);prices.forEach(p=>{references.add(p.source.id);});continue;}
   const newest=Math.max(...usable.map(p=>Date.parse(p.read.rateDate!))),current=usable.filter(p=>Date.parse(p.read.rateDate!)===newest);
   if(current.length!==1){result.issues.push(`${l.description}의 단가 자료 충돌`);continue;}
   const p=current[0]!;references.add(p.source.id);
   if(result.conditions===null||p.read.conditions===null||p.read.conditions.some(c=>!result.conditions!.includes(c))||p.read.policy.taxMode!==result.policy.taxMode||p.read.policy.taxBps!==result.policy.taxBps){result.issues.push(`${l.description}의 현장·부가세 단가 조건`);continue;}
   l.purchaseRate=p.line.purchaseRate;l.rateDate=p.read.rateDate??null;
  }
  const age=l.rateDate?(Date.parse(asOf)-Date.parse(l.rateDate))/86400000:NaN;l.rateCurrent=!['estimate','purchase_order'].includes(type)||Number.isFinite(age)&&age>=0&&age<=90;
 }
 if(result.selected&&!isPrepared&&['estimate','purchase_order'].includes(type)){
  const text=result.selected.spans.map(p=>p.text).join('\n');
  if(!/운(?:반|송)비\s*[:：]\s*(포함|해당없음)/u.test(text)&&!lines.some(l=>/운반|운송/u.test(l.description)))result.issues.push('운반비 포함 범위');
  if(result.conditions===null)result.issues.push('현장 조건');
 }
 return {...result,lines:lines as (DraftLine&{rateDate:string|null})[],references:[...references],notes:[...new Set(notes)],isPrepared,receiptSubjects,receiptAmounts};
}
