import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

function shell() {
  const base='apps/android/app/src/main/assets/';
  const dom=new JSDOM(readFileSync(base+'index.html','utf8'),{url:'https://appassets.androidplatform.net/assets/index.html',runScripts:'outside-only'});
  const w=dom.window,calls=[];w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.SigongnoteNative={postMessage:body=>calls.push(JSON.parse(body))};
  w.eval(readFileSync(base+'connection-model.js','utf8'));w.eval(readFileSync(base+'shell.js','utf8'));
  return {w,calls,close:()=>w.close(),send:(method,result,ok=true)=>w.SigongnoteNative.onmessage({data:JSON.stringify({method,ok,result:JSON.stringify(result)})})};
}
test('Android preparation explains one source, skip never grants permission, messenger stays directly reachable',()=>{
  const app=shell(),d=app.w.document;
  try {
    app.send('getConnectionState',{smsOriginal:'role_missing',smsRoleHeld:false});
    d.getElementById('start-connection').click();
    assert.match(d.getElementById('setup-title').textContent,/업무 폴더/);
    assert.match(d.getElementById('setup-purpose').textContent,/원본은 그대로/);
    d.getElementById('setup-skip').click();assert.match(d.getElementById('setup-title').textContent,/업무 알림/);
    d.getElementById('setup-skip').click();assert.match(d.getElementById('setup-purpose').textContent,/기본 문자앱이 바뀌어요/);
    assert.match(d.getElementById('setup-purpose').textContent,/사진 문자 받기는 확인 중/);
    assert.equal(app.calls.filter(c=>c.method==='connectSource').length,0);
    d.getElementById('setup-action').click();assert.deepEqual(app.calls.at(-1).payload,{kind:'sms'});
    app.send('getConnectionState',{smsOriginal:'provider_readable',smsRoleHeld:true,smsNotificationsReady:false});
    assert.equal(d.getElementById('open-sms-inbox').hidden,false);
    assert.match(d.getElementById('connection').textContent,/0\/3/);
    d.getElementById('open-sms-inbox').click();assert.equal(app.calls.at(-1).method,'openSmsInbox');
    for(const page of ['home','setup','sources','source','queue','guide']) {
      app.w.history.pushState(null,'','#'+page);app.w.dispatchEvent(new app.w.PopStateEvent('popstate'));
      const visible=[...d.querySelectorAll('[data-page]')].filter(e=>!e.hidden);
      assert.equal(visible.length,1);assert(visible[0].querySelectorAll('[data-chunk]').length<=2);
    }
  } finally {app.close();}
});
test('Android queue failures remain visible; unknown reply never becomes zero or prepared',()=>{
  const app=shell(),d=app.w.document;
  try {
    app.send('getQueueSummary',{storageFailures:1,networkConnected:false,pending:3,revokedPurgePending:2,notificationApproved:5,uploadError:'notification_source_not_ready'});
    const text=d.getElementById('queue').textContent;
    assert.match(text,/저장 공간 문제/);assert.match(text,/인터넷이 없어/);assert.match(text,/서버 전송 허용/);assert.match(text,/자료 2건/);
    assert.match(d.getElementById('queue-details').textContent,/대기 3건/);
    app.send('getQueueSummary',{notificationApproved:5,uploadError:'notification_access_missing'});
    assert.match(d.getElementById('queue').textContent,/알림 접근이 꺼져 5건/);
    app.send('getConnectionState',{smsOriginal:'unsupported_standard',backgroundLastRunAt:Date.now()-10800000});
    assert.match(d.getElementById('connection').textContent,/최근 확인이 늦어/);
    app.send('getQueueSummary',{},false);assert.match(d.getElementById('queue').textContent,/확인하지 못했어요/);
    assert.doesNotMatch(d.getElementById('queue').textContent,/0건/);
  } finally {app.close();}
});

test('Android folder manager shows independent folders and adding one keeps existing connections',()=>{
  const app=shell(),d=app.w.document;
  try {
    app.send('getConnectionState',{folderSelected:2,folderCloudReady:1,folderConnections:[
      {name:'합성 햇살현장',readable:true,bindingState:'ready'},
      {name:'합성 두번째 현장',readable:false,bindingState:'local_only'},
    ]});
    app.w.history.pushState(null,'','#folders');app.w.dispatchEvent(new app.w.PopStateEvent('popstate'));
    assert.equal(d.querySelector('[data-page="folders"]').hidden,false);
    assert.equal(d.querySelectorAll('#folder-list li').length,2);
    assert.match(d.getElementById('folder-list').textContent,/합성 햇살현장.*회사 자료에 연결됨/);
    assert.match(d.getElementById('folder-list').textContent,/합성 두번째 현장.*읽기 권한/);
    d.getElementById('add-folder').click();
    assert.deepEqual(app.calls.at(-1).payload,{kind:'folder'});
    assert.equal(d.querySelectorAll('#folder-list li').length,2);
    assert.equal(app.calls.filter(c=>c.method==='pauseSource').length,0);
  } finally {app.close();}
});
