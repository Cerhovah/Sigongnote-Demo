import assert from "node:assert/strict";
import {test} from "node:test";
import {captureCapability,sourceAllowsMime,sourcePolicyCurrent,LOCAL_CAPTURE_POLICY} from "../services/api/src/capture-scope.ts";
import {sniffMime} from "../services/api/src/ingestions.ts";

const scope={capture_method:"saf_tree",history_mode:"all",history_since:null,
 scope_mode:"work_dedicated",rule_version:1,processing_policy_id:"local-fixture-v1",
 fingerprint_algorithm:"hmac-sha256-device-v1"};
test("D02 scope distinguishes folders, selected photos and recordings without SMS bypass",()=>{
 assert.equal(captureCapability("photos","android",scope),"passive");
 assert.equal(captureCapability("photos","windows",scope),"unsupported");
 assert.equal(captureCapability("photos","windows",{...scope,capture_method:"filesystem"}),"passive");
 assert.equal(captureCapability("photos","android",{...scope,capture_method:"selected_media"}),"selected_items");
 assert.equal(captureCapability("sms","android",scope),"policy_gated");
 assert.equal(sourceAllowsMime("folder",scope,"audio/mp4"),false);
 assert.equal(sourceAllowsMime("folder",scope,"application/pdf"),true);
 assert.equal(sourceAllowsMime("photos",scope,"application/pdf"),false);
 assert.equal(sourceAllowsMime("photos",scope,"image/jpeg"),true);
 assert.equal(sourceAllowsMime("call_recording",scope,"audio/mp4"),true);
 assert.equal(sourceAllowsMime("call_recording",scope,"video/mp4"),false);
 assert.equal(sourceAllowsMime("photos",{...scope,scope_mode:"mixed_hold"},"image/jpeg"),false);
 assert.equal(sourceAllowsMime("photos",{scope_mode:"work_dedicated"},"image/jpeg"),false);
});
test("D02 container detection does not identify arbitrary MP4 as a voice recording",()=>{
 const mp4=(brand:string)=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from(`ftyp${brand}`),Buffer.alloc(12)]);
 assert.equal(sniffMime(mp4("M4A ")),"audio/mp4");
 assert.equal(sniffMime(mp4("isom")),"video/mp4");
 assert.equal(sniffMime(mp4("heic")),"image/heic");
 assert.equal(sniffMime(Buffer.from("RIFF0000WAVEfmt ")),"audio/wav");
 assert.equal(sniffMime(Buffer.from("RIFF0000WEBPVP8 ")),"image/webp");
});

test("D02 changed destination requires a new grant even if deployment reuses the policy id",()=>{
 assert.equal(sourcePolicyCurrent(scope,LOCAL_CAPTURE_POLICY,LOCAL_CAPTURE_POLICY),true);
 assert.equal(sourcePolicyCurrent(scope,LOCAL_CAPTURE_POLICY),false);
 assert.equal(sourcePolicyCurrent(scope,LOCAL_CAPTURE_POLICY,{...LOCAL_CAPTURE_POLICY,storage_location:"elsewhere"}),false);
 assert.equal(sourceAllowsMime("folder",scope,"application/octet-stream"),true);
 assert.equal(sniffMime(Buffer.from("AC1027 fixture")),"image/vnd.dwg");
 assert.equal(sniffMime(Buffer.from("#!AMR\nfixture")),"audio/amr");
});
