import test from 'node:test';import assert from 'node:assert/strict';import {renderToStaticMarkup} from 'react-dom/server';import {OperationsPanel,type OperationsReport} from '../apps/web/src/work-operations.js';
test('N30 operator view labels reservations/unknown and company versus user scope without product acceptance',()=>{
 const html=renderToStaticMarkup(<OperationsPanel value={{checked_at:new Date().toISOString(),queues:[{kind:'parse_original',pending:4,expired_leases:1,failed:2,oldest_seconds:600}],outbox:{pending:2},delivery:{unknown:1,known_krw:'0',reserved_krw:'100'},budget:{daily_krw:'123',monthly_krw:'123',unknown_count:1},storage:{used_bytes:99900000000,reserved_bytes:100000000,limit_bytes:100000000000},worker:{enabled:true,ready:false},release:{source_sha:null,status:'unverified'},acceptance:'not_evaluated'}}/>);
 assert.match(html,/대기 4건/);assert.match(html,/재개 대기 1건/);assert.match(html,/미확정 예약 100원/);assert.match(html,/내 계정 전체 회사/);assert.match(html,/확인 전/);assert.match(html,/사용자 만족도를 뜻하지 않습니다/);
});
test('N30 partial or invalid metrics remain unknown instead of throwing or becoming zero',()=>{
 for(const value of [{},{budget:{daily_krw:null,monthly_krw:'invalid'},delivery:{known_krw:'',reserved_krw:'1.5'},storage:{used_bytes:null}}]){
  const html=renderToStaticMarkup(<OperationsPanel value={value as unknown as OperationsReport}/>);assert.match(html,/확인 전/);assert.doesNotMatch(html,/NaN|undefined|0원|0\.00GB/);
 }
});
