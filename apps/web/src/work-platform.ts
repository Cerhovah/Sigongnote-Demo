import type {WorkClient} from "./work-client.js";
/**
 * Which real connection actions this screen can offer. The Android app connects messages, call recordings and
 * photos; the Windows app connects a folder; the website can only accept chosen files for one site.
 */
export type Platform="android"|"windows"|"web"|"local"|"fixture";
export function platformOf(client:WorkClient):Platform{
 if(client.kind==="native")return window.SigongnoteNative?"android":"windows";
 if(client.kind==="remote")return "web";
 return client.kind;
}
/** The Windows app intercepts this exact address and opens its own folder-connection dialog. */
export const windowsFolderSetup="https://sigongnote.work/setup-folder";
export const windowsRecordingSetup="https://sigongnote.work/setup-recording";
/** Android only: ask the app to start one connection flow (permission and folder choice happen natively). */
export function connectAndroidSource(kind:"sms"|"call_recording"|"photos",requestId:string){
 window.SigongnoteNative?.postMessage(JSON.stringify({bridgeVersion:1,requestId,method:"connectSource",payload:{kind}}));
}
