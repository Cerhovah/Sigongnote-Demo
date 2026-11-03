import {WorkLocalToday,LocalFilesImport,LocalCategoryFilter} from './work-local.js';
import {MaterialsHome} from './work-materials.js';
import {WorkLedger,WorkLedgerDetail} from './work-ledger.js';
import {WorkPhotoSheet} from './work-photo-sheet.js';
import {WorkPhotos} from './work-photos.js';
import {useCallback,useEffect,useMemo,useRef,useState,type ReactNode} from "react";
import {WorkFailure} from "./work-client.js";
import type {WorkClient,WorkContext,MaterialList,MaterialDetail,Material} from "./work-client.js";
import {useWorkRoute} from "./work-route.js";
import {WorkShell,Screen,Notice,Icon,icons,type WorkTab} from "./work-shell.js";
import {WorkSync} from "./work-sync.js";
import {WorkArchive} from './work-archive.js';
import {WorkJournal} from './work-journal.js';
import {WorkSetup} from "./work-setup.js";
import {WorkToday,todayTitle} from "./work-today.js";
import {WorkQuestions,QuestionReply,forgetQuestions,dropCachedQuestion,type WorkQuestion,type WorkAnswerResult} from "./work-questions.js";
import {useAsk,AskCompose,AskResult} from "./work-ask.js";
import {WorkDraft} from "./work-draft.js";
import {WorkDocumentHistory} from "./work-documents.js";
import {DocumentCreate} from "./work-document-new.js";
import {MaterialsSites,MaterialsList,MaterialDetailView,categoryNames,type Category} from "./work-materials.js";
import {WorkMemory,WorkAliases} from "./work-memory.js";
import {WorkMaintenance} from "./work-maintenance.js";
import {MoreMenu,DisplaySettings,useDisplayPrefs} from "./work-more.js";
import {WorkFolders} from "./work-folders.js";
import {createActivityClient,type ActivityController} from "./work-activity.js";
import {ActivityCapture,ActivityNotice,ActivityDashboard} from "./work-activity-view.js";
import {WorkLearning} from './work-learning.js';
import {WorkImprovements} from './work-improvements.js';
import {WorkEvents,WorkEventDetail,WorkEventActivity} from './work-events.js';
import {WorkAiConsent} from './work-ai-consent.js';
type View={title:string;tab:WorkTab|null;parent?:string;backLabel?:string;lead?:ReactNode;aside?:ReactNode;body:ReactNode};
/** Common work screen for Android, Windows and web: one screen per task, addressed by the hash. */
export function WorkApp({client:rawClient,localOnly=false}:{client:WorkClient;localOnly?:boolean}){
 const activity=useMemo(()=>createActivityClient(rawClient),[rawClient]),client=activity.client;
 useEffect(()=>{activity.controller.start();return()=>activity.controller.dispose();},[activity]);
 const {route,go,back,canGoBack}=useWorkRoute();
 const [context,setContext]=useState<WorkContext|null>(null),[items,setItems]=useState<Material[]>([]),[cursor,setCursor]=useState<string|null>(null);
 const [draft,setDraft]=useState(""),[detail,setDetail]=useState<MaterialDetail|null>(null);
 const [error,setError]=useState(""),[busy,setBusy]=useState(true),[tick,setTick]=useState(0),[page,setPage]=useState<string|undefined>();
 const [originalBusy,setOriginalBusy]=useState(false),[answerProject,setAnswerProject]=useState(""),[answerBusy,setAnswerBusy]=useState(false);
 const [prefs,setPrefs]=useDisplayPrefs();
  const routeProject=route.params.get("project")??"",query=route.params.get("q")??"";
  const category=(Object.hasOwn(categoryNames,route.params.get("category")??"")?route.params.get("category"):"") as Category|"";
  const [project,setProject]=useState(routeProject);
  useEffect(()=>{if(context){try{window.sessionStorage.setItem(`sigongnote:site:${context.tenant_id}:${context.user_id}`,project);}catch{/* This session still works without browser storage. */}}},[context,project]);
  const inMaterialScope=route.path[0]==="materials"&&["site","list"].includes(route.path[1]??"");
  // biome-ignore lint/correctness/useExhaustiveDependencies: category changes reset the previous page and results.
  useEffect(()=>{if(inMaterialScope){setProject(routeProject);setItems([]);setCursor(null);setPage(undefined);setDraft(query);}},[routeProject,query,category,inMaterialScope]);
  const listPath=(q:string,c:Category|""="")=>`materials/list?${new URLSearchParams({...routeProject?{project:routeProject}:{},...q?{q}:{},...c?{category:c}:{}})}`;
 useEffect(()=>{const root=document.documentElement;root.dataset.app="work";return()=>{delete root.dataset.app;delete root.dataset.nav;};},[]);
 const scope=useRef(""),running=useRef(false),serial=useRef(Promise.resolve()),titles=useRef(new Map<string,string>());
 const [first,second,third]=route.path;
 const listing=first==="materials"&&second==="list",selected=first==="materials"&&second==="item"&&third?third:null;
 // biome-ignore lint/correctness/useExhaustiveDependencies: tick requests a serialized refresh; the route, query and page define its snapshot.
 useEffect(()=>{let live=true;setBusy(true);
  const run=async()=>{if(!live)return;running.current=true;
   try{
    const current=await client.request<WorkContext>({route:"context"});if(!live)return;
    const key=`${current.user_id}:${current.tenant_id}`;
    if(scope.current&&scope.current!==key){forgetQuestions(client);scope.current=key;setContext(current);setProject(previous=>current.projects?.some(p=>p.id===previous)?previous:"");setItems([]);setCursor(null);setDetail(null);setPage(undefined);setDraft("");setProject("");titles.current.clear();go("today",{replace:true});setTick(x=>x+1);return;}
    if(!scope.current&&!routeProject){try{const remembered=window.sessionStorage.getItem(`sigongnote:site:${current.tenant_id}:${current.user_id}`);if(current.projects?.some(p=>p.id===remembered))setProject(remembered!);}catch{/* Use the visible default when storage is unavailable. */}}
    scope.current=key;setContext(current);setProject(previous=>current.projects?.some(p=>p.id===previous)?previous:"");
    if(selected){const data=await client.request<MaterialDetail>({route:"materials.detail",id:selected});if(live){setDetail(data);setError("");}}
    else if(listing){const data=await client.request<MaterialList>({route:"materials.list",q:query,...(routeProject?{project_id:routeProject}:{}),...(category?{category}:{}),...(page?{cursor:page}:{})});if(live){setItems(data.materials);setCursor(data.next_cursor);for(const m of data.materials)titles.current.set(m.id,m.title);setError("");}}
    else if(live)setError("");
   }catch(e){if(live){if(e instanceof WorkFailure&&(e.code==="login_required"||e.code==="account_changed")){forgetQuestions(client);setItems([]);setCursor(null);setDetail(null);setContext(null);scope.current="";}setError(e instanceof Error?e.message:"연결을 확인해 주세요.");}}
   finally{running.current=false;if(live)setBusy(false);}
  };
  serial.current=serial.current.then(run,run);return()=>{live=false;};
 },[client,query,page,selected,listing,tick,category,routeProject]);
 useEffect(()=>{const refresh=()=>{if(!running.current&&document.visibilityState==="visible")setTick(x=>x+1);};const timer=setInterval(refresh,10000);window.addEventListener("focus",refresh);return()=>{clearInterval(timer);window.removeEventListener("focus",refresh);};},[]);
 // biome-ignore lint/correctness/useExhaustiveDependencies: a newly selected material must not show the previous one or its site answer.
 useEffect(()=>{setDetail(null);setAnswerProject("");},[selected]);
 const openMaterial=useCallback((id:string,title?:string,siteOverride?:string)=>{if(title)titles.current.set(id,title);go(`materials/item/${encodeURIComponent(id)}${(siteOverride??routeProject)?`?project=${encodeURIComponent(siteOverride??routeProject)}`:""}`);},[go,routeProject]);
 async function openOriginal(seconds?:number){if(!selected||originalBusy)return;const tab=client.kind!=="native"?window.open("about:blank","_blank"):null;if(tab)tab.opener=null;setOriginalBusy(true);try{const result=await client.request<{url?:string;opened?:boolean}>({route:"materials.original",id:selected});if(result.opened){tab?.close();}else if(result.url){if(tab)tab.location.href=result.url+(seconds!==undefined?`#t=${seconds}`:"");else setError("새 창을 허용한 뒤 원문 열기를 다시 눌러주세요.");}}catch{tab?.close();setError("원문을 열지 못했어요. 연결과 자료 허용을 확인해 주세요.");}finally{setOriginalBusy(false);}}
 async function answerSite(){if(!selected||!detail?.organization||!answerProject||answerBusy)return;setAnswerBusy(true);try{await client.request({route:"organization.answer",id:selected,project_id:answerProject,version:Number(detail.organization.version)});setTick(x=>x+1);setAnswerProject("");}catch{setError("자료가 바뀌었거나 답을 저장하지 못했어요. 새로 확인한 뒤 다시 골라주세요.");}finally{setAnswerBusy(false);}}
 const status=context&&client.kind!=="local"?<WorkSync client={client} localOnly={localOnly} scope={`${context.tenant_id}:${context.user_id}`} onChange={reset=>{if(reset){setItems([]);setDetail(null);}setTick(x=>x+1);}}/>:null;
 const badge=client.kind==="local"?(context?.cloud_connected?'PC · 회사 연결':context?.cloud_status==='offline'?'PC · 서버 연결 대기':'이 PC 자료'):undefined;
 if(!context){
  const login=error&&/로그인|계정/.test(error);
  return <WorkShell company="시공노트" {...(badge?{badge}:{})} status={null}><Screen focusKey="waiting" title={login?"같은 계정으로 시작하세요":error?"연결을 기다리고 있어요":"업무 화면을 준비하고 있어요"} lead={login?"휴대폰에서 쓰는 계정으로 로그인하면 같은 회사의 업무를 이어 볼 수 있어요.":error||"잠시만 기다려 주세요."}>{error?<Notice tone={login?"warn":"info"} role="alert">{error}</Notice>:<p role="status" className="muted">자료와 연결 상태를 확인하고 있어요…</p>}{login&&client.kind==="native"?<div className="screen-action">{client.openAccount?<button type="button" className="button-primary" onClick={()=>client.openAccount?.()}>같은 계정으로 로그인</button>:<a className="button-primary" href="https://sigongnote.work/login">같은 계정으로 로그인</a>}</div>:<div className="screen-action"><button type="button" className="button-secondary" onClick={()=>setTick(x=>x+1)}>다시 확인</button></div>}</Screen></WorkShell>;
 }
 return <ActivityCapture controller={activity.controller}><WorkShell company={context.company||"시공노트"} {...(badge?{badge}:{})} status={status}>
  <WorkRoutes key={`${context.user_id}:${context.tenant_id}`} client={client} context={context} route={route.path} raw={route.raw} go={go} back={back} canGoBack={canGoBack} project={project} setProject={setProject} routeProject={routeProject}
   materials={{items,busy,error,query,category,cursor,page,draft,setDraft,detail,selected,originalBusy,answerProject,answerBusy,setAnswerProject,
    title:selected?titles.current.get(selected):undefined,
    search:(q:string)=>{setPage(undefined);go(listPath(q));},
    pick:(c:Category|"")=>{setDraft("");setPage(undefined);go(listPath("",c));},
    next:()=>{if(cursor)setPage(cursor);},first:()=>setPage(undefined),refresh:()=>{setPage(undefined);setTick(x=>x+1);},
    open:openMaterial,original:(s?:number)=>void openOriginal(s),answer:()=>void answerSite(),saved:()=>setTick(x=>x+1),
    created:()=>{setPage(undefined);setTick(x=>x+1);go("materials/list");}}}
   prefs={prefs} setPrefs={setPrefs} activity={activity.controller}/>
 </WorkShell></ActivityCapture>;
}
type Materials={items:Material[];busy:boolean;error:string;query:string;category:Category|"";cursor:string|null;page:string|undefined;draft:string;setDraft:(v:string)=>void;detail:MaterialDetail|null;selected:string|null;originalBusy:boolean;answerProject:string;answerBusy:boolean;setAnswerProject:(v:string)=>void;title:string|undefined;search:(q:string)=>void;pick:(c:Category|"")=>void;next:()=>void;first:()=>void;refresh:()=>void;open:(id:string,title?:string,siteOverride?:string)=>void;original:(s?:number)=>void;answer:()=>void;saved:()=>void;created:()=>void};
/** Per-account screens. Remounted when the account changes so no answer or draft leaks across. */
function WorkRoutes({client,context,route,raw,go,back,canGoBack,project,setProject,routeProject,materials:m,prefs,setPrefs,activity}:{client:WorkClient;context:WorkContext;route:string[];raw:string;go:(p:string,o?:{replace?:boolean})=>void;back:(parent:string)=>void;canGoBack:boolean;project:string;setProject:(id:string)=>void;routeProject:string;materials:Materials;prefs:ReturnType<typeof useDisplayPrefs>[0];setPrefs:ReturnType<typeof useDisplayPrefs>[1];activity:ActivityController}){
 const ask=useAsk(client,project,setProject,context.projects,`sigongnote.conversation:${context.tenant_id}:${context.user_id}`);
  const site=context.projects?.find(p=>p.id===routeProject),sitePath=`materials/site?project=${encodeURIComponent(routeProject)}`;
 const [reply,setReply]=useState<WorkQuestion|null>(null),[answered,setAnswered]=useState<WorkAnswerResult|null>(null),[answers,setAnswers]=useState(0);
 // Drafts already issued in this session open their issued document instead of an out-of-date draft.
 const [issued,setIssued]=useState<Record<string,string>>({});
 const [documentView,setDocumentView]=useState<'drafts'|'issued'|'received'>('drafts');
 const cameraInput=useRef<HTMLInputElement>(null);
 const lastCapture=useRef(0);
 const [cameraFiles,setCameraFiles]=useState<File[]>([]);
 const capture=()=>{const now=Date.now();if(now-lastCapture.current<1500)return;lastCapture.current=now;if(client.capturePhoto){go('photos');client.capturePhoto();}else cameraInput.current?.click();};
 const [first,second,third]=route,scope=`${context.user_id}:${context.tenant_id}`;
 const onlyLocal=client.kind==='local'&&!context.cloud_connected;
 const openDraft=(id:string)=>issued[id]?go(`documents/${encodeURIComponent(issued[id]!)}`):go(`draft/${encodeURIComponent(id)}`);
 const addPath=(p?:string)=>"add"+(p?"?project="+encodeURIComponent(p):"");
 // A spoken or written answer is handed to the question screen once, then forgotten.
 useEffect(()=>{if(first==="questions"&&second!=="reply"&&answered)setAnswered(null);},[first,second,answered]);
 const view=((): View=>{
  if(first==='sheets'&&second)return {title:'사진대지',tab:'documents',parent:'photos',backLabel:'사진으로',body:<WorkPhotoSheet key={second} client={client} id={second}/>};
 if(first==='photos')return {title:'현장 사진',tab:'documents',parent:'documents',backLabel:'문서로',body:<WorkPhotos client={client} context={context} project={project} setProject={setProject} onCapture={capture} {...(second?{id:second}:{})} onOpen={id=>go('photos/'+id)} onPrepared={id=>go('sheets/'+id)}/>};
  if(first==="activity")return {title:"사용 대시보드",tab:"more",parent:"more",backLabel:"설정으로",body:<><ActivityDashboard client={client} onNavigate={go}/>{context.can_maintain?<WorkEventActivity client={client} onEvent={id=>go('events/'+encodeURIComponent(id))}/>:null}</>};
  if(first==='events'&&second)return {title:'업무 기록',tab:'today',parent:'today',backLabel:'오늘로',body:<WorkEventDetail key={second} client={client} context={context} id={second} onOpen={(id,p)=>m.open(id,undefined,p??'')} onEvent={id=>go('events/'+encodeURIComponent(id))}/>};
  if(first==='events')return {title:'업무 기록',tab:'today',parent:'today',backLabel:'오늘로',body:<WorkEvents client={client} onEvent={id=>go('events/'+encodeURIComponent(id))}/>};
  if(first==='more'&&second==='learning'&&context.can_maintain)return {title:third?'판단 사례':'판단 개선 기록',tab:'more',parent:third?'more/learning':'more',backLabel:third?'기록 목록으로':'설정으로',body:<WorkLearning key={third??'list'} client={client} id={third??null} onSelect={id=>id?go('more/learning/'+id):back('more/learning')}/>};
  if(first==='more'&&second==='improvements'&&third==='strategies'&&context.can_maintain)return {title:'검색·조회 도구 개선',tab:'more',parent:'more/improvements',backLabel:'개선안 비교로',body:<WorkImprovements key="strategies" client={client} strategiesOnly/>};
  if(first==='more'&&second==='improvements'&&context.can_maintain)return {title:'개선안 비교',tab:'more',parent:'more/learning',backLabel:'판단 기록으로',body:<WorkImprovements client={client}/>};
  if(first==="questions"&&second==="reply")return reply?{title:"말이나 글로 답하기",tab:null,parent:"questions",backLabel:"질문으로",body:<QuestionReply client={client} question={reply} onCancel={()=>back("questions")} onAnswered={r=>{dropCachedQuestion(client,reply.id);setAnswered(r);setAnswers(n=>n+1);back("questions");}}/>}:{title:"확인할 일",tab:null,parent:"today",backLabel:"오늘로",body:<WorkQuestions client={client} onOpen={id=>m.open(id,undefined,"")} onReply={q=>{setReply(q);go("questions/reply");}} onOpenDraft={openDraft} onFinish={()=>back("today")}/>};
  if(first==="questions")return {title:"확인할 일",tab:null,parent:"today",backLabel:"오늘로",body:<WorkQuestions key={`answers-${answers}`} client={client} scope={scope} initialResult={answered} onOpen={id=>m.open(id,undefined,"")} onReply={q=>{setReply(q);go("questions/reply");}} onOpenDraft={openDraft} onFinish={()=>back("today")}/>};
  if(first==="ask"&&second==="result")return {title:"요청 결과",tab:null,parent:"today",backLabel:"오늘로",body:<AskResult onDocuments={()=>go("documents")} onDelivery={(kind,id)=>go((kind==="photo_sheet"?"sheets/":"documents/")+id)} onOpenSheet={id=>go('sheets/'+id)} onPhotos={()=>go('photos')} client={client} ask={ask} issued={issued} onOpenIssued={id=>go(`documents/${encodeURIComponent(id)}`)} onOpen={id=>m.open(id,ask.answer?.cards.find(c=>c.revision_id===id)?.title,"")} onOpenDraft={openDraft} onAgain={()=>{ask.reset();go("ask",{replace:true});}}/>};
  if(first==="ask")return {title:"무엇을 도와드릴까요?",tab:null,parent:"today",backLabel:"오늘로",body:<AskCompose client={client} context={context} ask={ask} onSent={()=>go("ask/result",{replace:true})}/>};
  if(first==="draft"&&second)return {title:"문서 준비",tab:null,parent:"today",backLabel:"오늘로",body:<WorkDraft key={second} client={client} id={second} onOpen={id=>m.open(id,undefined,"")} onIssued={id=>{setIssued(all=>({...all,[second]:id}));go(`documents/${encodeURIComponent(id)}`,{replace:true});}}/>};
  if(first==="materials"&&second==="item"&&third)return {title:m.title??"자료 내용",tab:"materials",parent:`materials/list${routeProject?`?project=${encodeURIComponent(routeProject)}`:""}`,backLabel:"목록으로",body:<>{m.error?<Notice tone="warn" role="alert">{m.error}</Notice>:null}<MaterialDetailView client={client} context={context} id={third} detail={m.detail} originalBusy={m.originalBusy} answerProject={m.answerProject} answerBusy={m.answerBusy} setAnswerProject={m.setAnswerProject} onAnswer={m.answer} onOriginal={m.original} onSaved={m.saved} onLatest={id=>m.open(id)}/></>};
  if(first==="materials"&&second==="list"&&routeProject&&!site)return {title:"현장을 확인해 주세요",tab:"materials",parent:"materials",backLabel:"현장 목록으로",body:<Notice tone="warn">현재 회사에서 이 현장을 찾을 수 없어요. 현장 목록에서 다시 골라주세요.</Notice>};
   if(first==="materials"&&second==="list")return {title:m.query?`‘${m.query}’ 찾은 자료`:m.category?`${categoryNames[m.category]} 자료`:"전체 자료",lead:site?.display_name,tab:"materials",parent:routeProject?sitePath:"materials",backLabel:"자료 찾기로",body:<MaterialsList items={m.items} busy={m.busy} error={m.error} query={m.query} page={m.page} cursor={m.cursor} onOpen={item=>m.open(item.id,item.title)} onNext={m.next} onFirst={m.first} onRefresh={m.refresh}/>};
  if(first==="materials"&&second==="work"&&third)return {title:"현장 업무",tab:"materials",parent:sitePath,backLabel:"현장으로",body:<WorkLedgerDetail key={third} client={client} id={third} onEvidence={id=>m.open(id)} onDocument={id=>go('documents/'+id)} onDraft={openDraft}/>};
  if(onlyLocal&&first==='materials'&&second==='site')return {title:site?.display_name??'모든 현장',tab:'materials',parent:'materials',backLabel:'현장으로',body:<><MaterialsHome draft={m.draft} setDraft={m.setDraft} busy={m.busy} onSearch={m.search} onCategory={m.pick}/><LocalCategoryFilter selected={m.category} onSelect={category=>go('materials/site?'+new URLSearchParams({...routeProject?{project:routeProject}:{},...category?{category}:{}}),{replace:true})}/><WorkJournal client={client} context={context} project={routeProject} category={m.category} title="날짜별 분개" onOpen={(id,p)=>m.open(id,undefined,p??'')} onAdd={p=>go(addPath(p))} onNavigate={go}/></>};
  if(onlyLocal&&first==='documents'&&!second)return {title:'문서',tab:'documents',body:<><button type="button" className="button-primary" onClick={()=>go('photos')}>사진대지 만들기</button><MaterialsHome draft={m.draft} setDraft={m.setDraft} busy={m.busy} onSearch={m.search} onCategory={m.pick}/><WorkJournal client={client} context={context} title="정리한 자료" onOpen={(id,p)=>m.open(id,undefined,p??'')} onAdd={p=>go(addPath(p))}/></>};
  if(first==="materials"&&second==="site")return {title:site?.display_name??(routeProject?"현장을 확인해 주세요":"모든 현장"),tab:"materials",parent:"materials",backLabel:"현장 목록으로",body:site||!routeProject?<><WorkLedger key={routeProject+':'+m.category} client={client} context={context} project={routeProject} category={m.category} showProject={!routeProject} onProject={id=>{setProject(id);go('materials/site?'+new URLSearchParams(id?{project:id}:{}),{replace:true});}} onCategory={category=>go('materials/site?'+new URLSearchParams({...routeProject?{project:routeProject}:{},...category?{category}:{}}),{replace:true})} onOpen={id=>go('materials/work/'+id+(routeProject?'?project='+routeProject:''))} onSearch={m.search}/><WorkEvents client={client} project={routeProject} onEvent={id=>go('events/'+encodeURIComponent(id))}/><WorkJournal key={'journal:'+routeProject+':'+m.category} client={client} context={context} project={routeProject} category={m.category} title="날짜별 기록" onOpen={(id,p)=>m.open(id,undefined,p??'')} onAdd={p=>go(addPath(p))} onNavigate={go} onOpenDraft={openDraft}/></>:<Notice tone="warn">현재 회사에서 이 현장을 찾을 수 없어요. 현장 목록에서 다시 골라주세요.</Notice>};
  if(first==="materials")return {title:"현장",tab:"materials",body:<MaterialsSites projects={context.projects??[]} onSite={id=>{setProject(id);go(`materials/site?project=${encodeURIComponent(id)}`);}} onAll={()=>{setProject("");go("materials/site");}} onAdd={()=>go("materials/new")}/>};
  if(first==="documents"&&second==="new")return {title:"문서 만들기",tab:"documents",parent:"documents",backLabel:"문서로",body:<DocumentCreate client={client} context={context} project={project} onProject={setProject} onDraft={id=>go(`draft/${encodeURIComponent(id)}`,{replace:true})} onAdd={id=>go(addPath(id))} onSite={()=>go('materials/new')} onAsk={(text,siteId)=>{go("ask/result",{replace:true});void ask.submitFor?.(text,siteId);}}/>};
  if(first==="documents"&&second)return {title:"발행한 문서",tab:"documents",parent:"documents",backLabel:"문서 목록으로",body:<WorkDocumentHistory client={client} selected={second} onSelect={id=>go(id?`documents/${encodeURIComponent(id)}`:"documents")}/>};
  if(first==="documents")return {title:"문서",tab:"documents",body:<WorkDocumentHistory client={client} context={context} project={project} onProject={setProject} onDraft={openDraft} onMaterial={id=>m.open(id)} view={documentView} onView={setDocumentView} selected={null} onSelect={id=>go(id?`documents/${encodeURIComponent(id)}`:"documents")} onCreate={()=>go("documents/new")} onPhotos={()=>go("photos")}/>};
  if(first==="journal")return {title:"업무일지",tab:"today",parent:"today",backLabel:"오늘로",body:<WorkJournal onOpenDraft={openDraft} onNavigate={go} client={client} context={context} initialProject={project} onOpen={(id,p)=>m.open(id,undefined,p??'')} onAdd={p=>go(addPath(p))}/>};
  if(first==="folders")return {title:"연결한 폴더",tab:"more",parent:"more",backLabel:"설정으로",body:<WorkFolders client={client} context={context}/>};
  if(first==="more"&&second==="memory")return {title:"기억한 판단",tab:"more",parent:"more",backLabel:"설정으로",body:<WorkMemory client={client}/>};
  if(first==="more"&&second==="aliases")return {title:"현장 별칭",tab:"more",parent:"more",backLabel:"설정으로",body:<WorkAliases client={client} projects={context.projects??[]}/>};
  if(first==="more"&&second==="display")return {title:"글자 크기·선명도",tab:"more",parent:"more",backLabel:"설정으로",body:<DisplaySettings prefs={prefs} onChange={setPrefs}/>};
  if(first==="more"&&second==="privacy")return {title:"사용 기록·동의",tab:"more",parent:"more",backLabel:"설정으로",body:<ActivityNotice controller={activity} onNavigate={go}/>};
  if(first==="more"&&second==="status"&&context.can_maintain)return {title:"연결·보관 상태",tab:"more",parent:"more",backLabel:"설정으로",body:<WorkMaintenance client={client}/>};
  if(first==="more")return {title:"설정",tab:"more",body:<><MoreMenu client={client} context={context} go={go} onGuide={()=>go("setup")}/><WorkAiConsent client={client} context={context} settings onChanged={()=>window.dispatchEvent(new Event('focus'))}/></>};
  if(onlyLocal)return {title:'오늘',aside:todayTitle(),tab:'today',body:<WorkLocalToday client={client} context={context} onNavigate={go} onOpen={(id,p)=>m.open(id,undefined,p??'')} onAdd={()=>go('add')}/>};
  return {title:"오늘",aside:todayTitle(),tab:"today",body:<><WorkAiConsent client={client} context={context} onChanged={()=>window.dispatchEvent(new Event('focus'))}/><WorkToday onNavigate={go} onJournalOpen={(id,p)=>m.open(id,undefined,p??'')} onAdd={p=>go(addPath(p))} client={client} context={context} ask={ask} issued={issued} onQuestions={()=>go("questions")} onSent={()=>go("ask/result")} onOpenDraft={openDraft} onWork={id=>go("materials/work/"+id)} onFolders={()=>go("setup")}/></>};
 })();
 useEffect(()=>{document.title=`${view.title} · 시공노트`;},[view.title]);
 const home=view.tab!==null&&!view.parent;
 useEffect(()=>{document.documentElement.dataset.nav=view.tab?"1":"";},[view.tab]);
 if(first==='add'&&second==='photo'&&third==='site')return <WorkSetup client={client} context={context} mode="site" onBack={()=>back('add/photo')} onExit={id=>{if(id)setProject(id);go('add/photo'+(id?'?project='+encodeURIComponent(id):''),{replace:true});}}/>;
 if(client.kind==='local'&&(first==='add'||first==='archive'))return <LocalFilesImport context={context} initialFiles={second==='photo'?cameraFiles:[]} initialProject={routeProject||project} onBack={()=>back('today')} onDone={()=>{setCameraFiles([]);go('journal');}}/>;
 if(first==="archive"||first==="add")return <WorkArchive key={second==='photo'?'photo':'files'} initialFiles={second==='photo'?cameraFiles:[]} {...(second==='photo'?{onAddProject:()=>go('add/photo/site')}: {})} initialProject={routeProject||project} archive={first==="archive"} client={client} context={context} onExit={p=>{setCameraFiles([]);if(p)setProject(p);go(first==="archive"?"more":"journal");}} onOpen={(id,p)=>m.open(id,undefined,p)}/>;
 if(first==="materials"&&second==="new")return <WorkSetup client={client} context={context} mode="site" onBack={()=>back("materials")} onExit={id=>{if(id){setProject(id);go(`materials/site?project=${encodeURIComponent(id)}`,{replace:true});}else back("materials");}}/>;
 if(first==="setup")return <WorkSetup client={client} context={context} onBack={()=>back("more")} onExit={id=>{if(id)setProject(id);go("today",{replace:true});}} onAdd={id=>{if(id)setProject(id);go(addPath(id));}}/>;
 return <div className={view.tab?"work-layout":"work-focus-layout"}>
  {view.tab?<BottomNav tab={view.tab} go={go} onCapture={capture}/>:null}
  <input hidden ref={cameraInput} type="file" accept="image/*" capture="environment" onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';if(files.length){setCameraFiles(files);go('add/photo');}}}/>
  <Screen focusKey={raw} {...(home&&view.tab==="today"?{className:"screen-today"}:first==="activity"?{className:"screen-activity"}:{})} title={view.title} {...(view.lead?{lead:view.lead}:{})} {...(view.aside?{aside:view.aside}:{})} {...(view.parent?{back:{label:canGoBack?"뒤로":view.backLabel??"뒤로",onBack:()=>back(view.parent!)}}:{})}>{view.body}</Screen>
 </div>;
}
const tabs:{id:WorkTab;label:string;icon:string}[]=[
 {id:"today",label:"오늘",icon:"M5 4h14v17H5z M9 2v4 M15 2v4 M5 9h14 M9 14l2 2 4-4"},
 {id:"materials",label:"현장",icon:"M3 7h7l2 2h9v11H3z M3 7V4h6l2 3"},
 {id:"documents",label:"문서",icon:"M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h7"},
 {id:"more",label:"설정",icon:"M4 7h16 M4 12h16 M4 17h16"},
];
function BottomNav({tab,go,onCapture}:{tab:WorkTab;go:(p:string)=>void;onCapture:()=>void}){
 const link=(t:typeof tabs[number])=><a key={t.id} id={`nav-${t.id}`} href={`#/${t.id}`} aria-current={tab===t.id?"page":undefined} onClick={e=>{e.preventDefault();go(t.id);}}><Icon d={t.icon} size={28}/><span>{t.label}</span></a>;
 return <nav className="work-nav" aria-label="주요 메뉴">{tabs.slice(0,2).map(link)}<button id="nav-camera" type="button" className="nav-camera" onClick={onCapture}><Icon d={icons.camera} size={30}/><span>촬영</span></button>{tabs.slice(2).map(link)}</nav>;
}
