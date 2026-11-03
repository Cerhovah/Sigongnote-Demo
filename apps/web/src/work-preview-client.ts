import type {WorkClient,WorkRequest,VoiceEvent} from "./work-client.js";
import type {WorkEvent} from './work-tasks.js';
/**
 * Development-only synthetic client for `?work=preview`. Loaded behind import.meta.env.DEV so production
 * and native bundles never contain it. Every value is invented; nothing leaves the browser.
 */
const now=()=>new Date().toISOString();
const uuid=()=>crypto.randomUUID();
type PreviewSite={id:string;display_name:string};
type Doc={site?:PreviewSite;id:string;state:string;number:string;type:string;total:string;recipient:string;shares:{id:string;own:boolean;format:"pdf"|"xlsx";state:string}[]};
export function previewWorkClient(options:{delayMs?:number;guideDone?:boolean;firstUse?:boolean}={}):WorkClient{
 const project={id:uuid(),display_name:"합성 햇살현장"},other={id:uuid(),display_name:"합성 푸른마을"},sites=[project,other];
 const setup={project_id:options.firstUse?null:project.id as string|null,version:1,dismissed:false,completed:!options.firstUse};let taskDone=false;
 const materials:{id:string;title:string;status:string;job_state:string|null;project_name:string|null;project_id?:string|null;created_at:string;processed_at:string|null;sha256:string;processor_version:string|null;categories:string[];work_label:string|null}[]=[
  {id:uuid(),title:"햇살현장 석고보드 납품 확인",status:"complete",job_state:null,project_name:project.display_name,project_id:project.id,created_at:now(),processed_at:now(),sha256:"a".repeat(64),processor_version:"preview",categories:["delivery_work"],work_label:"주방 보수"},
  {id:uuid(),title:"햇살현장 문틀 견적서(9월)",status:"complete",job_state:null,project_name:project.display_name,project_id:project.id,created_at:now(),processed_at:now(),sha256:"b".repeat(64),processor_version:"preview",categories:["agreement"],work_label:"현관 문틀"},
  {id:uuid(),title:"푸른마을 하자 보수 요청 사진",status:"partial",job_state:null,project_name:other.display_name,project_id:other.id,created_at:now(),processed_at:now(),sha256:"c".repeat(64),processor_version:"preview",categories:["inspection_defect"],work_label:"욕실 문짝"},
  {id:uuid(),title:"자재상 거래명세서 5장",status:"pending",job_state:"queued",project_name:null,created_at:now(),processed_at:null,sha256:"d".repeat(64),processor_version:null,categories:[],work_label:null},
 ];
 const workId=uuid();
 const work={id:workId,label:"주방 석고보드 납품",project_id:project.id,project_name:project.display_name,categories:["agreement","delivery_work"],evidence_count:1,updated_at:now()};
 const journal=[
  {id:materials[0]!.id,organization_version:1,received_at:now(),occurred_at:null,source_kind:"sms",declared_mime:"application/vnd.sigongnote.message+json",project_id:project.id,project_name:project.display_name,categories:["delivery_work"],excerpt:"내일 오전 석고보드 20장 추가 납품 부탁드립니다.",reading_state:"readable",parse_status:"complete",observations:[{id:uuid(),kind:"request",text:"석고보드 20장 추가 납품 요청 · 내일 오전",locator:"line:1"}]},
  {id:materials[3]!.id,received_at:new Date(Date.now()-86400000).toISOString(),occurred_at:null,source_kind:"folder",declared_mime:"application/pdf",project_id:null,project_name:null,categories:[] as string[],excerpt:"",reading_state:"waiting",parse_status:"pending",observations:[] as {id:string;kind:string;text:string;locator:string}[]},
 ];
 const task={id:uuid(),revision_id:materials[0]!.id,text:"내일 오전 석고보드 20장 추가 납품 요청",project_name:project.display_name,project_id:project.id};
 const restored:WorkEvent={id:uuid(),kind:'request',summary:'내일 자재 납품 요청 접수',detail:'대표에게 추가 납품을 요청한 연락입니다.',project_id:project.id,project_name:project.display_name,party:'합성 김반장',source_kind:'revision',source_ref:materials[0]!.id,evidence_refs:[materials[1]!.id],version:1,missing:[],confidence:'high',status:'open',reasoning:'앞서 받은 견적서와 이번 문자에 같은 현장과 자재가 있어 연결했습니다.',created_at:now(),followups:[]};
 const corrections:{id:string;reason:string;summary:string;created_at:string}[]=[];
 const eventDetail=()=>({event:restored,source:{id:materials[0]!.id,kind:'revision',available:true,text:journal[0]!.excerpt},evidence:[{id:materials[1]!.id,kind:'revision',available:true,text:'합성 햇살현장 석고보드 20장 견적 연락'}],usage:{state:'settled',actual_krw:'42',model:'합성 UI 미리보기',tool_calls:['recent_journal','search_evidence']},corrections});
 const questions=[
  {id:uuid(),version:1,category:"material",project_name:project.display_name,project_id:project.id,work_label:"주방 보수",prompt:"석고보드 발주 10개, 인수 기록은 8개예요. 받은 수량으로 반영할까요?",cause:"other",source_refs:[{revision:materials[0]!.id,span:1,organization_version:1}],proposal:{effects:[{kind:"acceptance",quantity:"8",ordered:"10",unit:"개"}],blocked:null}},
  {id:uuid(),version:1,category:"schedule",project_name:other.display_name,project_id:other.id,work_label:"욕실 문짝",prompt:"약속한 2026-09-28이 지났어요. 다음 일정을 2026-10-06로 바꿀까요?",cause:"today_blocked",source_refs:[{revision:materials[2]!.id,span:1,organization_version:1}],proposal:{effects:[{kind:"schedule",date:"2026-10-06"}],blocked:null}},
  {id:uuid(),version:1,category:"change",project_name:project.display_name,project_id:project.id,work_label:"현관 문틀",prompt:"문틀 규격 변경 추가비 50,000원, 고객 부담으로 기록할까요?",cause:"other",source_refs:[{revision:materials[1]!.id,span:1,organization_version:1}],proposal:{effects:[{kind:"liability",party:"customer"}],blocked:null,cost_options:{change:{kind:"charge_adjustment",amount_minor:"50000"},defect:{kind:"quality",action:"보완"}}}},
 ];
 const drafts=new Map<string,{type:string;recipient:string|null;stale:boolean;site?:PreviewSite}>();
 const documents:Doc[]=[{id:uuid(),state:"approved",number:"Q-2026-0931",type:"estimate",total:"1375000",recipient:"합성 고객",shares:[]}];
 const policies:{id:string;version:number;scope_type:string;project_name:string|null;project_id?:string|null;work_label:string;condition_prompt:string;effects:Record<string,string>[];max_amount_minor:string;valid_until:string;revoked_at:string|null}[]=[];
 const lines=[{id:uuid(),description:"방화 석고보드",spec:"9.5T 900×1800",unit:"장",quantity:"30",unit_price:"12000",supply:"360000",tax:"36000"},{id:uuid(),description:"목문틀 가공·설치",spec:"현관 1식",unit:"식",quantity:"1",unit_price:"640000",supply:"640000",tax:"64000"},{id:uuid(),description:"운반비",spec:"",unit:"회",quantity:"1",unit_price:"250000",supply:"250000",tax:"25000"}];
 const draftBody=(id:string)=>{const d=drafts.get(id)!;const names:Record<string,string>={estimate:"견적서",purchase_order:"발주서",invoice:"청구서",delivery_statement:"거래명세서"};return {id,state:d.recipient?"draft_ready":"needs_inputs",stale:d.stale,source_candidate:true,missing:[...(d.recipient?[]:["받는 곳"]),...(d.type==="invoice"?["이미 청구한 금액을 뺀 이번 청구 범위"]:[])],source_refs:[materials[1]!.id],...(d.type==="invoice"?{billing:{available:"1375000"}}:{}),document:{basis_hash:"e".repeat(64),type:d.type,document_number:"초안",issuer:{name:"합성 시공노트 회사"},recipient:{name:d.recipient},project:{id:(d.site??project).id,name:(d.site??project).display_name},date:"2026-10-01",lines,totals:{supply:"1250000",tax:"125000",total:"1375000"},title:names[d.type]}};};
 let guide={step:0,completed:options.guideDone===true};
 const delay=(ms=options.delayMs??250)=>new Promise(r=>setTimeout(r,ms));
 const client:WorkClient={kind:"fixture",dispose(){},
  startVoice(callback:(e:VoiceEvent)=>void){const id=uuid();let cancelled=false;setTimeout(()=>{if(!cancelled)callback({id,phase:"partial",text:"햇살현장 견적서"});},700);setTimeout(()=>{if(!cancelled)callback({id,phase:"final",text:"햇살현장 견적서 준비해줘"});},1600);return {id,cancel:()=>{cancelled=true;}};},
  async request<T>(r:WorkRequest):Promise<T>{await delay();const reply=(v:unknown)=>v as T;
   switch(r.route){
    case "ledger.list":return reply({items:(!r.project_id||r.project_id===project.id)&&(!r.category||work.categories.includes(r.category))?[work]:[],next_cursor:null});
    case "ledger.read":return reply({...work,events:[{id:uuid(),kind:"request",mode:"observed",asserted:false,occurred_at:null,recorded_at:now(),withdrawn:false,evidence_ids:[materials[0]!.id],supersedes:null,reverses:null}],evidence:[{...materials[0],parse_state:"complete"}],documents:documents.map(d=>({id:d.id,type:d.type,number:d.number,state:d.state})),drafts:[],partial:false,next_cursor:null});
    case "agenda.read":return reply({today:new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Seoul"}),items:[{...work,due_date:new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Seoul"})}],partial:false});
    case "activity.status":return reply({allowed:false,consent_id:null,can_view_activity:false});
    case "archive.status":return reply({enabled:false,version:0,waiting:0,running:0,finished:0});
    case "activity.consent":throw new Error("합성 UI 미리보기에서는 사용 기록을 저장하지 않습니다. 실제 개발실을 이용해 주세요.");
    case "context":return reply({user_id:"preview",tenant_id:"preview",company:"합성 시공노트 회사",can_maintain:true,can_resolve_site:true,projects:[...sites],setup:{...setup}});
    case "journal.tasks":return reply({items:[{...task,event_id:restored.id,kind:'followup',event_summary:restored.summary,done:taskDone,version:taskDone?2:1}],partial:false,events:[restored]});
    case 'events.read':if(r.id!==restored.id)throw new Error('합성 기록 없음');return reply(eventDetail());
    case 'events.list':return reply({items:!r.project_id||r.project_id===project.id?[eventDetail()]:[],next_cursor:null});
    case "journal.list":return reply({items:journal.filter(i=>(!r.project_id||i.project_id===r.project_id)&&(!r.category||i.categories.includes(r.category))),next_cursor:null});
    case "journal.command":{const b=JSON.parse(r.command);if(b.action==='event'){restored.summary=b.summary;restored.project_id=b.project_id;restored.project_name=sites.find(p=>p.id===b.project_id)?.display_name??null;restored.version=(restored.version??0)+1;corrections.push({id:uuid(),reason:b.reason,summary:b.summary,created_at:now()});return reply({event:restored});}if(b.action==="task"){taskDone=Boolean(b.done);return reply({done:taskDone,version:taskDone?2:1});}if(b.action==="draft"){const id=uuid();drafts.set(id,{site:sites.find(p=>p.id===b.project_id)??project,type:b.type,recipient:null,stale:false});return reply({id});}return reply({});}
    case "setup.read":return reply({...setup,policy:{id:"preview",provider:"합성",storage_location:"합성 서버",processing_location:"합성",external_processing:true}});
    case "setup.command":{const b=JSON.parse(r.command);if(b.action==="select"){if(b.display_name){const created={id:uuid(),display_name:b.display_name};sites.push(created);setup.project_id=created.id;}else setup.project_id=b.project_id;}if(b.action==="complete")setup.completed=true;if(b.action==="dismiss")setup.dismissed=true;setup.version++;return reply({...setup});}
    case "capture.status":return reply({limit_bytes:100000000000,used_bytes:0,reserved_bytes:0,recovery:{checked:0,failed:0,last_checked_at:null}});
    case "folders.read":return reply({bindings:[]});
    case "sync.changes":return reply({changes:[],next_cursor:"1",has_more:false});
    case "guide.read":return reply(guide);
    case "guide.save":guide={step:r.step,completed:r.completed};return reply({});
    case "questions.list":return reply({questions,can_answer:true,coverage:"합성 자료 4개에서 발주·인수·일정·변경 단서를 확인했어요."});
    case "work.command":case "work.reply":{const body=JSON.parse(r.command);const id=body.targets?.[0]?.id??body.question_id;const index=questions.findIndex(q=>q.id===id);const q=questions[index];if(index>=0)questions.splice(index,1);const defer=body.intent==="defer";return reply({changed:defer?[]:q?.category==="material"?["인수 8개 · 발주 10개로 기록","남은 2개는 추가 확인으로 남김"]:q?.category==="schedule"?["다음 일정 2026-10-06","관련 작업 일정 다시 계산"]:["추가비 50,000원 · 고객 부담","청구서 초안에 반영할 금액으로 보관"],deferred:defer,...(defer?{}:{decision_id:uuid(),memory_cost_minor:q?.category==="change"?"50000":"0"})});}
    case "conversation.turn":{const text=r.text;const site=[project,other].find(p=>p.id===r.selected_project_id)??project;const kind=/견적/.test(text)?"estimate":/발주/.test(text)?"purchase_order":/청구/.test(text)?"invoice":/명세/.test(text)?"delivery_statement":null;if(kind){const id=uuid();drafts.set(id,{site,type:kind,recipient:kind==="purchase_order"?"합성 자재상":null,stale:false});const names:Record<string,string>={estimate:"견적서",purchase_order:"발주서",invoice:"청구서",delivery_statement:"거래명세서"};return reply({turn_id:r.client_turn_id,status:"completed",text:`${names[kind]} 초안을 준비했어요. 내용을 확인해 주세요.`,cards:[],document_draft:{id,type:kind}});}
     const found=materials.filter(m=>(!r.selected_project_id||m.project_id===r.selected_project_id)&&text.split(/\s+/).some(w=>w.length>1&&m.title.includes(w.replace(/(찾아줘|자료)$/,""))));return reply({turn_id:r.client_turn_id,status:"completed",text:found.length?`자료 ${found.length}개를 찾았어요.`:"맞는 자료를 아직 찾지 못했어요. 다른 단어로 말씀해 주세요.",cards:found.map(m=>({revision_id:m.id,title:m.title,excerpt:"석고보드 12개 · 발주수량 10개 · 인수수량 8개. 금액·지급 여부는 아직 확인하지 않았습니다.",created_at:m.created_at,project_name:m.project_name,work_label:m.work_label}))});}
    case "documents.read":return reply(draftBody(r.id));
    case 'documents.prepare':{const id=uuid();drafts.set(id,{site:sites.find(p=>p.id===r.project_id)??project,type:'estimate',recipient:null,stale:false});return reply({id});}
    case "documents.complete":{const old=drafts.get(r.id)!;const id=uuid();drafts.set(id,{...old,recipient:r.recipient??old.recipient,stale:false});return reply({id});}
    case "documents.issue":{const old=drafts.get(r.id)!;const id=uuid();documents.unshift({id,site:old.site??project,state:"approved",number:`${old.type==="invoice"?"I":old.type==="purchase_order"?"P":"Q"}-2026-${String(1000+documents.length)}`,type:old.type,total:r.amount_minor??"1375000",recipient:r.recipient_confirmation,shares:[]});return reply({documents:[{id}]});}
    case "documents.list":return reply({documents:documents.map(d=>({id:d.id,state:d.state,snapshot_hash:"f".repeat(64),number:d.number,type:d.type,project:{id:(d.site??project).id,name:(d.site??project).display_name},total:d.total,recipient:d.recipient}))});
    case "documents.issued":{const d=documents.find(x=>x.id===r.id)!;return reply({id:d.id,state:d.state,snapshot_hash:"f".repeat(64),render_state:"succeeded",replacement_id:null,files:[{format:"pdf",sha256:"0"},{format:"xlsx",sha256:"1"}],shares:d.shares,document:{basis_hash:"e".repeat(64),type:d.type,document_number:d.number,issuer:{name:"합성 시공노트 회사"},recipient:{name:d.recipient},project:{id:(d.site??project).id,name:(d.site??project).display_name},date:"2026-10-01",lines,totals:{supply:"1250000",tax:"125000",total:d.total}}});}
    case "documents.share":{const d=documents.find(x=>x.id===r.id)!;const id=uuid();d.shares.unshift({id,own:true,format:r.format,state:"unknown"});return reply({id,sha256:"0"});}
    case "documents.shareOutcome":{for(const d of documents)for(const s of d.shares)if(s.id===r.intent_id)s.state=r.outcome;return reply({recorded:true});}
    case "documents.file":{const text=`합성 미리보기 문서 ${r.id}`;const bytes=new TextEncoder().encode(text);const hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");return reply({base64:btoa(String.fromCharCode(...bytes)),sha256:hash,name:`합성문서.${r.format==="pdf"?"txt":"txt"}`,mime:"text/plain"});}
    case "documents.cancel":{const d=documents.find(x=>x.id===r.id);if(d)d.state="cancelled";return reply({});}
    case "documents.retry":return reply({});
    case "materials.list":{const q=r.q?.trim();const list=materials.filter(m=>(!r.project_id||m.project_id===r.project_id)&&(!q||m.title.includes(q))&&(!r.category||m.categories.includes(r.category)));return reply({materials:list,next_cursor:null});}
    case "materials.detail":{const m=materials.find(x=>x.id===r.id);return reply({revision:{id:r.id,status:m?.status??"complete",declared_mime:"text/plain"},organization:m&&m===materials[2]?{state:"conflict",version:1,categories:m.categories}:null,result:{created_at:now(),processor_version:"preview",output:{status:m?.status??"complete",spans:[{text:`${m?.title??"합성 자료"}`,locator:"line:1"},{text:"석고보드 12개\n발주수량: 10 개\n인수수량: 8 개",locator:"line:3"},{text:"금액·지급 여부는 아직 확인하지 않았습니다.",locator:"line:6"}],issues:[],excerptTruncated:false,sourceHash:"a".repeat(64)}}});}
    case "materials.original":return reply({url:"about:blank"});
    case "organization.answer":return reply({});
    case "policies.list":return reply({policies,aliases:[{id:uuid(),version:1,alias:"김사장 집",project_name:project.display_name}],recent:[],can_edit:true});
    case "policies.command":{const b=JSON.parse(r.command);if(b.action==="remember"&&b.scope!=="once")policies.push({id:uuid(),version:1,scope_type:b.scope,project_name:project.display_name,project_id:project.id,work_label:"주방 보수",condition_prompt:"발주보다 적게 받은 수량을 반영할까요?",effects:[{kind:"acceptance",quantity:"8",ordered:"10",unit:"개"}],max_amount_minor:b.max_amount_minor,valid_until:new Date(Date.now()+b.valid_days*86400000).toISOString(),revoked_at:null});return reply({});}
    case "voice.status":return reply({enabled:true,consented:true,provider:"합성",consent_version:"short-voice-v1"});
    case "maintenance.status":return reply({checked_at:now(),support_id:"PREVIEW-0001",jobs:{waiting:1,working:0,failed:0,oldest_wait_seconds:180},capture:{connected:2,gated:0,pending:0,last_received_at:now()},usage:{voice_reserved_seconds:12,audio_reserved_seconds:0,voice_known_cost_minor:null,voice_unknown_cost_count:0},backup:{verified_at:null}});
    case "photos.list":return reply({photos:[],groups:[],next_cursor:null});
    case "conversation.read":return reply({turns:[]});
    case "deliveries.list":return reply({deliveries:[],recipients:[],project_id:project.id,ready:false,max_cost_krw:null,gate:"연결 대기"});
    case "activity.list":return reply({summary:{clicks:0,requests:0,results:0,errors:0,sessions:0,participants:0,last_at:null},days:[],events:[],next_cursor:null,period_days:30});
    case "learning.list":return reply({consent:{allowed:false},summary:{available:0,unreviewed:0,corrections:0,new_facts:0},cases:[],next_cursor:null});
    case "context-learning.list":return reply({consent:{allowed:false},cases:[],procedures:[],retention_days:90,scope:'site_reading_only',business_effects_changed:false});
    case "context-learning.command":throw new Error('합성 미리보기에서는 실제 교정을 학습 정답으로 채택할 수 없어요.');
    case "improvements.list":return reply({criteria:{version:"work-eval-v1",min_test_groups:1,min_shadow_groups:1,max_errors:0,max_protected_changes:0,max_high_confidence_errors:0,min_improvement:1},head:{version:0,active_id:null,previous_id:null,delegation:{allowed:false,scope:"quality_interpretation",criteria_version:"work-eval-v1",max_calls:0,max_cost_minor:0}},versions:[],usage:{calls:0,cost:0,known_cost:0,unknown:0}});
    case "evidence.chunks":return reply({revision_id:r.id,index_job_id:null,source_hash:"a".repeat(64),parser_version:null,source_status:"ready",coverage:{},complete_extracted_text:true,indexed_chunks:0,index_status:"ready",chunks:[],next_cursor:null});
    // Unsupported effects must never look like a successful empty response.
    default:console.warn("[preview] unhandled route",r.route);throw new Error(`Unsupported preview route: ${r.route}`);
   }
  }};
 return client;
}
