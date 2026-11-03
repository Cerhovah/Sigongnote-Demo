import { CaptureScopeSchema, capturePolicyEqual } from "@sigongnote/contracts";

export type {CapturePolicy} from '@sigongnote/contracts';
import type {CapturePolicy} from '@sigongnote/contracts';
export const LOCAL_CAPTURE_POLICY: CapturePolicy = {
 id:"local-fixture-v1",purpose:"work_records",provider:"local_fixture",
 processing_location:"development_computer",storage_location:"development_computer",
 retention:"until_user_deletes",external_processing:false,
};

export function captureLane(scope:unknown):'archive'|'current'{const p=CaptureScopeSchema.safeParse(scope);return p.success&&p.data.processing_lane==='archive'?'archive':'current';}
export function captureCapability(kind:string,platform:string,scope?:unknown):string {
 if(platform==='web'){
  const selected=CaptureScopeSchema.safeParse(scope);
  return ['manual_share','call_recording'].includes(kind)&&selected.success&&selected.data.capture_method==='manual_share'&&selected.data.history_mode==='selected'&&selected.data.scope_mode==='selected_items'?'manual_only':'unsupported';
 }
 if(kind==="sms" || kind==="call_log")return "policy_gated";
 if(kind==="manual_share")return "manual_only";
 if(kind==="notifications")return platform==="android"?"passive":"unsupported";
 if(scope){
  const parsed=CaptureScopeSchema.safeParse(scope);
  if(!parsed.success)return "unsupported";
  const method=parsed.data.capture_method;
  if(method==="saf_tree")return platform==="android"?"passive":"unsupported";
  if(method==="filesystem")return platform==="windows"?"passive":"unsupported";
  if(method==="selected_media")return platform==="android"?"selected_items":"unsupported";
 }
 if(kind==="photos")return platform==="android"?"selected_items":"unsupported";
 return "passive";
}

/** Only v2 sources have explicit purpose scope; old sources remain compatible. */
export function sourceAllowsMime(kind:unknown,scope:unknown,mime:string):boolean {
 if(['image/x-dwg','image/vnd.dwg','application/acad','application/x-autocad','image/vnd.dxf','application/dxf'].includes(mime))return false;
 if(mime==='application/vnd.sigongnote.message+json' && kind!=='sms' && kind!=='manual_share')return false;
 if(kind==='sms' && mime!=='application/vnd.sigongnote.message+json')return false;
 if(!scope)return true;
 const parsed=CaptureScopeSchema.safeParse(scope);
 if(!parsed.success || parsed.data.scope_mode==="mixed_hold")return false;
 if(kind==="photos")return ["image/jpeg","image/png","image/webp","image/heic","image/heif"].includes(mime);
 if(kind==="call_recording")return ["audio/wav","audio/x-wav","audio/mp4","audio/mpeg","audio/aac","audio/ogg","audio/flac","audio/x-m4a","audio/3gpp","audio/amr"].includes(mime);
 if(kind==="folder")return !mime.startsWith("audio/");
 return true;
}

export function sourcePolicyCurrent(scope:unknown,stored:unknown,current?:CapturePolicy):boolean {
 if(!scope)return true;
 return !!current&&capturePolicyEqual(stored,current);
}
