import "./work-ledger.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LocalApp } from "./local-app.js";
import "./tokens.css";
import "./style.css";
import "./focus.css";
import "./work.css";
import "./setup.css";
import "./work-desktop.css";
import "./work-photos.css";
import "./cloud.css";
import "./work-activity.css";
import "./work-local.css";
import { WorkApp } from "./work-app.js";
import { localWorkClient,nativeWorkClient,type WorkClient } from "./work-client.js";
import {entryMode} from "./entry-mode.js";
import {ensurePaired} from './local-api.js';

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
const parameters=new URLSearchParams(location.search);
const render=(work:WorkClient|null)=>createRoot(root).render(<StrictMode>{work?<WorkApp client={work}/>:<LocalApp />}</StrictMode>);
const mode=entryMode(location.href,Boolean(window.SigongnoteNative||window.chrome?.webview));
// Synthetic screen preview (`?work=preview`) exists only in the Vite dev server for ui-preview and scripts/ui-shots.mjs; production and native bundles drop this branch.
if(import.meta.env.DEV&&parameters.get("work")==="preview"){
 root.dataset.workPreview="synthetic";
 void import("./work-preview-client.js").then(m=>render(m.previewWorkClient({firstUse:parameters.get("scenario")==="first-use"})));
}
else{
 if(mode==='cloud'||mode==='install'){for(const [rel,href]of [['manifest','/manifest.webmanifest'],['icon','/app-icon.svg']]){const link=document.createElement('link');link.rel=rel!;link.href=href!;document.head.append(link);}}
 if(mode==='install')void import('./install-app.js').then(m=>createRoot(root).render(<StrictMode><m.InstallApp/></StrictMode>));
 else if(mode==='cloud'){
  if(parameters.has('demo')||parameters.has('work'))history.replaceState(null,'',location.pathname+(parameters.get('login')==='retry'?'?login=retry':'')+location.hash);
  void import('./cloud-app.js').then(m=>createRoot(root).render(<StrictMode><m.CloudApp/></StrictMode>));
 }else if(mode==='local-work')void ensurePaired().then(()=>render(localWorkClient())).catch(()=>render(localWorkClient()));
 else render(mode==='native'?nativeWorkClient():null);
}
