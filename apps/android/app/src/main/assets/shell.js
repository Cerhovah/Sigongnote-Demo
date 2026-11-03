const element = id => document.getElementById(id);
const bridge = window.SigongnoteNative;
element("open-account").addEventListener("click",()=>request("openAccount"));
let latestConnection = null, selectedSource = 0, guideStep = 0, currentPage = "home";
const skipped = new Set();
const pages = new Set(["home","setup","sources","source","folders","queue","guide"]);
const titles = {home:"휴대폰 자료",setup:"한 가지씩 준비해요",sources:"허용한 자료",source:"자료 살펴보기",folders:"업무 폴더",queue:"자료",guide:"사용법"};
const purposes = [
  "새로 연결한 현장 폴더는 지금부터 생기거나 수정된 자료를 읽어요. 필요한 과거 자료는 한 개씩 공유하고, 전체 정리는 고급 설정에서 선택하세요. 원본은 그대로예요.",
  "고른 앱의 새 알림만 이 휴대폰에 보관해요. 문자앱 알림은 제외해요. 업무 대화는 따로 골라요. 아래에서 읽기를 중지할 수 있어요.",
  "선택 사항이에요. 기본 문자앱이 바뀌어요. 채팅+·스팸 차단은 지원하지 않아요. 사진 문자 받기는 확인 중이에요. 원래 앱은 설정 → 기본 앱 → SMS 앱에서 고를 수 있어요.",
  "업무 사진이 생기는 폴더를 한 번 고르면 새 사진을 읽어요. 개인 사진이 섞인 폴더는 고르지 마세요. 개별 사진은 공유로 가져올 수 있어요.",
  "녹음 파일이 있는 폴더를 고르거나 공유해 주세요. 통화를 자동으로 녹음하거나 통화기록을 읽지는 않아요.",
];
function request(method, payload = {}) {
  if (!bridge) { element("notice").hidden = false; element("notice").textContent = "휴대폰 앱에서 사용할 수 있어요."; return; }
  bridge.postMessage(JSON.stringify({bridgeVersion:1,requestId:crypto.randomUUID(),method,payload}));
}
function show(page, push = true) {
  currentPage = pages.has(page) ? page : "home";
  for (const panel of document.querySelectorAll("[data-page]")) panel.hidden = panel.dataset.page !== currentPage;
  element("page-title").textContent = titles[currentPage]; element("page-title").focus(); window.scrollTo(0,0);
  if (push && location.hash !== `#${currentPage}`) history.pushState(null,"",`#${currentPage}`);
  for (const control of document.querySelectorAll("nav [data-go]")) control.setAttribute("aria-current",control.dataset.go === currentPage ? "page" : "false");
}
function step() {
  const state = latestConnection || {};
  return window.SigongnoteConnectionModel.nextSetupStep({...state,setupAttempted:[state.setupAttempted || "",...skipped].join(",")});
}
function smsPurpose() { return latestConnection?.smsOriginal==="policy_gated"?"삼성 문자앱은 그대로 사용합니다. 업무 번호와 현장을 직접 고르고, 허용한 새 문자만 수집해요. OS 문자 권한과 서버 보관은 별도 확인합니다.":purposes[2]; }
function renderSetup() {
  const next = step(), index = {folder:0,notifications:1,sms:2}[next];
  element("setup-title").textContent = {folder:"업무 폴더",notifications:"업무 알림",sms:latestConnection?.smsOriginal==="policy_gated"?"문자 연결 · 선택":"문자앱 변경 · 선택",review:"준비한 자료를 살펴봐요"}[next];
  element("setup-purpose").textContent = index === undefined ? "허용하지 않은 자료는 자동으로 들어오지 않아요. 언제든 다시 고를 수 있어요." : next==="sms"?smsPurpose():purposes[index];
  element("setup-next").textContent = next === "review" ? "실제 수집 여부는 항목별로 확인해 주세요." : "허용은 휴대폰의 공식 화면에서 선택해요.";
  element("setup-action").textContent = next === "review" ? "허용한 자료 보기" : "허용 화면 열기";
  element("setup-skip").hidden = next === "review";
}
function renderSource() {
  if (!latestConnection) return;
  const source = window.SigongnoteConnectionModel.summarize(latestConnection).sources[selectedSource];
  element("source-title").textContent = source.name;
  element("source-health").textContent = source.health;
  element("source-purpose").textContent = selectedSource===2?smsPurpose():purposes[selectedSource];
  element("source-coverage").textContent = source.coverage;
  element("folder-actions").hidden = ![0,3,4].includes(selectedSource);
  element("notification-actions").hidden = selectedSource !== 1;
  element("sms-actions").hidden = selectedSource !== 2 || latestConnection.smsOriginal === "unsupported_standard";
}
function renderConnection(state) {
  latestConnection = state;
  const view = window.SigongnoteConnectionModel.summarize(state);
  const delayed = state.backgroundError || (state.backgroundLastRunAt && Date.now() - state.backgroundLastRunAt > 2 * 60 * 60 * 1000);
  element("connection").textContent = `${view.connected}/${view.denominator}가지 사용 준비${delayed ? " · 최근 확인이 늦어지고 있어요" : ""}`;
  const list = element("connection-sources"); list.replaceChildren();
  [2,4,3,0,1].filter(index=>index!==2||state.smsOriginal!=="unsupported_standard").forEach(index => {
    const source=view.sources[index];
    const row = document.createElement("li"), button = document.createElement("button"); button.type = "button"; button.className = "menu-row";
    const name = document.createElement("strong"), health = document.createElement("span"); name.textContent = source.name; health.textContent = source.health;
    button.append(name,health); button.addEventListener("click",()=>{selectedSource=index;renderSource();show("source");}); row.append(button); list.append(row);
  });
  element("open-sms-inbox").hidden = state.smsRoleHeld !== true;
  element("start-connection").className = state.smsRoleHeld ? "secondary" : "";
  const folders=Array.isArray(state.folderConnections)?state.folderConnections:[];
  element("folder-count").textContent=folders.length?`연결한 폴더 ${folders.length}개 · 회사에 연결 ${state.folderCloudReady || 0}개`:"아직 연결한 폴더가 없어요. 아래에서 첫 폴더를 골라 주세요.";
  element("folder-list").replaceChildren(...folders.map(folder=>{
    const row=document.createElement("li"),name=document.createElement("strong"),status=document.createElement("span");
    name.textContent=folder.name || "업무 폴더";
    status.textContent=!folder.readable?"폴더를 다시 선택해 읽기 권한을 확인해 주세요.":folder.bindingState==="needs_attention"?"회사 연결을 다시 확인해 주세요.":folder.bindingState==="ready"?"회사 자료에 연결됨 · 새 자료를 계속 살펴봐요.":folder.bindingState==="local_only"?"휴대폰에만 보관 · PC와 함께 보려면 로그인 후 다시 선택해 주세요.":"회사 연결을 기다리고 있어요.";
    row.append(name,status);return row;
  }));
  renderSetup(); renderSource();
}
function renderQueue(summary) {
  const problems = [];
  if (summary.storageError || summary.storageFailures > 0) problems.push("저장 공간 문제로 못 받은 자료가 있어요. 원래 앱에서 다시 공유해 주세요.");
  if (summary.networkConnected === false && summary.pending > 0) problems.push("인터넷이 없어 전송을 기다려요.");
  if (summary.uploadError === "sign_in_required") problems.push("다시 로그인해 주세요.");
  else if (summary.uploadError === "membership_lost") problems.push("현장 접근 권한이 바뀌어 전송을 멈췄어요.");
  else if (summary.quotaPaused > 0 || summary.uploadError === "storage_quota_paused") problems.push("계정의 원문 보관 한도 100GB로 전송을 기다려요. 자료는 휴대폰에 보관하며, 공간이 생기면 자동으로 이어 보냅니다.");
  else if (summary.notificationApproved > 0 && summary.uploadError === "notification_source_not_ready") problems.push(`업무 알림 ${summary.notificationApproved}건은 서버 전송 허용이 필요해요.`);
  else if (summary.notificationApproved > 0 && summary.uploadError === "notification_access_missing") problems.push(`알림 접근이 꺼져 ${summary.notificationApproved}건을 보내지 못해요.`);
  else if (summary.uploadError === "file_scope_mismatch") problems.push("선택한 자료 종류와 다른 파일이 있어요. 자료 연결을 확인해 주세요. 원본은 그대로 있어요.");
  else if (summary.uploadError) problems.push("보내지 못한 자료를 확인해 주세요.");
  if (summary.revokedPurgePending > 0) problems.push(`읽기를 중지한 자료 ${summary.revokedPurgePending}건을 기기에서 정리해요.`);
  if (summary.uploadBlocked > 0) problems.push(`보내기 전 확인할 자료 ${summary.uploadBlocked}건`);
  element("queue").textContent = problems.length ? problems.join(" ") : `보내기를 기다리는 자료 ${summary.pending || 0}건`;
  const details = [`보내기 대기 ${summary.pending || 0}건`,`이전에 보낸 파일 ${summary.unprovedShareCopies || 0}건은 다시 받을 수 있는지 확인할 때까지 이 휴대폰에 보관합니다.`,`폴더 자료 ${summary.folderStaged || 0}건 · 공유 자료 ${summary.shared || 0}건`,
    `원래 위치에서 못 찾은 자료 ${summary.folderMissing || 0}건`,`업무 대화 선택 전 ${summary.notificationCandidates || 0}건`,
    `고른 업무 대화 ${summary.notificationApproved || 0}건${summary.notificationLimited ? " · 보관 한도 도달" : ""}`,
    `같은 자료 다시 공유 ${summary.duplicate || 0}건`,`큰 파일 대기 ${summary.largePending || 0}건 · 복사 대기 ${summary.receiving || 0}건 · 확인 필요 ${summary.failed || 0}건`];
  element("queue-details").replaceChildren(...details.map(text=>{const li=document.createElement("li");li.textContent=text;return li;}));
}
const guide = [
  ["새 업무자료부터","문자·통화 녹음·사진 중 필요한 자료만 연결하세요. 과거 자료 전체 정리는 나중에 선택할 수 있어요.","새 자료 연결 선택"],
  ["날짜별 업무일지","같은 계정·회사로 로그인하면 분류 전 도착 기록부터 볼 수 있어요. 일지에서 챙길 일과 문서로 이어집니다.","업무일지 열기"],
  ["필요한 자료는 공유로","사진·문서 앱에서 ‘공유 → 시공노트’를 누르세요. 사용법은 언제든 다시 볼 수 있어요.","내 자료 보기"],
];
function renderGuide() { const item=guide[guideStep];element("guide-title").textContent=item[0];element("guide-copy").textContent=item[1];element("guide-action").textContent=item[2];element("guide-next").textContent=guideStep===2?"처음부터 보기":"다음 사용법"; }
for (const control of document.querySelectorAll("[data-go]")) control.addEventListener("click",()=>show(control.dataset.go));
window.addEventListener("popstate",()=>show(location.hash.slice(1),false));
element("start-connection").addEventListener("click",()=>show("sources"));
element("continue-without").addEventListener("click",()=>show("queue"));
element("setup-action").addEventListener("click",()=>{const next=step();if(next==="review")show("sources");else request("connectSource",{kind:next});});
element("setup-skip").addEventListener("click",()=>{skipped.add(step());renderSetup();});
element("open-sms-inbox").addEventListener("click",()=>request("openSmsInbox"));
element("connect-folder").addEventListener("click",()=>request("connectSource",{kind:({3:"photos",4:"call_recording"})[selectedSource] || "folder"}));
element("add-folder").addEventListener("click",()=>request("connectSource",{kind:"folder"}));
element("connect-notifications").addEventListener("click",()=>request("connectSource",{kind:"notifications"}));
element("connect-sms").addEventListener("click",()=>request("connectSource",{kind:"sms"}));
element("review-notifications").addEventListener("click",()=>request("reviewNotificationScopes"));
element("manage-notifications").addEventListener("click",()=>request("manageNotificationSources"));
element("guide-next").addEventListener("click",()=>{guideStep=(guideStep+1)%3;renderGuide();element("guide-title").scrollIntoView();});
element("guide-action").addEventListener("click",()=>{if(guideStep===0)show("sources");else if(guideStep===1)location.href="work/index.html#/journal";else show("queue");});
if (bridge) {
  bridge.onmessage = event => {
    try {
      const response=JSON.parse(event.data);
      if(response.method==="getConnectionState") {
        if(response.ok)renderConnection(JSON.parse(response.result));
        else element("connection").textContent="허용한 자료를 확인하지 못했어요.";
      } else if(response.method==="getQueueSummary") {
        if(response.ok)renderQueue(JSON.parse(response.result));
        else element("queue").textContent="받은 자료를 확인하지 못했어요.";
      } else if(response.method==="connectSource") {
        element("notice").hidden=false;
        element("notice").textContent=response.result==="notification_app_excluded"?"문자앱은 알림으로 연결하지 않아요. 다른 업무 앱을 골라 주세요.":response.result==="folder_connected"?"폴더를 연결했어요. 자료를 차례로 읽고 있어요.":response.result==="folder_overlapping_scope"?"이미 연결한 폴더와 범위가 겹쳐요. 연결된 폴더를 먼저 확인해 주세요.":response.result==="folder_permission_restored"?"폴더 읽기 권한을 복구했어요. 이어서 자료를 읽어요.":response.result==="folder_connection_failed"?"폴더 연결을 마치지 못했어요. 읽기 권한과 연결 상태를 확인해 주세요.":response.result==="folder_already_connected"?"이미 연결한 폴더예요.":response.ok?"휴대폰 허용 화면을 확인해 주세요.":"허용하지 않았어요. 나중에 다시 할 수 있어요.";
        request("getConnectionState"); request("getQueueSummary");
      } else if(response.method==="reviewNotificationScopes" || response.method==="manageNotificationSources") {
        if(response.result==="notification_app_excluded") { element("notice").hidden=false;element("notice").textContent="문자앱은 알림으로 연결하지 않아요. 다른 업무 앱을 골라 주세요."; }
        request("getQueueSummary");request("getConnectionState");
      } else if(response.method==="openSmsInbox" && !response.ok) {
        element("notice").hidden=false;element("notice").textContent="문자함을 열지 못했어요. 문자 사용 준비를 확인해 주세요.";
      }
    } catch { element("notice").hidden=false;element("notice").textContent="받은 자료를 확인하지 못했어요."; }
  };
  request("getConnectionState");request("getQueueSummary");
  setInterval(()=>{request("getConnectionState");request("getQueueSummary");},10000);
} else { element("connection").textContent="휴대폰 앱에서 사용할 수 있어요."; }
show(location.hash.slice(1),false);
element("welcome-start").addEventListener("click",()=>{try{localStorage.setItem("sigongnote:setup-intro:v2","done");sessionStorage.setItem("sigongnote:intro-shown","1");}catch{}element("setup-welcome").close?.();});
element("setup-welcome").addEventListener("cancel",event=>{event.preventDefault();element("welcome-start").click();});
let welcomeDone=false;try{welcomeDone=localStorage.getItem("sigongnote:setup-intro:v2")==="done";}catch{}
if(!location.hash&&!welcomeDone){element("setup-welcome").showModal?.();element("setup-welcome-title").focus({preventScroll:true});}
