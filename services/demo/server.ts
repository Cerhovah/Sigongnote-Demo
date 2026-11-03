import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import {fieldLedgerCsv,fieldLedgerReportHtml} from '../../packages/domain/src/field-ledger.js';
import {DemoFault,DemoStore,type LedgerQuery} from './store.js';
import {renderReportPdf} from './pdf.js';

export type DemoServerConfig={dataDir:string;staticDir?:string;port?:number;pollIntervalMs?:number;browserExecutable?:string;pdfRenderer?:(html:string)=>Promise<Buffer>};
const labels:Record<string,string>={SOURCE_CHANGED:'원문 파일이 바뀌었습니다.',SOURCE_NOT_FOUND:'연결된 원문이 없습니다.',SOURCE_UNAVAILABLE:'원문 파일을 열 수 없습니다.',SNAPSHOT_NOT_FOUND:'해당 보고서를 찾을 수 없습니다.',LEDGER_VERSION_CONFLICT:'같은 기록의 다른 버전이 있습니다.',LEDGER_BUNDLE_INVALID:'업무원장 JSON 형식을 확인해 주세요.',JSON_INVALID:'JSON 파일을 읽을 수 없습니다.',PROJECT_NOT_FOUND:'선택한 현장이 없습니다.',FILE_SIZE:'16MB 이하의 파일을 선택해 주세요.',FORBIDDEN:'이 창에서 다시 시도해 주세요.',PDF_BROWSER_REQUIRED:'PDF 출력용 Edge 또는 Chrome을 설치해 주세요.',PRIVATE_DATA_INVALID:'연결된 자료 묶음을 읽을 수 없습니다.',PRIVATE_DIRECTORY_IN_GIT:'업무자료 폴더는 Git 저장소 밖에 지정해 주세요.'};
function equal(a:string,b:string){const first=Buffer.from(a),second=Buffer.from(b);return first.length===second.length&&timingSafeEqual(first,second);}
const attachment=(name:string)=>`attachment; filename="sigongnote-report"; filename*=UTF-8''${encodeURIComponent(name)}`;
const mime=(filename:string)=>({'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'}[path.extname(filename)]??'application/octet-stream');

