import {useEffect,useState} from "react";
import {Icon,icons} from "./work-shell.js";
import type {WorkClient,WorkContext} from "./work-client.js";
import {platformOf} from "./work-platform.js";
export type DisplayPrefs={text:"normal"|"large"|"xlarge";contrast:boolean};
const key="sigongnote:display:v1";
function readPrefs():DisplayPrefs{try{const v=JSON.parse(localStorage.getItem(key)??"{}");return {text:["large","xlarge"].includes(v.text)?v.text:"normal",contrast:v.contrast===true};}catch{return {text:"normal",contrast:false};}}
/** Per-device reading comfort; the WebView may not pass the phone's own large-text or contrast settings. */
export function useDisplayPrefs(){
 const [prefs,setPrefs]=useState<DisplayPrefs>(readPrefs);
 useEffect(()=>{const root=document.documentElement;root.dataset.text=prefs.text;if(prefs.contrast)root.dataset.contrast="more";else delete root.dataset.contrast;try{localStorage.setItem(key,JSON.stringify(prefs));}catch{/* Private storage off: this session only. */}},[prefs]);
 return [prefs,setPrefs] as const;
}
export function DisplaySettings({prefs,onChange}:{prefs:DisplayPrefs;onChange:(p:DisplayPrefs)=>void}){
 const sizes:[DisplayPrefs["text"],string][]=[["normal","보통"],["large","크게"],["xlarge","아주 크게"]];
 return <div className="display-settings">
  <fieldset className="choice-group"><legend>글자 크기</legend>{sizes.map(([value,label])=><label key={value} className="choice"><input type="radio" name="text-size" checked={prefs.text===value} onChange={()=>onChange({...prefs,text:value})}/><span className={`size-sample size-${value}`}>{label} · 가나다 123</span></label>)}</fieldset>
  <fieldset className="choice-group"><legend>화면 선명도</legend><label className="choice"><input type="radio" name="contrast" checked={!prefs.contrast} onChange={()=>onChange({...prefs,contrast:false})}/><span>기본</span></label><label className="choice"><input type="radio" name="contrast" checked={prefs.contrast} onChange={()=>onChange({...prefs,contrast:true})}/><span>더 선명하게 (햇빛 아래)</span></label></fieldset>

 </div>;
}
type Row={id:string;label:string;help?:string;icon:string;onClick?:()=>void;href?:string};
function RowList({rows}:{rows:Row[]}){
 return <ul className="row-list row-list-plain">{rows.map(r=><li key={r.id}>{r.href?<a className="row" href={r.href}><span className="row-icon" aria-hidden="true"><Icon d={r.icon} size={24}/></span><span><strong>{r.label}</strong></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></a>:<button type="button" className="row" onClick={r.onClick}><span className="row-icon" aria-hidden="true"><Icon d={r.icon} size={24}/></span><span><strong>{r.label}</strong></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button>}</li>)}</ul>;
}
function Group({title,rows}:{title:string;rows:Row[]}){
 if(!rows.length)return null;
 return <section className="settings-group" aria-label={title}><h2 className="list-head-title">{title}</h2><RowList rows={rows}/></section>;
}
/** Frequent settings stay visible; optional management remains in one disclosure. */
export function MoreMenu({client,context,go,onGuide}:{client:WorkClient;context:WorkContext;go:(path:string)=>void;onGuide:()=>void}){
 const platform=platformOf(client);
 if(client.kind==='local'&&!context.cloud_connected)return <div className="settings"><Group title="이 PC" rows={[{id:'today',label:'자동 정리 현황',icon:icons.folder,onClick:()=>go('today')},{id:'connect',label:'자료 연결',icon:icons.folder,onClick:onGuide},{id:'display',label:'글자 크기·선명도',icon:icons.pen,onClick:()=>go('more/display')},{id:'site',label:'현장 추가',icon:icons.site,onClick:()=>go('materials/new')} ]}/></div>;
 const account:Row[]=[
  ...(platform==="android"?[{id:"settings",label:"계정",icon:icons.site,href:"/assets/index.html"}]:platform==="windows"?[{id:"settings",label:"계정",icon:icons.site,href:"https://sigongnote.work/settings"}]:[]),
 ];
 const connect:Row[]=[{id:"connect",label:"자료 연결",icon:icons.folder,onClick:onGuide}];
 const display:Row[]=[{id:"display",label:"글자 크기·선명도",help:"크게, 아주 크게, 더 선명하게",icon:"M4 19l6-14 6 14 M6.5 14h7 M17 11h4 M19 9v4",onClick:()=>go("more/display")}];
 const privacy:Row[]=[{id:"privacy",label:"사용 기록·동의",help:"기록 목적, 보관 기간, 동의와 삭제",icon:"M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7z",onClick:()=>go("more/privacy")}];
 const advanced:Row[]=[
  ...(platform==="windows"?[
   {id:"link-account",label:"로그인 방법 추가",icon:icons.plus,href:"https://sigongnote.work/link-account"},
   {id:"logout",label:"로그아웃",icon:icons.back,href:"https://sigongnote.work/logout"},
  ]:[]),
  {id:"folders",label:"연결한 폴더",icon:icons.folder,onClick:()=>go("folders")},
  {id:"aliases",label:"현장 별칭",icon:icons.site,onClick:()=>go("more/aliases")},
  {id:"archive",label:"과거 자료 보관·정리",help:"선택한 과거 자료 전체 읽기",icon:icons.doc,onClick:()=>go("archive")},
  {id:"memory",label:"기억한 판단",help:"다음에도 쓰기로 한 답과 자동 처리",icon:"M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M12 7v5l3 3",onClick:()=>go("more/memory")},
  ...(context.can_maintain?[{id:"status",label:"연결·보관 상태",help:"처리 대기, 마지막 수신, 문의 번호",icon:"M4 12h4l2-6 4 12 2-6h4",onClick:()=>go("more/status")}]:[]),
  ...(context.can_maintain?[{id:'learning',label:'판단 개선 기록',help:'관리자 전용 · 별도 동의와 오류 구분',icon:'M4 4h16v16H4z M8 8h8 M8 12h8',onClick:()=>go('more/learning')}]:[]),
  ...(context.can_maintain?[{id:'activity',label:'업무 처리·사용 기록',icon:icons.doc,onClick:()=>go('activity')}]:[]),

  ...(client.kind==="fixture"?[{id:"lab",label:"개발 확인실",help:"기능 보고와 의견 남기기",icon:icons.folder,href:`${location.protocol}//${location.hostname}:5188/`}]:[]),
 ];
 return <div className="settings">
  <Group title="계정" rows={account}/>
  <Group title="자료 연결" rows={connect}/>
  <Group title="화면" rows={display}/>
  <details className="quiet-details settings-advanced"><summary>더 보기</summary><RowList rows={[...privacy,...advanced]}/></details>
 </div>;
}
