import {useEffect,useRef,useState} from 'react';
import {EvidencePageSchema} from '@sigongnote/contracts';
import type {z} from 'zod';
import type {WorkClient} from './work-client.js';
import {Notice} from './work-shell.js';

type Page=z.infer<typeof EvidencePageSchema>;
type Span={text:string;locator:string;position?:Page['chunks'][number]['position']};
function pdfProgress(page:Page|null){
 const p=page?.coverage.pdf_processing;
 return p&&typeof p==='object'&&!Array.isArray(p)&&typeof p.state==='string'&&typeof p.pages_seen==='number'&&typeof p.pages_processed==='number'
  ?{state:p.state,total:p.pages_seen,read:p.pages_processed,job:typeof p.job_id==='string'?p.job_id:null,
    generation:typeof p.resume_generation==='number'?p.resume_generation:0,canResume:p.can_resume===true}:null;
}
export function evidencePlace(value:string,position?:Page['chunks'][number]['position']){
 const page=/^page:(\d+)/.exec(value),line=/^line:(\d+)/.exec(value),sheet=/^sheet:(\d+)\/cell:([A-Z]+\d+)/.exec(value),section=/^section:(\d+)/.exec(value);
 if(value.startsWith('message:body:'))return '문자 본문';
 if(value.startsWith('message:part:'))return '문자 첨부사진';
 if(value.startsWith('image:'))return '사진에서 읽은 내용';
 return page?`${page[1]}쪽${typeof position?.chunk_index==='number'?` · ${position.chunk_index+1}번째 묶음`:''}`:line?`${line[1]}번째 줄`:sheet?`시트 ${Number(sheet[1])+1} · ${sheet[2]}`:section?`본문 ${Number(section[1])+1}`:'문서에서 읽은 내용';
}
export function evidenceStatus(status:string,coverage:Page['coverage']){
 if(status==='complete')return '';
 if(status==='encrypted')return '암호가 걸려 있어요. 원문을 열어 확인해 주세요.';
 if(status==='unsupported')return '이 형식은 아직 읽지 못해요. 원문을 열어 확인해 주세요.';
 if(status==='quarantined')return '이 자료는 확인이 필요해 자동 읽기를 보류했어요.';
 if(status==='failed'||status==='corrupt')return '자료를 읽지 못했어요. 원문이 정상적으로 열리는지 확인해 주세요.';
 if(status==='partial'&&typeof coverage.next_page==='number'&&typeof coverage.pages_read==='number')return `${coverage.pages_read.toLocaleString()}쪽까지만 읽었어요. 나머지는 원문을 열어 확인해 주세요.`;
 return '읽지 못했거나 확인이 필요한 내용이 있어요. 원문도 함께 확인해 주세요.';
}
export function evidenceCoverage(coverage:Page['coverage']){
 return ([['pages','쪽'],['sheets','시트'],['sections','본문'],['populated_cells','내용 칸']] as const).flatMap(([key,label])=>{
  const read=coverage[`${key}_read`],total=coverage[`${key}_seen`];
  return typeof read==='number'&&typeof total==='number'?[`${total.toLocaleString()}${label} 중 ${read.toLocaleString()}${label} 읽음`]:[];
 }).join(' · ');
}
/** Only the visible page is rendered. Cancel, navigation and unmount fence late responses. */
export function WorkEvidence({client,id,fallback}:{client:WorkClient;id:string;fallback:Span[]}){
 const [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[blocked,setBlocked]=useState(false);
 const generation=useRef(0),requested=useRef<string|undefined>(undefined);
 const resume=async()=>{
  const p=pdfProgress(page);if(!p?.canResume||!p.job||busy)return;
  const token=++generation.current;setBusy(true);setError('');
  try{await client.request({route:'evidence.resume',id,command:JSON.stringify({job_id:p.job,resume_generation:p.generation})});
   if(token===generation.current)await load();
  }catch(e){if(token!==generation.current)return;
   if((e as {code?:string}).code==='VERSION_CONFLICT'){await load();return;}
   if(['NOT_FOUND','FORBIDDEN','UNAUTHENTICATED'].includes((e as {code?:string}).code??'')){setPage(null);setBlocked(true);setError('이 자료의 연결이 해제됐어요. 폴더·계정을 확인해 주세요.');}
   else setError('재개를 확인하지 못했어요. 다시 시도하거나 최신 상태를 확인해 주세요.');
  }finally{if(token===generation.current)setBusy(false);}
 };
 const load=async(cursor?:string,refresh=false)=>{
  const token=++generation.current;requested.current=cursor;setBusy(true);setError('');
  try{const result=EvidencePageSchema.parse(await client.request({route:'evidence.chunks',id,...(cursor?{cursor}:{})}));
   if(token!==generation.current)return;setPage(result);setBlocked(false);
  }catch(e){if(token!==generation.current)return;const code=(e as {code?:string}).code;
   if(refresh&&cursor&&code==='VERSION_CONFLICT'){await load();return;}
   if(code==='NOT_FOUND'||code==='FORBIDDEN'||code==='UNAUTHENTICATED'){setPage(null);setBlocked(true);setError('이 자료를 볼 수 있는 연결이 해제됐어요. 폴더·계정 설정을 확인해 주세요.');}
   else setError(code==='VERSION_CONFLICT'?'읽은 내용이 갱신됐어요. 읽은 내용 새로고침해 주세요.':'내용을 불러오지 못했어요. 다시 시도해 주세요.');
  }finally{if(token===generation.current)setBusy(false);}
 };
 // A different revision is mounted under its own key; polling stops on unmount/error/cancel.
 // biome-ignore lint/correctness/useExhaustiveDependencies: loading is scoped to this mounted client/revision, not page state.
 useEffect(()=>{void load();return()=>{generation.current++;};},[client,id]);
 const progress=pdfProgress(page),processing=Boolean(progress&&['queued','leased','retry_wait'].includes(progress.state));
 // biome-ignore lint/correctness/useExhaustiveDependencies: only the mounted pending PDF gets a bounded refresh timer.
 useEffect(()=>{if(!processing||busy||error||blocked)return;const timer=setTimeout(()=>void load(requested.current,true),4000);return()=>clearTimeout(timer);},[page,processing,busy,error,blocked,client,id]);
 const spans=blocked?[]:page?.chunks??fallback.slice(0,100);
 return <section className="read-content" aria-labelledby="read-title"><h2 id="read-title" className="section-title">읽은 내용</h2>
  {error?<Notice tone="warn" role="alert">{error}</Notice>:null}
  {page?<><p className="muted">{evidenceCoverage(page.coverage)||'읽은 부분의 원문 위치를 함께 표시해요.'}</p>
   {progress?<Notice tone="info">{processing?(progress.total?`${progress.total.toLocaleString()}쪽 중 ${progress.read.toLocaleString()}쪽까지 확인했어요. 나머지도 자동으로 이어 읽고 있어요. 이 화면을 닫아도 계속 처리해요.`:'읽을 차례를 기다리고 있어요. 이 화면을 닫아도 계속 처리해요.'):`${progress.read.toLocaleString()}쪽까지 처리 기록을 보관했어요. ${progress.canResume?'나머지 읽기를 다시 시작할 수 있어요.':'읽기가 멈췄어요. 연결 상태와 원문을 확인해 주세요.'}`}</Notice>:page.source_status!=='complete'?<Notice tone="info">{evidenceStatus(page.source_status,page.coverage)}</Notice>:null}
   {!progress&&(page.index_status==='legacy_excerpt_only'?<p className="muted">이전 처리의 일부 내용이에요. 전체 내용은 순서대로 다시 읽고 있어요.</p>:page.index_status==='pending'?<p className="muted">전체 내용을 읽을 차례를 기다리고 있어요.</p>:null)}
   <p role="status">{page.chunks.length?`${page.chunks[0]!.ordinal+1}–${page.chunks.at(-1)!.ordinal+1}번째 내용 · 전체 ${page.indexed_chunks.toLocaleString()}개`:'표시할 내용이 아직 없어요.'}</p></>:!blocked?<p className="muted">먼저 읽은 내용 일부를 표시해요.</p>:null}
  <div className="work-spans">{spans.map((span,index)=><p key={`${'ordinal' in span?span.ordinal:index}-${span.locator}`}><small>{evidencePlace(span.locator,'position' in span?span.position:undefined)}</small><br/>{span.text}</p>)}</div>
  {busy?<div className="stack"><p role="status">내용을 불러오고 있어요…</p><button type="button" className="button-quiet" onClick={()=>{generation.current++;setBusy(false);setError('요청을 중지했어요. 다시 확인할 수 있어요.');}}>불러오기 취소</button></div>:null}
  <div className="stack">{progress?.canResume&&!blocked?<button type="button" className="button-secondary" disabled={busy} onClick={()=>void resume()}>이어서 읽기 재개</button>:null}
   {page?.next_cursor&&!blocked?<button type="button" className="button-secondary" disabled={busy} onClick={()=>void load(page.next_cursor!)}>다음 내용 보기</button>:null}
   {!blocked?<button type="button" className="button-quiet" disabled={busy} onClick={()=>void load()}>읽은 내용 새로고침</button>:null}
   {error&&!blocked?<button type="button" className="button-secondary" disabled={busy} onClick={()=>void load(requested.current)}>다시 시도</button>:null}</div>
 </section>;
}
