import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
export type FaxResult={state:'submitted'|'delivered'|'failed'|'unknown'|'cancelled';receipt:string|null;chargePages:number|null};
export type FaxProvider={price:(number:string)=>Promise<number>;send:(input:{request:string;number:string;name:string;bytes:Buffer})=>Promise<FaxResult>;lookup:(request:string,number:string)=>Promise<FaxResult>};
const Account=z.strictObject({tenant:z.uuid(),corp:z.string().regex(/^\d{10}$/),user:z.string().min(1).max(50),sender:z.string().regex(/^0\d{8,11}$/),max_page_krw:z.number().int().positive().max(1000),day_krw:z.number().int().positive().max(10000),month_krw:z.number().int().positive().max(50000),valid_until:z.iso.datetime()});
export type FaxAccount=z.infer<typeof Account>;
export type FaxRuntime={binding:string;accounts:FaxAccount[];provider:(a:FaxAccount)=>FaxProvider;webhookKey?:string;webhookUntil?:string};
export const faxAccountHash=(a:FaxAccount,binding:string)=>createHash('sha256').update(JSON.stringify({binding,tenant:a.tenant,corp:a.corp,user:a.user,sender:a.sender})).digest('hex');
export function faxResult(rows:unknown,request:string,number:string):FaxResult{
 const schema=z.array(z.object({state:z.number().int(),result:z.number().int().optional(),requestNum:z.string(),receiveNum:z.string(),receiptNum:z.string().regex(/^\d{18}$/),chargePageCnt:z.number().int().nonnegative().max(100).optional(),refundPageCnt:z.number().int().nonnegative().max(100).optional()})).length(1);
 const parsed=schema.safeParse(rows);if(!parsed.success)return {state:'unknown',receipt:null,chargePages:null};const r=parsed.data[0]!;if(r.requestNum!==request||r.receiveNum.replace(/[\s-]/g,'')!==number)return {state:'unknown',receipt:null,chargePages:null};
 const state=r.state===4?'cancelled':r.state===3?r.result===100?'delivered':[506,517].includes(r.result??0)?'unknown':[300,301,402,405,407,408,410,412,413,414,415,416,417,498,499,501,502,503,504,505,507,508,509,511,512,513,514,516,518,800,802,909,910,911,912,934,998,999].includes(r.result??0)?'failed':'unknown':[0,1,2].includes(r.state)?'submitted':'unknown';
 const final=r.state===3||r.state===4;return {state,receipt:r.receiptNum,chargePages:final&&r.chargePageCnt!==undefined&&r.refundPageCnt!==undefined&&r.refundPageCnt<=r.chargePageCnt?r.chargePageCnt-r.refundPageCnt:null};
}
/** Official Popbill SDK; no SDK outcome/error text enters public logs. */
export function popbillProvider(sdk:any,a:FaxAccount):FaxProvider{
 const call=<T>(method:string,args:unknown[])=>new Promise<T>((resolve,reject)=>{
  let ended=false;const timer=setTimeout(()=>{ended=true;reject(Error('FAX_UNKNOWN'));},60000);
  try{sdk[method](...args,(value:T)=>{clearTimeout(timer);if(!ended)resolve(value);},()=>{clearTimeout(timer);if(!ended)reject(Error('FAX_UNKNOWN'));});}
  catch{clearTimeout(timer);ended=true;reject(Error('FAX_UNKNOWN'));}
 });
 return {
  async price(number){const kind=/^(030|050|070|080|15|16|18)/.test(number)?'지능':'일반';const n=Number(await call('getUnitCost',[a.corp,kind,a.user]));if(!Number.isFinite(n)||n<=0||n>1000)throw Error('FAX_PRICE');return n;},
  async send(input){const dir=await mkdtemp(join(tmpdir(),'sigongnote-fax-'));try{const path=join(dir,'document.pdf');await writeFile(path,input.bytes,{mode:0o600});const receipt=await call<string>('sendFax',[a.corp,a.sender,input.number,input.name,[path],'','',false,'현장 문서',input.request,a.user]);if(!/^\d{18}$/.test(receipt))throw Error('FAX_UNKNOWN');return {state:'submitted',receipt,chargePages:null};}finally{await rm(dir,{recursive:true,force:true});}},
  async lookup(request,number){return faxResult(await call('getFaxResultRN',[a.corp,request,a.user]),request,number);}
 };
}
export function configuredFax(env:NodeJS.ProcessEnv=process.env):FaxRuntime|undefined{
 if(env.FAX_ENABLED!=='true')return undefined;
 try{const accounts=z.array(Account).min(1).max(100).parse(JSON.parse(env.FAX_ACCOUNTS_JSON??''));if(new Set(accounts.map(a=>a.tenant)).size!==accounts.length||new Set(accounts.map(a=>a.corp)).size!==accounts.length)return undefined;if(!env.POPBILL_LINK_ID||!env.POPBILL_SECRET_KEY||!['true','false'].includes(env.POPBILL_IS_TEST??''))return undefined;
  // Instantiate separately; avoid SDK module-level service singleton sharing changed configuration.
  const Constructor=createRequire(import.meta.url)('popbill/lib/FaxService');const sdk=new Constructor({LinkID:env.POPBILL_LINK_ID,SecretKey:env.POPBILL_SECRET_KEY,IsTest:env.POPBILL_IS_TEST==='true',IPRestrictOnOff:true,UseStaticIP:false,UseLocalTimeYN:false});
  const binding=createHash('sha256').update(JSON.stringify({provider:'popbill',test:env.POPBILL_IS_TEST==='true',link:env.POPBILL_LINK_ID})).digest('hex');
  const key=env.FAX_WEBHOOK_KEY,until=env.FAX_WEBHOOK_VALID_UNTIL;return {binding,accounts,provider:a=>popbillProvider(sdk,a),...(key&&key.length>=32&&until?{webhookKey:key,webhookUntil:until}:{})};
 }catch{return undefined;}
}
