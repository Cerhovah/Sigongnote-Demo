import type {WorkClient,WorkContext} from './work-client.js';
import {platformOf} from './work-platform.js';
export type SetupStep='connect'|'upload'|'verify'|'devices'|'learn';
export type SetupProgress={step:SetupStep;project:string;material?:string;done?:boolean;paused?:boolean};
export function setupProgressKey(context:WorkContext,client:WorkClient){return `sigongnote:start:v1:${context.tenant_id}:${context.user_id}:${platformOf(client)}`;}
export function readSetupProgress(key:string):SetupProgress|null{
 try{const p=JSON.parse(window.localStorage.getItem(key)??'null');return p&&['connect','upload','verify','devices','learn'].includes(p.step)&&typeof p.project==='string'&&(!p.material||typeof p.material==='string')?p:null;}catch{return null;}
}
export function writeSetupProgress(key:string,value:SetupProgress){try{window.localStorage.setItem(key,JSON.stringify(value));}catch{/* Server selection still resumes; blocked browser storage must not block setup. */}}
/** Retained for older callers. Connections are optional and never intercept a work route. */
export function needsDeviceSetup(_context:WorkContext,_client:WorkClient){return false;}
