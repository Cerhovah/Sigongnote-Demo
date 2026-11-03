import {useEffect,useRef,useState} from "react";
import type {WorkClient} from "./work-client.js";
import {workId} from './work-id.js';
const steps=[
 {target:"#work-folder-entry",title:"업무 폴더를 함께 연결해 주세요",text:"폴더 하나 또는 여러 현장 폴더가 모인 상위 위치를 선택하세요. 현장·공통·미확정을 한 번에 확인하면 새 자료를 계속 읽어요."},
 {target:"#today-next",title:"필요한 판단만 확인하세요",text:"확인할 일이 여기에 나와요. 질문에 답하면 관련 업무에 함께 반영해요."},
 {target:"#work-microphone",title:"말하거나 글로 요청하세요",text:"현장을 고르고 ‘자료 찾아줘’, ‘견적서 준비해줘’처럼 요청하세요. 음성은 연결 상태에 따라 지원돼요."},
 {target:"#nav-materials",title:"현장별 자료를 찾아보세요",text:"자료에서 현장을 고르면 약속, 도면·자재, 납품·작업, 청구·지급, 점검·하자로 나눠 볼 수 있어요."},
 {target:"#nav-documents",title:"새 문서를 확인하고 보내세요",text:"견적·발주·청구 초안의 받는 곳과 금액을 확인하세요. 발행한 문서는 다시 열고 공유할 수 있어요."},
];
type Progress={step:number;completed:boolean;showAgain:boolean};
function stored(key:string):Progress|null{try{const v=JSON.parse(window.localStorage.getItem(key)??"null");return v&&Number.isInteger(v.step)&&v.step>=-1&&v.step<steps.length&&typeof v.completed==="boolean"&&typeof v.showAgain==="boolean"?v:null;}catch{return null;}}
/** Five device steps coexist with the unchanged server's three-phase guide contract. */
export function WorkGuide({client,replay,scope="default",onClose,onStart}:{client:WorkClient;replay:number;scope?:string;onClose:()=>void;onStart?:()=>void}){
 const progressKey=`sigongnote:guide:v2:${scope}`;
 const [step,setStep]=useState<number|null>(null),[hideNext,setHideNext]=useState(true),[rect,setRect]=useState<DOMRect|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),previous=useRef<HTMLElement|null>(null),saves=useRef<Promise<unknown>>(Promise.resolve()),serverCompleted=useRef(false);
 const historyId=useRef(workId()),active=useRef(false);
 const begin=useRef(onStart);begin.current=onStart;
 function persist(next:number,completed:boolean){
  try{window.localStorage.setItem(progressKey,JSON.stringify({step:next,completed,showAgain:!hideNext}));}catch{/* A blocked store must not block work. */}
  saves.current=saves.current.catch(()=>{}).then(()=>client.request({route:"guide.save",step:completed||serverCompleted.current?2:Math.min(2,Math.max(0,Math.floor(next/2))),completed:completed||serverCompleted.current}));void saves.current.catch(()=>{});
 }
 useEffect(()=>{let live=true;const local=stored(progressKey);let intro=false;try{intro=window.sessionStorage.getItem("sigongnote:intro-shown")==="1";window.sessionStorage.removeItem("sigongnote:intro-shown");}catch{/* Continue without storage. */}
  // The old server completion is not proof that this device has seen the new guide.
  saves.current=client.request<{completed:boolean}>({route:"guide.read"}).then(server=>{if(live)serverCompleted.current=server.completed===true;}).catch(()=>{});
  const next=local?(local.completed&&!local.showAgain?null:local.completed?-1:local.step):intro?0:-1;
  if(next!==null&&next>=0)begin.current?.();setHideNext(local?!local.showAgain:true);setStep(next);
  return()=>{live=false;};
 },[client,progressKey]);
 useEffect(()=>{if(replay>0){setHideNext(true);setStep(-1);}},[replay]);
 useEffect(()=>{
  if(step===null)return;
  // One same-address entry gives browser and native Back a way to dismiss even the first screen.
  // Starting the spotlight may replace the address; re-establish the guard at that address.
  if(window.history.state?.workGuide!==historyId.current)window.history.pushState({...window.history.state,workGuide:historyId.current},'',window.location.href);
  active.current=true;const d=dialog.current;if(d&&!d.open){previous.current=document.activeElement as HTMLElement;d.showModal?.();}
  d?.querySelector<HTMLElement>("#guide-title")?.focus({preventScroll:true});const body=d?.querySelector<HTMLElement>(".welcome-body,.guide-copy");if(body)body.scrollTop=0;
  let target:Element|null=null;const measure=()=>{const next=step<0?null:document.querySelector(steps[step]?.target??"#main-content");if(next!==target){target=next;target?.scrollIntoView?.({block:"center"});}const value=target?.getBoundingClientRect()??null;setRect(old=>old?.left===value?.left&&old?.top===value?.top&&old?.width===value?.width&&old?.height===value?.height?old:value);};
  measure();const observer=typeof window.MutationObserver!=="undefined"?new window.MutationObserver(measure):null;observer?.observe(document.getElementById("root")??document.body,{childList:true,subtree:true});
  window.addEventListener("resize",measure);window.addEventListener("scroll",measure,true);const frame=window.requestAnimationFrame(measure);
  return()=>{observer?.disconnect();window.cancelAnimationFrame(frame);window.removeEventListener("resize",measure);window.removeEventListener("scroll",measure,true);};
 },[step]);
 function close(completed:boolean,fromBack=false){active.current=false;persist(step??-1,completed);dialog.current?.close?.();setStep(null);const focus=previous.current?.isConnected?previous.current:document.getElementById('screen-title');focus?.focus();onClose();if(!fromBack&&window.history.state?.workGuide===historyId.current)window.history.back();}
 const dismiss=useRef(()=>{});dismiss.current=()=>{if(active.current)close(step!==null&&step<0,true);};
 useEffect(()=>{const pop=()=>dismiss.current();window.addEventListener('popstate',pop);return()=>{window.removeEventListener('popstate',pop);if(window.history.state?.workGuide===historyId.current){const {workGuide:_,...rest}=window.history.state;window.history.replaceState(rest,'',window.location.href);}};},[]);
 function advance(next:number){persist(next,false);setStep(next);}
 if(step===null)return null;const welcome=step<0,item=steps[step];
 return <dialog className={`work-guide${welcome?" is-welcome":""}`} ref={dialog} aria-labelledby="guide-title" onCancel={e=>{e.preventDefault();close(welcome);}}>
  {!welcome&&rect?<div className="guide-highlight" style={{left:rect.left-5,top:rect.top-5,width:rect.width+10,height:rect.height+10}}/>:<div className="guide-shade"/>}
  <section className={`guide-panel${welcome?" guide-center":rect&&rect.top<window.innerHeight/2?" at-bottom":""}`}>
   {welcome?<><h2 id="guide-title" tabIndex={-1}>시공노트, 이렇게 쓰세요</h2><div className="welcome-body">
    <ol className="welcome-features"><li><span>1</span><div><strong>자료 자동 정리</strong><small>상위 위치의 여러 업무 폴더를 함께 연결하세요</small></div></li><li><span>2</span><div><strong>필요한 판단만 확인</strong><small>질문에 답하면 업무에 반영해요</small></div></li><li><span>3</span><div><strong>새 견적·발주·청구 문서</strong><small>자료를 모아 초안을 준비해요</small></div></li></ol>
    <label className="welcome-preference"><input type="checkbox" checked={hideNext} onChange={e=>setHideNext(e.target.checked)}/>다음부터 시작 안내 숨기기</label>
    </div><div className="welcome-actions"><button type="button" className="button-primary" data-guide-next onClick={()=>{begin.current?.();advance(0);}}>사용법 함께 보기</button><button type="button" className="button-quiet" onClick={()=>close(true)}>바로 시작하기</button></div></>:<>
    <header className="guide-heading"><p className="progress-text">사용법 <strong>{step+1}</strong> / {steps.length}</p><h2 id="guide-title" tabIndex={-1}>{item?.title}</h2></header><div className="guide-copy"><p>{item?.text}</p></div>
    <div className="guide-actions"><button type="button" className="button-primary" data-guide-next onClick={()=>step===steps.length-1?close(true):advance(step+1)}>{step===steps.length-1?"직접 해보기":"다음"}</button><button type="button" className="button-quiet" onClick={()=>close(false)}>안내 닫기</button></div>
   </>}
  </section>
 </dialog>;
}
