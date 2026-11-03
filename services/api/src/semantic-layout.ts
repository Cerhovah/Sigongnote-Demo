import {maskSensitive,type SemanticEvidenceChunk} from '@sigongnote/domain';

export type SourceChunk={ordinal:number;text:string;locator:string;content_hash:string;position?:{speaker?:unknown}};
export function tableRow(locator:string):string|null{
 const sheet=/^(sheet:\d+)\/cell:[A-Z]+(\d+)$/.exec(locator);
 if(sheet)return `${sheet[1]}/row:${sheet[2]}`;
 const table=/^(.*\/table:\d+)\/cell:(\d+),\d+$/.exec(locator);
 return table?`${table[1]}/row:${table[2]}`:null;
}
export function semanticLayout(chunks:SemanticEvidenceChunk[]){
 const rows=new Map<string,number[]>();
 for(const chunk of chunks){const key=tableRow(chunk.locator);if(key){const row=rows.get(key)??[];row.push(chunk.ordinal);rows.set(key,row);}}
 return [...rows].map(([row,ordinals])=>({row,ordinals}));
}
export function semanticData(context:{modelVersion:string;promptVersion:string;indexJobId:string;chunks:SemanticEvidenceChunk[]}){
 return {schemaVersion:'semantic-candidates-v1',modelVersion:context.modelVersion,promptVersion:context.promptVersion,indexJobId:context.indexJobId,
  chunks:context.chunks.map(c=>({ordinal:c.ordinal,contentHash:c.contentHash,locator:c.locator,text:maskSensitive(c.text),...(c.speakerLabel?{speakerLabel:maskSensitive(c.speakerLabel)}:{}),...(c.contextOnly?{contextOnly:true}:{})})),
  tableRows:semanticLayout(context.chunks)};
}
/** Contiguous progress, with complete adjacent rows when they fit. Context is never new work. */
export function selectSemanticWindow(primary:SourceChunk[],history:SourceChunk[]=[]){
 const selected:SourceChunk[]=[];
 const earlier=history.filter(c=>c.ordinal<(primary[0]?.ordinal??0));
 const audio=primary[0]?.locator.startsWith('audio:');
 const context=audio?earlier.filter(c=>c.locator.startsWith('audio:')).slice(-2):[...new Map([...earlier.filter(c=>c.ordinal<4),...earlier.filter(c=>/품\s*명|규\s*격|단\s*위|수\s*량|단\s*가|금\s*액|재료비|노무비|견\s*적\s*서|거래\s*명세/.test(c.text)).slice(-20)].map(c=>[c.ordinal,c])).values()];
 const toChunks=(rows:SourceChunk[],contextOnly=false)=>rows.map(c=>({ordinal:c.ordinal,text:c.text,locator:c.locator,contentHash:c.content_hash,active:true,contextOnly,...(typeof c.position?.speaker==='string'?{speakerLabel:c.position.speaker}:{})}));
 const fits=(rows:SourceChunk[])=>Buffer.byteLength(JSON.stringify(semanticData({modelVersion:'x'.repeat(160),promptVersion:'x'.repeat(160),indexJobId:'x'.repeat(36),chunks:[...toChunks(rows),...toChunks(context,true)]})))<=30000;
 while(context.length&&!fits(primary.slice(0,1)))context.shift();
 for(let i=0;i<primary.length;){
  const row=tableRow(primary[i]!.locator);let end=i+1;
  if(row)while(end<primary.length&&tableRow(primary[end]!.locator)===row)end++;
  const group=primary.slice(i,end);
  if(selected.length+group.length>64||!fits([...selected,...group])){
   if(!selected.length)for(const chunk of group){if(selected.length>=64||!fits([...selected,chunk]))break;selected.push(chunk);}
   break;
  }
  selected.push(...group);i=end;
 }
 return {primary:selected,context,chunks:[...toChunks(selected),...toChunks(context,true)]};
}