export async function createDemoServer(config:DemoServerConfig){
 const store=await new DemoStore(config.dataDir).initialize(),csrfToken=randomBytes(32).toString('hex');
 const app=Fastify({logger:false,bodyLimit:24*1024*1024});
 app.addHook('onRequest',async(request,reply)=>{
  const host=request.headers.host??'';let target:URL;try{target=new URL(`http://${host}`);}catch{throw new DemoFault('FORBIDDEN',403);}
  if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password)throw new DemoFault('FORBIDDEN',403);
  const address=app.server.address(),expectedPort=address&&typeof address==='object'?address.port:config.port;
  if(expectedPort!==undefined&&Number(target.port||80)!==expectedPort)throw new DemoFault('FORBIDDEN',403);
  const origin=request.headers.origin;
  if(origin&&origin!==target.origin)throw new DemoFault('FORBIDDEN',403);
  if(request.url.startsWith('/api/')&&request.headers['sec-fetch-site']==='cross-site')throw new DemoFault('FORBIDDEN',403);
  if(!['GET','HEAD','OPTIONS'].includes(request.method)&&!equal(String(request.headers['x-sigongnote-csrf']??''),csrfToken))throw new DemoFault('FORBIDDEN',403);
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
  reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 });
 app.setErrorHandler((error,_request,reply)=>{
  const code=error instanceof DemoFault?error.code:error instanceof Error&&error.message==='PDF_BROWSER_REQUIRED'?'PDF_BROWSER_REQUIRED':'REQUEST_FAILED';
  reply.status(error instanceof DemoFault?error.statusCode:code==='PDF_BROWSER_REQUIRED'?503:500).send({error:code,message:code.startsWith('LEDGER_CSV_')?'CSV의 업무 ID·현장·날짜·금액·근거 항목을 확인해 주세요.':labels[code]??'요청을 처리하지 못했습니다.'});
 });
 app.get('/api/ledger',async(request)=>{
  const values=request.query as Record<string,string|undefined>;const query:LedgerQuery={};
  if(values.project)query.projectId=values.project;if(values.from)query.from=values.from;if(values.to)query.to=values.to;if(values.search)query.search=values.search;
  if(values.attribution){if(!['assigned','review','all'].includes(values.attribution))throw new DemoFault('INVALID_FILTER',422);query.attribution=values.attribution as 'assigned'|'review'|'all';}
  const snapshot=await store.snapshot(query);return {projects:snapshot.projects,snapshot,csrfToken};
 });
 app.get('/api/import',async()=>({maxBytes:16*1024*1024,csrfToken}));
 app.post('/api/import',async(request,reply)=>{
  const body=request.body as {name?:unknown;base64?:unknown;projectId?:unknown};
  if(!body||typeof body.name!=='string'||!body.name.trim()||typeof body.base64!=='string'||!body.base64.length||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)||(body.projectId!==null&&body.projectId!==undefined&&typeof body.projectId!=='string'))throw new DemoFault('INVALID_FILE',422);
  const bytes=Buffer.from(body.base64,'base64');const result=await store.importFile(body.name,bytes,(body.projectId as string|null|undefined)??null);
  const snapshot=await store.snapshot(body.projectId?{projectId:String(body.projectId)}:{});reply.code(result.duplicate?200:201);return {...result,snapshot};
 });
 app.get<{Params:{id:string}}>('/api/sources/:id',async(request,reply)=>{
  const source=await store.source(request.params.id);
  const inline=/^(image\/(png|jpeg|webp)|application\/pdf|text\/plain(?:;|$))/.test(source.mime);
  reply.header('Content-Type',source.mime).header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',inline?`inline; filename*=UTF-8''${encodeURIComponent(source.name)}`:attachment(source.name)).header('ETag',`"${source.sha256}"`);return reply.send(source.bytes);
 });
 app.get<{Params:{file:string}}>('/api/snapshots/:file',async(request,reply)=>{
  const match=/^([a-f0-9]{64})\.(csv|html|pdf)$/.exec(request.params.file);if(!match?.[1])throw new DemoFault('SNAPSHOT_NOT_FOUND',404);
  const snapshot=await store.savedSnapshot(match[1]);const label=`${snapshot.project?.name??'전체현장'}_업무현황_${snapshot.id.slice(0,8)}`;
  if(match[2]==='csv')return reply.type('text/csv;charset=utf-8').header('Content-Disposition',attachment(label+'.csv')).send(fieldLedgerCsv(snapshot));
  const html=fieldLedgerReportHtml(snapshot);
  if(match[2]==='html')return reply.type('text/html;charset=utf-8').header('Content-Disposition',attachment(label+'.html')).send(html);
  const pdfPath=path.join(store.dataDir,'snapshots',snapshot.id+'.pdf');let pdf:Buffer;
  try{pdf=await readFile(pdfPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;pdf=await (config.pdfRenderer??(value=>renderReportPdf(value,config.browserExecutable)))(html);try{await writeFile(pdfPath,pdf,{flag:'wx',mode:0o600});}catch(writeError){if((writeError as NodeJS.ErrnoException).code!=='EEXIST')throw writeError;pdf=await readFile(pdfPath);}}
  return reply.type('application/pdf').header('Content-Disposition',attachment(label+'.pdf')).send(pdf);
 });
 app.get('/api/health',async()=>({status:'ready',mode:'local-private-ledger'}));
 app.get('/*',async(request,reply)=>{
  if(!config.staticDir)throw new DemoFault('NOT_FOUND',404);
  const root=path.resolve(config.staticDir),raw=decodeURIComponent(request.url.split('?')[0]??'/');
  const relative=raw==='/'?'index.html':raw.slice(1);if(relative.split(/[\\/]/).some(segment=>segment==='..'||segment.startsWith('.'))||relative.includes('\0'))throw new DemoFault('NOT_FOUND',404);
  const filename=path.resolve(root,relative);if(!filename.startsWith(root+path.sep))throw new DemoFault('NOT_FOUND',404);
  try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw new DemoFault('NOT_FOUND',404);return reply.type(mime(filename)).send(await readFile(filename));}catch(error){if(error instanceof DemoFault)throw error;throw new DemoFault('NOT_FOUND',404);}
 });
 const timer=config.pollIntervalMs===0?null:setInterval(()=>{void store.scanIncoming().catch(()=>undefined);},config.pollIntervalMs??2000);timer?.unref();
 app.addHook('onClose',async()=>{if(timer)clearInterval(timer);});
 await store.scanIncoming();return app;
}
