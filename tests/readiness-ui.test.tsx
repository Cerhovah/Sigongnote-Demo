import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {ReadinessDetails} from '../apps/web/src/work-maintenance.js';
import {buildReadiness} from '../services/api/src/readiness.js';
test('N01 UX distinguishes unverified scope and reconnects the affected device without disabling the page',()=>{
 const value=buildReadiness([{id:'10000000-0000-4000-8000-000000000001',kind:'folder',active:true,device_active:true,server_upload_consent:true,permission:'revoked',reported_permission:null,capability:'passive',last_successful_scan_at:null,permission_checked_at:null,last_error_code:null,pending_count:0}],{},new Date("2026-10-03T00:00:00Z"));
 const html=renderToStaticMarkup(<ReadinessDetails value={value}/>);
 assert.match(html,/권한 다시 연결/);assert.match(html,/#\/folders/);assert.match(html,/월 5만원/);assert.match(html,/준비 중/);assert.match(html,/본문 판독 별도 준비/);
 assert.ok(!html.includes('10000000-0000'));assert.ok(!html.includes('disabled'));
});
