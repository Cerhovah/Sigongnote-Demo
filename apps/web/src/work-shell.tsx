import {useEffect,useRef,type ReactNode} from "react";
export type WorkTab="today"|"materials"|"documents"|"more";
export function Icon({d,size=28}:{d:string;size?:number}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d}/></svg>;}
export const icons={
 mic:"M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0 M12 18v3",
 pen:"M4 20h4L19 9l-4-4L4 16z M13 7l4 4",
 back:"M15 5l-7 7 7 7",
 next:"M9 5l7 7-7 7",
 check:"M5 12l5 5 9-10",
 search:"M11 4a7 7 0 1 1 0 14a7 7 0 0 1 0-14z M20 20l-4-4",
 doc:"M6 3h9l4 4v14H6z M14 3v5h5",
 share:"M12 3v12 M7 8l5-5 5 5 M5 14v6h14v-6",
 plus:"M12 5v14 M5 12h14",
 send:"M12 19V5 M5 12l7-7 7 7",
 photo:"M3 5h18v14H3z M3 15l5-5 5 5 3-3 5 5 M16 9h.01",
 camera:"M3 7h4l2-3h6l2 3h4v13H3z M16 13a4 4 0 1 0-8 0 4 4 0 0 0 8 0",
 file:"M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h7",
 folder:"M3 7h7l2 2h9v11H3z M3 7V4h6l2 3",
 message:"M4 5h16v11H9l-5 4z",
 phone:"M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
 site:"M3 21h18 M5 21V9l7-5 7 5v12 M10 21v-7h4v7",
 calendar:"M5 4h14v17H5z M9 2v4 M15 2v4 M5 9h14",
 question:"M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14 M12 17v.5",
};
/** Korean reading of a won amount, e.g. 1375000 → "137만 5천원", shown under large totals. */
export function readWon(value:string|null):string{
 if(value===null||!/^-?\d+$/.test(value))return "";
 let n=BigInt(value);const negative=n<0n;if(negative)n=-n;if(n===0n)return "0원";
 const units:[bigint,string][]=[[1000000000000n,"조"],[100000000n,"억"],[10000n,"만"]];const parts:string[]=[];
 for(const [size,name] of units){if(n>=size){parts.push(`${(n/size).toLocaleString("ko-KR")}${name}`);n%=size;}}
 if(n>=1000n){parts.push(`${n/1000n}천`);n%=1000n;}if(n>0n)parts.push(`${n}`);
 return `${negative?"-":""}${parts.join(" ")}원`;
}
/** One short line: brand, company, and only a connection problem. A healthy connection is not news. */
export function WorkShell({company,badge,status,children}:{company:string;badge?:string;status:ReactNode;children:ReactNode}){
 return <div className="work-app">
  <button type="button" className="skip-link" onClick={()=>document.getElementById("main-content")?.focus()}>본문으로 바로 가기</button>
  <header className="work-top"><span className="work-brand"><span className="brand-mark" aria-hidden="true">시</span><span className="brand-name">시공노트</span></span>{company!=="시공노트"?<span className="work-company">{company}</span>:null}{badge?<span className="work-badge">{badge}</span>:null}{status}</header>
  <main id="main-content" tabIndex={-1}>{children}</main>
 </div>;
}
/** A single-purpose screen: one heading, an optional small aside (such as today's date), one flow, one main action in thumb reach. */
export function Screen({title,lead,aside,back,children,focusKey,className}:{title:ReactNode;lead?:ReactNode;aside?:ReactNode;back?:{label:string;onBack:()=>void};children?:ReactNode;focusKey?:string;className?:string}){
 const heading=useRef<HTMLHeadingElement>(null);
 // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey marks a new screen so the reader starts at its heading.
 useEffect(()=>{heading.current?.focus({preventScroll:true});window.scrollTo?.({top:0});},[focusKey]);
 return <section className={`screen${className?` ${className}`:""}`} aria-labelledby="screen-title">
  {back?<button type="button" className="back-button" onClick={back.onBack}><Icon d={icons.back} size={24}/><span>{back.label}</span></button>:null}
  <header className="screen-head"><div className="screen-head-row"><h1 id="screen-title" tabIndex={-1} ref={heading}>{title}</h1>{aside?<span className="screen-aside">{aside}</span>:null}</div>{lead?<p className="lead">{lead}</p>:null}</header>
  <div className="screen-body">{children}</div>
 </section>;
}
export function Notice({tone="info",children,role}:{tone?:"info"|"ok"|"warn"|"danger";children:ReactNode;role?:"alert"|"status"}){return <div className={`notice notice-${tone}`} role={role}>{children}</div>;}
/** A compact list heading: label, optional count, optional right-hand action. */
export function ListHead({id,title,count,action}:{id?:string;title:ReactNode;count?:number|undefined;action?:ReactNode}){
 return <div className="list-head">{id?<h2 id={id}>{title}{count?<span className="list-count">{count}</span>:null}</h2>:<h2>{title}{count?<span className="list-count">{count}</span>:null}</h2>}{action}</div>;
}
