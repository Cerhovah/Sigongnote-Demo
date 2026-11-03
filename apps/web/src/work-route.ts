import {useCallback,useEffect,useState} from "react";
import {flushSync} from "react-dom";
/** One screen per hash path. Native WebViews keep working because nothing needs a server route. */
export type WorkRoute={path:string[];raw:string;params:URLSearchParams};
export function readWorkRoute(hash:string):WorkRoute{
 const raw=hash.replace(/^#\/?/,"");
 const split=raw.indexOf("?"),pathname=split<0?raw:raw.slice(0,split);
 const params=new URLSearchParams(split<0?"":raw.slice(split+1));
 const path=pathname.split("/").filter(Boolean).map(part=>{try{return decodeURIComponent(part);}catch{return part;}});
 return {path:path.length?path:["today"],raw:raw||"today",params};
}
const reducedMotion=()=>typeof window!=="undefined"&&window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
type TransitionDocument=Document&{startViewTransition?:(update:()=>void)=>unknown};
/** Same-document view transition when the platform offers it; instant otherwise. */
export function withTransition(update:()=>void){
 const doc=document as TransitionDocument;
 if(!doc.startViewTransition||reducedMotion()||document.visibilityState!=="visible"){update();return;}
 try{doc.startViewTransition(()=>flushSync(update));}catch{update();}
}
/** How many in-app screens lie behind this one. A deep link or a typed address starts at 0. */
const depth=()=>{const value=(window.history.state as {workDepth?:unknown}|null)?.workDepth;return typeof value==="number"&&value>0?value:0;};
/**
 * Screens are history entries, so the on-screen back button and the phone's back key walk the same path.
 * `back` returns to the screen the owner actually came from; without one it opens the screen above.
 */
export function useWorkRoute(){
 const [route,setRoute]=useState(()=>readWorkRoute(typeof window==="undefined"?"":window.location.hash));
 useEffect(()=>{
  const sync=()=>{const next=readWorkRoute(window.location.hash);withTransition(()=>setRoute(current=>current.raw===next.raw?current:next));};
  window.addEventListener("popstate",sync);window.addEventListener("hashchange",sync);
  return()=>{window.removeEventListener("popstate",sync);window.removeEventListener("hashchange",sync);};
 },[]);
 const go=useCallback((path:string,options?:{replace?:boolean})=>{
  const hash=`#/${path.replace(/^\/+/,"")}`;
  if(window.location.hash===hash)return;
  const at=depth();
  if(options?.replace)window.history.replaceState({workDepth:at},"",hash);else window.history.pushState({workDepth:at+1},"",hash);
  const next=readWorkRoute(hash);withTransition(()=>setRoute(next));
 },[]);
 const back=useCallback((parent:string)=>{if(depth()>0)window.history.back();else go(parent,{replace:true});},[go]);
 return {route,go,back,canGoBack:depth()>0};
}
