import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {WorkObserved} from '../apps/web/src/work-observed.js';
test('N07 observed UI distinguishes dispatch, receipt, uncertain quantity and conditional speech',()=>{
 const html=renderToStaticMarkup(<WorkObserved value={{observed_state:{dispatch:[{subject:'private-id',quantity:'30',unitCode:'ea',eventIds:['a'],uncertain:false}],receipt:[{subject:'private-id',quantity:null,unitCode:'ea',eventIds:['b'],uncertain:true}]},coverage:{auditCount:3,unassertedCount:1,withdrawnCount:0,conflictCount:0}}}/>);
 assert.match(html,/출고/);assert.match(html,/인수/);assert.match(html,/합계를 확인할 단서/);assert.match(html,/예정·조건/);assert.doesNotMatch(html,/private-id|0개|입금 완료|승인 완료/);
 assert.match(html,/기록 없음/);assert.ok(html.indexOf('발주')<html.indexOf('출고'));assert.ok(html.indexOf('청구')<html.indexOf('입금'));
});
