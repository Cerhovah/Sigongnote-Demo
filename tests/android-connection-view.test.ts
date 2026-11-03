import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const context = runInNewContext(readFileSync(
  "apps/android/app/src/main/assets/connection-model.js", "utf8") +
  "\nSigongnoteConnectionModel");
const summarize = context.summarize as (state: Record<string, unknown>) => {
  connected: number; denominator: number; sources: Array<{
    health: string; capability: string; coverage: string;
  }>;
};

test("first-run setup skips denied steps without pretending they are granted", () => {
  const next = context.nextSetupStep as (state: Record<string, unknown>) => string;
  const state = {smsOriginal:"role_missing"};
  assert.equal(next(state),"folder");
  assert.equal(next({...state,setupAttempted:"folder"}),"notifications");
  assert.equal(next({...state,setupAttempted:"folder,notifications"}),"sms");
  assert.equal(next({...state,setupAttempted:"sms,folder,notifications"}),"review");
  assert.equal(summarize({...state,setupAttempted:"sms,folder,notifications"}).connected,0);
  assert.equal(next({smsOriginal:"unsupported_standard"}),"folder");
  assert.equal(next({smsOriginal:"provider_readable"}),"folder");
  assert.equal(next({smsOriginal:"unsupported_standard",setupAttempted:"folder,notifications"}),"review");
  assert.equal(next({smsOriginal:"provider_readable",smsNotificationsReady:false,
    setupAttempted:"folder,notifications"}),"sms");
  assert.equal(next({smsOriginal:"provider_readable",smsNotificationsReady:true,
    setupAttempted:"folder,notifications"}),"review");
});

test("C42 only measured passive sources count; unsupported and selected-only channels stay out", () => {
  const empty = summarize({ smsOriginal: "unsupported_standard", folders: 0,
    folderSelected: 0, notificationApps: 0, notificationAccess: false,
    notificationListening: false });
  assert.equal(empty.connected, 0);
  assert.equal(empty.denominator, 2);
  assert.match(empty.sources[2]?.capability ?? "", /미지원/);
  assert.match(empty.sources[3]?.health ?? "", /아직 고르지/);

  const denied = summarize({ smsOriginal: "unsupported_standard", folders: 0,
    folderSelected: 1, folderReadable: 0, notificationApps: 1,
    notificationAccess: false, notificationListening: false });
  assert.equal(denied.connected, 0);
  assert.match(denied.sources[0]?.health ?? "", /권한 확인 필요/);
  assert.match(denied.sources[1]?.health ?? "", /승인 필요/);

  const partialState = { smsOriginal: "unsupported_standard", folders: 1,
    folderSelected: 1, folderReadable: 1, folderObserved: 17, folderEligible: 12,
    folderExcluded: 3, folderPending: 2, notificationApps: 1,
    notificationAccess: true, notificationListening: false };
  const partial = summarize(partialState);
  assert.equal(partial.connected, 1);
  assert.match(partial.sources[0]?.coverage ?? "", /대상 12, 제외 3, 대기 2/);
  assert.match(partial.sources[1]?.health ?? "", /새 알림 확인 필요/);

  const complete = summarize({ ...partialState, notificationListening: true });
  assert.equal(complete.connected, 2);
  assert.equal(complete.denominator, 2);
  const stale = summarize({ ...partialState, folders: 0, notificationListening: true });
  assert.equal(stale.connected, 1);
  assert.match(stale.sources[0]?.health ?? "", /최근 확인 지연/);
  const partialGrant = summarize({ ...partialState, folderSelected: 2,
    notificationListening: true });
  assert.equal(partialGrant.connected, 1);
  assert.match(partialGrant.sources[0]?.health ?? "", /일부 폴더/);
  const smsRole = summarize({ ...partialState, notificationListening: true,
    smsOriginal: "role_missing" });
  assert.equal(smsRole.connected, 2);
  assert.equal(smsRole.denominator, 3);
  assert.equal(summarize({ ...partialState, notificationListening: true,
    smsOriginal: "role_granted_unverified" }).connected, 2);
  assert.equal(summarize({ ...partialState, notificationListening: true,
    smsOriginal: "provider_readable", smsNotificationsReady: true }).connected, 3);
  const muted = summarize({ ...partialState, notificationListening: true,
    smsOriginal: "provider_readable", smsNotificationsReady: false });
  assert.equal(muted.connected, 2);
  assert.match(muted.sources[2]?.health ?? "", /도착 알림 확인 필요/);
  assert.equal(summarize({ ...partialState, notificationListening: true,
    smsOriginal: "provider_readable" }).connected, 2);
});

test("D03 partial and quota coverage stays visible without reporting complete",()=>{
 const state={smsOriginal:"unsupported_standard",folderSelected:1,folderReadable:1,folders:0};
 assert.match(summarize({...state,folderScanning:1}).sources[0]?.health ?? "",/읽는 중/);
 assert.match(summarize({...state,folderQuotaPaused:1}).sources[0]?.health ?? "",/보관 한도/);
 assert.match(summarize({...state,folderQuotaPaused:1,folderDeviceLow:1}).sources[0]?.health ?? "",/공간을 비우면/);
 assert.match(summarize({...state,folderNeedsCheck:1}).sources[0]?.health ?? "",/일부 자료/);
 assert.equal(summarize({...state,folderQuotaPaused:1}).connected,0);
});
