import {workId} from "./work-id.js";
import {useCallback,useEffect,useRef,useState} from "react";
import type {WorkClient,VoiceEvent} from "./work-client.js";
import {Icon,icons} from "./work-shell.js";
type Status={enabled:boolean;consented:boolean;provider:string|null;consent_version:"short-voice-v1"};
type Result={state:string;transcript:string|null};
export function WorkVoice({client,disabled,inputId,onText,onRecognized,label="말로 요청하기",tone="secondary",buttonId="work-microphone"}:{client:WorkClient;disabled:boolean;inputId:string;onText:(text:string)=>void;onRecognized:(id:string)=>void;label?:string;tone?:"primary"|"secondary";buttonId?:string}){
 const [phase,setPhase]=useState("idle"),[message,setMessage]=useState(""),[consent,setConsent]=useState<Status|null>(null);
 const current=useRef<string|null>(null),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),nativeCancel=useRef<(()=>void)|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),live=useRef(true);
 const callbacks=useRef({onText,onRecognized});callbacks.current={onText,onRecognized};
 const release=useCallback(()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;const r=recorder.current;recorder.current=null;if(r?.state==="recording")r.stop();stream.current?.getTracks().forEach(t=>{t.stop();});stream.current=null;},[]);
 const cancel=useCallback((silent=false)=>{const id=current.current,isNative=Boolean(nativeCancel.current);current.current=null;nativeCancel.current?.();nativeCancel.current=null;release();if(id&&!isNative)void client.request({route:"voice.cancel",id}).catch(()=>{});if(live.current&&id){setConsent(null);setPhase("idle");setMessage(silent?"":"음성 입력을 취소했어요. 적어둔 글은 남아 있어요.");}},[client,release]);
 useEffect(()=>{live.current=true;const hide=()=>{if(document.visibilityState==="hidden")cancel();};document.addEventListener("visibilitychange",hide);return()=>{live.current=false;cancel();document.removeEventListener("visibilitychange",hide);};},[cancel]);
 useEffect(()=>{if(disabled){cancel(true);setMessage("");}},[disabled,cancel]);
 function finish(id:string,text:string){if(current.current!==id||!live.current)return;if(!text.trim()||text.length>2000){fail(id,"말씀을 확인하지 못했어요. 글로 계속할 수 있어요.");return;}current.current=null;nativeCancel.current=null;release();setPhase("idle");setMessage("말씀을 입력칸에 적었어요. 숫자·이름과 선택한 현장을 고친 뒤 기존 요청 버튼을 눌러 주세요.");callbacks.current.onText(text);callbacks.current.onRecognized(id);document.getElementById(inputId)?.focus();document.getElementById(inputId)?.scrollIntoView?.({block:"center"});}
 function fail(id:string,text:string){if(current.current!==id||!live.current)return;current.current=null;release();setPhase("idle");setMessage(text);}
 async function record(status:Status){const id=workId();current.current=id;setConsent(null);setPhase("preparing");setMessage("마이크를 준비하고 있어요.");
  try{
   if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==="undefined")throw new Error("마이크는 앱 또는 HTTPS로 연결한 화면에서 사용할 수 있어요. 글로 계속할 수 있어요.");
   const mime=["audio/webm;codecs=opus","audio/ogg;codecs=opus","audio/webm"].find(m=>MediaRecorder.isTypeSupported(m));if(!mime)throw new Error("이 화면에서는 지원하는 녹음 형식이 없어요. 글로 계속해 주세요.");
   const input=await navigator.mediaDevices.getUserMedia({audio:true});if(current.current!==id){input.getTracks().forEach(t=>{t.stop();});return;}stream.current=input;
   const r=new MediaRecorder(input,{mimeType:mime,audioBitsPerSecond:32000});recorder.current=r;const chunks:Blob[]=[];let bytes=0;
   r.ondataavailable=e=>{if(current.current!==id)return;bytes+=e.data.size;if(bytes>786432){fail(id,"음성이 길어졌어요. 짧게 다시 말하거나 글로 입력해 주세요.");return;}chunks.push(e.data);};
   r.onerror=()=>fail(id,"마이크를 쓰지 못했어요. 브라우저·앱 권한을 확인하거나 글로 입력해 주세요.");
   r.onstop=async()=>{if(current.current!==id)return;release();setPhase("transcribing");setMessage("말씀을 글로 바꾸고 있어요…");try{
    const blob=new Blob(chunks,{type:mime});if(!blob.size||blob.size>786432)throw new Error();
    const audio=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");reader.readAsDataURL(blob);});if(current.current!==id)return;
    let result=await client.request<Result>({route:"voice.transcribe",id,mime:mime.startsWith("audio/ogg")?"audio/ogg":"audio/webm",audio,consent_version:status.consent_version});
    for(let n=0;n<15&&result.state==="working"&&current.current===id;n++){await new Promise(resolve=>setTimeout(resolve,1000));result=await client.request<Result>({route:"voice.result",id});}
    if(result.state==="completed"&&result.transcript)finish(id,result.transcript);else fail(id,result.state==="busy"?"다른 음성을 처리하고 있어요. 잠시 뒤 다시 말하거나 글로 요청해 주세요.":result.state==="limited"?"오늘 음성 사용 한도에 도달했어요. 글로는 계속 요청할 수 있어요.":"음성을 끝까지 확인하지 못했어요. 글로 이어서 요청하거나 다시 말해 주세요.");
   }catch{fail(id,"음성 연결이 끊겼어요. 적어둔 글로 계속할 수 있어요.");}};
   r.start(250);setPhase("listening");setMessage("말씀하세요. 최대 30초까지 들어요.");timer.current=setTimeout(()=>r.state==="recording"&&r.stop(),29000);
  }catch(error){fail(id,error instanceof Error&&error.message.startsWith("마이크는")?error.message:"마이크 권한이나 연결을 확인해 주세요. 글로 계속할 수 있어요.");}
 }
 async function server(){const attempt=workId();current.current=attempt;try{const status=await client.request<Status>({route:"voice.status"});if(!live.current||current.current!==attempt)return;
  if(!status.enabled){current.current=null;setPhase("idle");setMessage("이 기기의 음성 인식 또는 서버 음성 연결이 아직 준비되지 않았어요. 글로 요청할 수 있어요.");return;}
  if(!status.consented){current.current=null;setPhase("idle");setConsent(status);return;}await record(status);
 }catch{if(current.current!==attempt||!live.current)return;current.current=null;setPhase("idle");setMessage("음성 연결 상태를 확인하지 못했어요. 글로 계속할 수 있어요.");}}
 function start(){if(current.current||disabled)return;setMessage("");setPhase("preparing");
  if(client.startVoice){const native=client.startVoice((event:VoiceEvent)=>{if(!live.current||current.current!==event.id)return;
   if(event.phase==="partial"){setPhase("listening");setMessage(event.text?`듣고 있어요: ${event.text}`:"말씀을 듣고 있어요…");}
   if(event.phase==="final")finish(event.id,event.text??"");
   if(event.phase==="error"){current.current=null;nativeCancel.current=null;if(event.code==="voice_unavailable"||event.code==="language_unavailable")void server();else {setPhase("idle");setMessage(event.code==="permission_denied"?"마이크 권한이 필요해요. 설정에서 허용하거나 글로 입력해 주세요.":"말씀을 확인하지 못했어요. 다시 말하거나 글로 고쳐 주세요.");}}
  });current.current=native.id;nativeCancel.current=native.cancel;setMessage("마이크를 준비하고 있어요.");}
  else void server();
 }
 return <div className={`work-voice is-${phase}${tone==="primary"?" is-primary":""}`}><div className="voice-actions"><button id={buttonId} type="button" className="voice-button" disabled={disabled||phase!=="idle"} onClick={start}><Icon d={icons.mic} size={32}/><span>{phase==="idle"?label:phase==="listening"?"듣고 있어요":phase==="transcribing"?"글로 바꾸는 중":"준비 중"}</span></button>{phase==="listening"&&recorder.current?<button type="button" className="button-secondary" onClick={()=>recorder.current?.stop()}>말하기 완료</button>:null}{phase!=="idle"?<button type="button" className="button-quiet" onClick={()=>cancel()}>음성 취소</button>:null}</div><p role="status" className="voice-message">{message}</p>
 {consent?<section className="card voice-consent" aria-label="음성 처리 안내"><p>짧은 음성을 {consent.provider}에 보내 글로 바꿉니다. 앱에는 음성 파일을 보관하지 않고, 인식한 글을 확인·수정한 뒤 요청해요. 마이크를 누를 때만 녹음합니다.</p><div className="stack"><button type="button" className="button-secondary" onClick={()=>{const attempt=workId();current.current=attempt;setConsent(null);setPhase("preparing");void client.request({route:"voice.consent",allowed:true,consent_version:consent.consent_version}).then(()=>{if(live.current&&current.current===attempt)return record(consent);},()=>{if(live.current&&current.current===attempt){current.current=null;setPhase("idle");setMessage("음성 동의를 저장하지 못했어요.");}});}}>동의하고 말하기</button><button type="button" className="button-secondary" onClick={()=>setConsent(null)}>글로 입력</button></div></section>:null}</div>;
}
