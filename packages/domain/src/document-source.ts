import type {DraftLine,DraftPolicy,DocumentType} from "./document-draft.js";
export type DraftSource={id:string;created_at:string;sha256:string;spans:{text:string;locator:string}[];partial:boolean};
export type DocumentSourceResult={lines:DraftLine[];policy:DraftPolicy;recipient:string|null;issues:string[];conditions:string[]|null;selected:DraftSource|null;rateDate?:string|null};
const titles:Record<DocumentType,RegExp>={estimate:/견적\s*(준비|서|내역)/,purchase_order:/발주\s*(준비|서)|필요\s*자재/,invoice:/청구\s*(준비|서)/,delivery_statement:/거래\s*명세\s*(준비|서)/};
const digits=(s:string)=>s.replace(/,/g,'').replace(/원$/,'').trim();
function sourceRows(spans:DraftSource['spans']){
 const rows=new Map<string,{column:number;text:string;locator:string}[]>(),plain:DraftSource['spans']=[];
 for(const span of spans){const cell=/^(sheet:\d+)\/cell:([A-Z]+)(\d+)$/.exec(span.locator);if(!cell){plain.push(span);continue;}
  const column=[...cell[2]!].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);if(column>100)continue;
  const key=`${cell[1]}:${cell[3]}`,row=rows.get(key)??[];row.push({column,...span});rows.set(key,row);
 }
 for(const entries of rows.values()){const cells=Array.from({length:Math.max(...entries.map(e=>e.column))},()=> '');for(const e of entries)cells[e.column-1]=e.text;
  const populated=cells.filter(Boolean);const metadata=populated.length===2&&['마진','부가세','받는 곳','단가 기준일','현장조건','운반비','작성일'].includes(populated[0]??'');
  plain.push({locator:entries.map(e=>e.locator).join(','),text:metadata?`${populated[0]}:${populated[1]}`:cells.join(' | ')});
 }return plain;
}
/** Explicit labelled/table quantities are drafting candidates, never confirmed ledger facts. */
export function readDocumentSource(type:DocumentType,sources:DraftSource[]):DocumentSourceResult{
 sources=sources.map(s=>({...s,spans:sourceRows(s.spans)}));
 const selected=sources.filter(s=>s.spans.some(p=>titles[type].test(p.text)));
 const issues:string[]=[];const lines:DraftLine[]=[];
 const policy:DraftPolicy={marginBps:null,taxBps:null,taxMode:'unknown'};
 let recipient:string|null=null,asOf:string|null=null;let conditions:string[]|null=null;
 if(selected.length!==1){if(selected.length>1)issues.push('서로 다른 준비자료 중 사용할 자료');return {lines,policy,recipient,issues,conditions,selected:null};}
 const source=selected[0]!;if(source.partial)issues.push('끝까지 읽지 못한 준비자료');
 const sections=new Set(source.spans.flatMap(p=>(Object.entries(titles) as [DocumentType,RegExp][]).filter(([,pattern])=>pattern.test(p.text)).map(([key])=>key)));
 if(sections.size>1)issues.push('한 자료에 섞여 있는 문서별 품목');
 let header:string[]|null=null;const metadataSeen=new Map<string,string>();
 for(const span of source.spans){
  const metadata=/^(마진|부가세|받는\s*곳|단가\s*기준일|현장조건)\s*[:：]\s*(.*)$/.exec(span.text.trim());
  if(metadata){const key=metadata[1]!.replace(/\s/g,''),value=metadata[2]!;if(metadataSeen.has(key)&&metadataSeen.get(key)!==value)issues.push(`${metadata[1]}의 서로 다른 조건`);metadataSeen.set(key,value);}
  const condition=/^현장조건\s*[:：]\s*(.+)$/.exec(span.text.trim());if(condition)conditions=condition[1]!.trim()==='없음'?[]:condition[1]!.split(',').map(t=>t.trim()).filter(Boolean);
  const margin=/^마진\s*[:：]\s*(\d{1,2}(?:\.\d{1,2})?)\s*%$/.exec(span.text.trim());if(margin)policy.marginBps=Math.round(Number(margin[1])*100);
  const vat=/^부가세\s*[:：]\s*(별도|포함)\s*(\d{1,2}(?:\.\d{1,2})?)\s*%$/.exec(span.text.trim());if(vat){policy.taxMode=vat[1]==='별도'?'exclusive':'inclusive';policy.taxBps=Math.round(Number(vat[2])*100);}
  if(/^부가세\s*[:：]\s*해당없음$/.test(span.text.trim())){policy.taxMode='not_applicable';policy.taxBps=0;}
  const recipientMatch=/^받는\s*곳\s*[:：]\s*(.{1,120})$/.exec(span.text.trim());if(recipientMatch)recipient=recipientMatch[1]!;
  const dated=/^단가\s*기준일\s*[:：]\s*(\d{4}-\d{2}-\d{2})$/.exec(span.text.trim());if(dated)asOf=dated[1]!;
  const cells=span.text.split(/\t|\s*\|\s*/).map(t=>t.trim());
  const aliases:Record<string,string>={'품목':'품명','명칭':'품명','품목명':'품명','단가':'판매단가','공급단가':'판매단가'};
  if(cells.some(c=>['품명','품목','명칭','품목명'].includes(c))&&cells.some(c=>['수량','매입단가','단가'].includes(c)))for(let i=0;i<cells.length;i++)cells[i]=aliases[cells[i]!]??cells[i]!;
  if(cells.includes('품명')&&cells.includes('단위')&&(cells.includes('수량')||cells.includes('매입단가'))){header=cells;continue;}
  let values:Record<string,string>={};
  if(cells.some(c=>/^품명\s*[:：]/.test(c)))values=Object.fromEntries(cells.map(c=>{const m=/^([^:：]+)[:：](.*)$/.exec(c);return m?[m[1]!.trim(),m[2]!.trim()]:['',''];}));
  else if(header&&cells.length===header.length)values=Object.fromEntries(header.map((key,i)=>[key,cells[i]??'']));
  if(!values.품명)continue;
  const quantity=digits(values.수량??''),purchase=digits(values.매입단가??''),sales=digits(values.판매단가??'');
  if(!values.단위){issues.push(`${values.품명}의 단위`);continue;}
  lines.push({id:`${source.id}:${span.locator}`,description:values.품명.slice(0,180),spec:(values.규격??'').slice(0,120),unit:values.단위.slice(0,20),quantity:/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(quantity)?quantity:null,purchaseRate:/^(0|[1-9][0-9]{0,14})$/.test(purchase)?purchase:null,salesRate:/^(0|[1-9][0-9]{0,14})$/.test(sales)?sales:null,ordered:'0',sourceRevision:source.id,locator:span.locator,rateCurrent:false});
 }
 if(new Set(lines.map(l=>`${l.description}|${l.spec}|${l.unit}`)).size!==lines.length)issues.push('반복된 품목의 수량');
 return {lines,policy,recipient,issues,conditions,selected:source,rateDate:asOf};
}
export function documentIntent(text:string):DocumentType|null{
 if(/찾|보여|검색|열어/.test(text)||!/(준비|만들|작성|발행)/.test(text))return null;
 const types:DocumentType[]=[];if(/견적/.test(text))types.push('estimate');if(/발주/.test(text))types.push('purchase_order');if(/거래\s*명세/.test(text))types.push('delivery_statement');else if(/청구|계산서/.test(text))types.push('invoice');
 return types.length===1?types[0]!:null;
}
