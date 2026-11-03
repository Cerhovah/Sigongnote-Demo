import {useEffect,useRef,useState} from 'react';
import {EvidencePageSchema} from '@sigongnote/contracts';
import type {z} from 'zod';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
export type AudioProgress={phase:string;truncated?:boolean;reason?:string;durationMs?:number;chunks:number;completed:number;fixture?:boolean};
export type AudioCorrection={command_id:string;locator:string;text:string};
export const audioTime=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
export function audioStatus(audio:AudioProgress){
 if(audio.reason==='audio_result_invalid')return '전사는 받았지만 일부 결과를 읽지 못했어요. 원음은 보관했고 다시 전송하지 않았어요.';
 const reasons:Record<string,string>={audio_existing_wait:'같은 녹음을 이미 읽고 있어요. 끝나면 결과를 함께 사용해요.',audio_provider_rejected:'음성 서비스가 요청을 받지 않았어요. 잠시 뒤 다시 확인해요.',audio_duplicate_held:'같은 녹음의 이전 처리에 확인이 필요해요. 원음과 읽은 내용은 보존했어요.',audio_empty:'말소리를 읽을 수 없는 녹음이에요. 원음으로 확인해 주세요.',audio_worker_stopped:'음성 처리가 중단되었어요. 원음과 이미 읽은 내용은 남아 있어요. 연결 상태 확인이 필요해요.',audio_timeline_gap:'녹음 시간이 연속되지 않아요. 원음으로 확인해 주세요.',audio_provider_required:'녹음을 보관했어요. 음성 서비스 연결을 기다려요.',audio_budget_wait:'음성 처리 한도 또는 같은 녹음의 앞선 처리 결과를 기다려요. 다음 차례에 이어서 확인해요.',audio_submission_unknown:'전송 결과를 확인하지 못했어요. 중복 비용을 막기 위해 다시 보내지 않았어요.',audio_chunks_incomplete:'읽지 못한 구간이 있어요. 읽은 내용과 원음은 남아 있어요.',audio_duration_limit:'2시간을 넘는 녹음이에요. 원본은 보관했어요.',audio_size_limit:'200MB를 넘는 녹음이에요.',audio_decode_failed:'녹음을 읽지 못했어요. 원음으로 확인해 주세요.',audio_streams_unsupported:'지원하는 음성 파일인지 확인이 필요해요.',audio_provider_changed:'처리하던 음성 서비스 연결을 확인해 주세요.'};
 return audio.reason?(reasons[audio.reason]??'음성 처리 상태를 확인해 주세요.'):audio.phase==='complete'?'녹음을 글로 읽었어요. 잘못 들은 내용은 원음과 비교해 주세요.':audio.phase==='partial'?'녹음 일부를 읽었어요. 빠진 구간은 원음으로 확인해 주세요.':`${audio.chunks}개 구간 중 ${audio.completed}개를 읽었어요.`;
}
export function WorkAudio({client,id,progress,spans,corrections,canCorrect,onSaved,onOriginal}:{client:WorkClient;id:string;progress:AudioProgress;spans:{text:string;locator:string;speaker?:string|null}[];corrections:AudioCorrection[];canCorrect:boolean;onSaved:()=>void;onOriginal:(seconds?:number)=>void}){
 const [editing,setEditing]=useState<string|null>(null),[expected,setExpected]=useState<string|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [page,setPage]=useState<z.infer<typeof EvidencePageSchema>|null>(null),[loading,setLoading]=useState(false),[blocked,setBlocked]=useState(false);
 const generation=useRef(0),requested=useRef<string|undefined>(undefined);
 const pendingCorrection=useRef<{key:string;command:string}|null>(null);
 async function load(cursor?:string){const token=++generation.current;requested.current=cursor;setLoading(true);setError('');
  try{const result=EvidencePageSchema.parse(await client.request({route:'evidence.chunks',id,...(cursor?{cursor}:{})}));if(token===generation.current){setPage(result);setBlocked(false);}}
  catch(e){if(token!==generation.current)return;const code=(e as {code?:string}).code;if(code==='VERSION_CONFLICT'&&cursor){await load();return;}
   if(['NOT_FOUND','FORBIDDEN','UNAUTHENTICATED'].includes(code??'')){setPage(null);setBlocked(true);setEditing(null);setError('녹음 연결이 해제됐어요. 폴더·계정을 확인해 주세요.');}
   else setError('전사를 불러오지 못했어요. 다시 확인해 주세요.');
  }finally{if(token===generation.current)setLoading(false);}
 }
 const correctionVersion=corrections.map(c=>c.command_id).join(',');
 // biome-ignore lint/correctness/useExhaustiveDependencies: refresh a mounted revision only when completed transcript/correction changes.
 useEffect(()=>{void load();return()=>{generation.current++;};},[client,id,progress.completed,correctionVersion]);
 const visible=blocked?[]:page?.chunks.map(c=>({text:c.text,locator:c.locator,speaker:typeof c.position.speaker==='string'?c.position.speaker:null,original:typeof c.position.original_text==='string'?c.position.original_text:undefined}))??spans.slice(0,100).map(c=>({...c,original:undefined}));
 async function save(){if(!editing||!text.trim()||busy)return;setBusy(true);
  const body={revision_id:id,locator:editing,text,expected_id:expected},key=JSON.stringify(body);
  if(pendingCorrection.current?.key!==key)pendingCorrection.current={key,command:JSON.stringify({...body,client_command_id:workId()})};
  try{await client.request({route:'audio.correct',command:pendingCorrection.current.command});pendingCorrection.current=null;setEditing(null);onSaved();}
  catch(e){const code=(e as {code?:string}).code;
   if(['NOT_FOUND','FORBIDDEN','UNAUTHENTICATED'].includes(code??'')){setPage(null);setBlocked(true);setEditing(null);setError('녹음 연결이 해제됐어요. 폴더·계정을 확인해 주세요.');}
   else setError(code==='VERSION_CONFLICT'?'다른 기기에서 고친 내용이 있어요. 적은 글은 남겨뒀어요. 글을 확인한 뒤 취소하고 최신 내용을 불러와 주세요.':'저장을 확인하지 못했어요. 적은 글은 남겨뒀으니 다시 저장해 주세요.');
  }finally{setBusy(false);}}
 return <section className="audio-transcript"><h3>녹음에서 읽은 내용</h3><p role="status">{audioStatus(progress)}</p>{progress.fixture?<p>개발용 합성 음원과 모의 전사예요. 실제 음성 인식 결과가 아닙니다.</p>:null}<p className="muted">화자 표시는 이름이 아니에요. 숫자·부정·조건은 원음을 확인해 주세요. 고친 글은 별도로 남으며 금액이나 지급을 확정하지 않아요.</p>{error?<p role="alert">{error}</p>:null}
 {page?<p role="status">{page.chunks.length?`${page.chunks[0]!.ordinal+1}–${page.chunks.at(-1)!.ordinal+1}번째 내용 · 전체 ${page.indexed_chunks.toLocaleString()}개`:'아직 읽은 내용이 없어요.'}</p>:null}
 {page?.index_status==='legacy_excerpt_only'?<p>이전 전사의 일부예요. 저장한 전체 전사를 정리한 뒤 고칠 수 있어요.</p>:null}
 {corrections.length?<p>고친 구간과 관련 문맥을 업무에 반영하는 데 시간이 걸릴 수 있어요. 연결이나 처리 한도를 기다리는 동안 해당 관측은 보류되며, 영향 없는 기록은 유지해요.</p>:null}
 {visible.map(span=>{const match=/^audio:(\d+)-(\d+)(?::\d+)?$/.exec(span.locator);if(!match)return null;const correction=corrections.find(c=>c.locator===span.locator);return <article className="focus-block" key={span.locator}><button type="button" onClick={()=>onOriginal(Number(match[1])/1000)}>원음 {audioTime(Number(match[1]))}–{audioTime(Number(match[2]))} 확인</button>{client.kind==='native'?<small>열린 재생 앱에서 위 시간으로 이동해 주세요.</small>:null}{span.speaker?<p>화자 {span.speaker} · 신원 미확인</p>:null}<p>{span.original??span.text}</p>{correction?<p><strong>고친 내용</strong> {correction.text}</p>:span.original?<p><strong>고친 내용</strong> {span.text}</p>:null}{canCorrect&&page?.index_status==='complete'&&editing!==span.locator?<button type="button" onClick={()=>{setEditing(span.locator);setExpected(correction?.command_id??null);setText(correction?.text??span.text);setError('');}}>잘못 들은 내용 고치기</button>:null}{editing===span.locator?<form onSubmit={e=>{e.preventDefault();void save();}}><label>원음에서 확인한 내용<textarea value={text} maxLength={1000} onChange={e=>setText(e.target.value)}/></label><button type="submit" disabled={busy||!text.trim()}>고친 내용 저장</button><button type="button" disabled={busy} onClick={()=>setEditing(null)}>취소</button></form>:null}</article>;})}
 {loading?<p role="status">전사를 불러오고 있어요…</p>:null}
 {!blocked?<div className="stack">{page?.next_cursor?<button type="button" disabled={loading||busy||editing!==null} onClick={()=>void load(page.next_cursor!)}>다음 전사 보기</button>:null}<button type="button" disabled={loading||busy||editing!==null} onClick={()=>void load()}>처음부터 다시 확인</button>{error?<button type="button" disabled={loading||busy} onClick={()=>void load(requested.current)}>다시 시도</button>:null}</div>:null}</section>;
}
