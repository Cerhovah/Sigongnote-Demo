import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {faxResult,popbillProvider,configuredFax} from '../services/api/src/fax-provider.js';
test('N20 Popbill adapter uses pinned request number and authenticates result association',async()=>{
 const request='11111111-1111-4111-8111-111111111111',number='00000000000';
 const record={state:3,result:100,requestNum:request,receiveNum:number,receiptNum:'000000000000000001',chargePageCnt:2,refundPageCnt:0};
 assert.equal(faxResult([record],request,number).state,'delivered');assert.equal(faxResult([{...record,receiveNum:'000-0000-0000'}],request,number).state,'delivered');assert.equal(faxResult([{...record,result:506}],request,number).state,'unknown');assert.equal(faxResult([{...record,result:502}],request,number).state,'failed');assert.equal(faxResult([record],request,'00000000001').state,'unknown');assert.equal(faxResult([{...record,chargePageCnt:undefined}],request,number).chargePages,null);
 let sent=false;const Constructor=createRequire(import.meta.url)('popbill/lib/FaxService'),sdk=new Constructor({LinkID:'SYNTHETIC',SecretKey:'not-a-live-key',IsTest:true});
 // Exercise the pinned SDK's real overloads; replace only its network boundary.
 sdk._executeAction=(action:any)=>{assert.equal(action.CorpNum,'0000000000');assert.equal(action.UserID,'synthetic');if(action.uri.startsWith('/FAX/UnitCost?')){assert.ok(action.uri.endsWith(encodeURIComponent('일반')));action.success({unitCost:'42.5'});}else if(action.uri==='/FAX'){const body=JSON.parse(action.Data);assert.equal(body.requestNum,request);assert.equal(body.rcvs[0].rcv,number);assert.equal(body.adsYN,false);assert.equal(readFileSync(action.Files[0].fileName,'utf8'),'%PDF-synthetic');sent=true;action.success({receiptNum:'000000000000000001'});}else{assert.equal(action.uri,'/FAX/Get/'+request);action.success([record]);}};
 const provider=popbillProvider(sdk,{tenant:request,corp:'0000000000',user:'synthetic',sender:number,max_page_krw:100,day_krw:1000,month_krw:1000,valid_until:'2099-01-01T00:00:00Z'});
 assert.equal(await provider.price(number),42.5);assert.equal((await provider.send({request,number,name:'합성',bytes:Buffer.from('%PDF-synthetic')})).state,'submitted');assert.equal(sent,true);assert.equal((await provider.lookup(request,number)).chargePages,2);assert.equal(configuredFax({}),undefined);
});
