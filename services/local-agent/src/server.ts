import { WorkRequestSchema, workHttp } from "@sigongnote/contracts";
import { renderApprovedQuote } from "./quote-render.js";
import type { LocalBackup } from "./backup.js";
import { type FieldBridge, reportCsv } from "./field-bridge.js";
import Fastify from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LocalAgent } from "./agent.js";
import type { LocalAi } from "./ai.js";
import { mimeFor } from './journal.js';

const Id = z.string().uuid();
export function createLocalServer(agent: LocalAgent, ai: LocalAi, options: {
  backup?: LocalBackup; field?: FieldBridge; port: number; webDir: string; pairToken: string; pickFolder?: () => Promise<string | null>;
}) {
  const app = Fastify({ logger: false, bodyLimit: 32_768 });
  const origin = `http://127.0.0.1:${options.port}`;
  const cookieName = `sigongnote_local_${options.port}`;
  const session = randomBytes(32).toString("hex");
  const pairToken = options.pairToken;
  let pickerBusy = false;
  const equal = (a: string, b: string) => { const first = Buffer.from(a); const second = Buffer.from(b); return first.length === second.length && timingSafeEqual(first, second); };
  const start = () => { void agent.start().catch(() => { agent.audit("background_scan_failed", "local"); }); };
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer").header("Cross-Origin-Resource-Policy", "same-origin")
      .header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.headers.host !== `127.0.0.1:${options.port}`) return reply.code(403).send({ error: "HOST_REJECTED" });
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send({ error: "ORIGIN_REJECTED" });
    if (request.url.startsWith("/api/")) {
      if (request.headers["x-sigongnote-local"] !== "1") return reply.code(403).send({ error: "LOCAL_CLIENT_REQUIRED" });
      if (request.url === "/api/pair" && request.method === "POST") return;
      const cookie = String(request.headers.cookie ?? "").split("; ").find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
      if (!equal(cookie, session)) return reply.code(401).send({ error: "OPEN_FROM_LOCAL_LAUNCHER" });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const allowed = /^(SOURCE_NOT_FOUND|DOCUMENT_NOT_FOUND|NOT_READ_YET|SOURCE_CHANGED|SCOPE_REVOKED|COPY_CORRUPT|INVALID_[A-Z_]+|STALE_[A-Z_]+|SITE_ANSWER_REQUIRED|PLAN_[A-Z_]+|AI_[A-Z_]+|CLOUD_[A-Z_]+|EXTERNAL_AI_NOT_CONSENTED|NO_READABLE_TEXT|DAILY_CALL_LIMIT|CONSENT_EXPIRED_OR_USED|OVERLAPPING_ROOT|DIFFERENT_DRIVE|FOLDER_PICKER_UNAVAILABLE|FIELD_[A-Z_]+|MANAGED_[A-Z_]+|SITE_MAPPING_CONFLICT)$/;
    reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error && allowed.test(error.message) ? error.message : "LOCAL_OPERATION_FAILED" });
  });
  app.post("/api/pair", async (request, reply) => {
    const { token } = z.object({ token: z.string().max(128) }).parse(request.body);
    if (!pairToken || !equal(token, pairToken)) return reply.code(401).send({ error: "PAIRING_EXPIRED" });
    reply.header("Set-Cookie", `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    return { paired: true };
  });
  app.get("/api/status", async () => ({ ...agent.summary(), ai: ai.info(), field: options.field?.info() ?? {configured:false} }));
  app.get('/api/local/status',async()=>({...agent.journal.status(),cloud:agent.cloud?.info()??{connected:false,pending:0}}));
  app.post('/api/local/refresh',async()=>{start();return {started:true};});
  app.post('/api/local/organize',async()=>{await agent.cloud?.currentSession();const result=agent.journal.organizeHistory();start();return result;});
  let importTail:Promise<unknown>=Promise.resolve();
  app.post('/api/local/import',{bodyLimit:71_000_000},async request=>{
    const input=z.object({name:z.string().min(1).max(240),base64:z.string().max(70_000_000),project_id:Id.optional()}).strict().parse(request.body);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames exclude control characters.
    if(path.basename(input.name)!==input.name||/[<>:"/\\|?*\x00-\x1f]/.test(input.name)||/[. ]$/.test(input.name))throw new Error('INVALID_FILENAME');
    const bytes=Buffer.from(input.base64,'base64');if(!bytes.length||bytes.length>50*1024*1024)throw new Error('INVALID_FILE_SIZE');
    const work=importTail.catch(()=>{}).then(async()=>{
      await agent.cloud?.currentSession();
      await agent.start(false);
      const root=path.join(path.dirname(agent.dataDir),'Incoming');await mkdir(root,{recursive:true});
      const source=agent.sources().find(s=>s.root===root)??await agent.grant(root,'explicit_user_request');
      if(!source.last_scan)await agent.inventory(source);
      const project=input.project_id?agent.journal.projects().find(p=>p.id===input.project_id):undefined;
      if(input.project_id&&!project)throw new Error('INVALID_PROJECT');
      const directory=path.join(root,...(project?[project.display_name]:[]),randomBytes(8).toString('hex'));await mkdir(directory,{recursive:true});
      const filename=input.name;
      await writeFile(path.join(directory,filename),bytes,{flag:'wx'});
      await agent.inventory(agent.source(source.id));
      const row=agent.db.prepare('SELECT id FROM documents WHERE source_id=? AND relative_path=?').get(source.id,path.relative(root,path.join(directory,filename)));
      if(!row)throw new Error('INVALID_FILE_TYPE');
      if(project){agent.db.prepare('UPDATE documents SET site=? WHERE id=?').run(project.display_name,String(row.id));agent.db.prepare("INSERT OR REPLACE INTO document_site_origins VALUES(?,'manual')").run(String(row.id));}
      start();return {id:String(row.id)};
    });importTail=work;return work;
  });
  app.get('/health/local',async()=>({contract:2,mode:'local'}));
  app.post("/api/folders/pick", async () => {
    if (pickerBusy) throw new Error("FOLDER_PICKER_UNAVAILABLE");
    if (!options.pickFolder) throw new Error("FOLDER_PICKER_UNAVAILABLE");
    pickerBusy = true;
    try {
      const folder = await options.pickFolder();
      if (!folder) return { cancelled: true };
      const source = await agent.grant(folder, "native_picker");
      start();
      const children = await readdir(folder, { withFileTypes: true }).catch(() => []);
      const commonSuggested = children.filter(item => item.isDirectory() && !item.isSymbolicLink() && !item.name.startsWith(".") && item.name !== "시공노트").length >= 2;
      return { source, commonSuggested };
    } finally { pickerBusy = false; }
  });
  app.post("/api/folders/:id/site", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    const { site, approved } = z.object({ site: z.string().trim().min(1).max(80).nullable(), approved: z.literal(true) }).strict().parse(request.body);
    return agent.siteFolders.connect(id, site, approved);
  });
  app.post("/api/folders/:id/site/refresh", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    await agent.siteFolders.refresh(id); return { refreshed: true };
  });
  app.post("/api/folders/:id", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    agent.setEnabled(id, enabled);
    if (enabled) start();
    return { updated: true };
  });
  app.post("/api/scan", async () => { start(); return { started: true }; });
  app.post("/api/folders/:id/answer", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    const { directory, answer, site } = z.object({ directory: z.string().max(1024), answer: z.enum(["site", "mixed", "later"]), site: z.string().max(80).optional() }).parse(request.body);
    return agent.answerFolder(id, directory, answer, site);
  });
  app.get("/api/documents", async request => {
    const { q, offset } = z.object({ q: z.string().max(100).default(""), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    await agent.cloud?.currentSession();
    return agent.search(q, 40, offset);
  });
  app.get("/api/documents/:id", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    await agent.cloud?.currentSession();agent.cloud?.assertVisible(id);
    const doc = agent.document(id);
    if (!agent.source(doc.source_id).enabled) throw new Error("SCOPE_REVOKED");
    return { ...doc, parsed: JSON.parse(doc.parsed), ai: agent.db.prepare("SELECT result FROM ai_requests WHERE document_id=? AND revision=? AND status='complete' ORDER BY created_at DESC LIMIT 1").get(id, doc.revision)?.result ?? null };
  });
  app.post("/api/documents/:id/site", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    await agent.cloud?.currentSession();agent.cloud?.assertVisible(id);
    const { revision, site } = z.object({ revision: z.number().int().nonnegative(), site: z.string().min(1).max(80) }).parse(request.body);
    agent.answerSite(id, revision, site);
    return { saved: true };
  });
  app.get("/api/documents/:id/copy", async (request, reply) => {
    const { id } = z.object({ id: Id }).parse(request.params);
    await agent.cloud?.currentSession();agent.cloud?.assertVisible(id);
    const { doc, bytes } = await agent.snapshot(id);
    return reply.type("application/octet-stream").header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`).send(bytes);
  });
  app.post("/api/copies/prepare", async request => {
    const { ids } = z.object({ ids: z.array(Id).min(1).max(100) }).parse(request.body);
    await agent.cloud?.currentSession();
    return agent.planCopies(ids);
  });
  app.post("/api/copies/:id/approve", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    await agent.cloud?.currentSession();
    z.object({ approved: z.literal(true) }).parse(request.body);
    return agent.executeCopies(id);
  });
  app.post("/api/ai/prepare", async request => {await agent.cloud?.currentSession();return ai.prepare(z.object({ id: Id }).parse(request.body).id);});
  app.post("/api/ai/:id/approve", async request => {
    const { id } = z.object({ id: Id }).parse(request.params);
    const { consent } = z.object({ consent: z.literal(true) }).parse(request.body);
    return ai.send(id, consent);
  });
  app.post("/api/folders/:id/review",async request=>{
    const {id}=z.object({id:Id}).parse(request.params);const {directory}=z.object({directory:z.string().max(1024)}).parse(request.body);
    agent.reviewFolder(id,directory);return {saved:true};
  });
  app.get("/api/folders/reviews",async()=>agent.db.prepare("SELECT a.source_id,a.relative_dir,a.created_at FROM folder_answers a JOIN sources s ON s.id=a.source_id WHERE s.enabled=1 AND a.answer='later'").all());
  const field=()=>{if(!options.field)throw new Error("FIELD_NOT_CONFIGURED");return options.field;};
  app.post("/api/field/prepare",async request=>{const {id}=z.object({id:Id}).parse(request.body);field().queue(id);await field().flush();return field().delivery(id);});
  app.post("/api/work",{bodyLimit:1100000},async request=>{const input=WorkRequestSchema.parse(request.body);const cloud=await agent.cloud?.work(input,origin);if(cloud!==undefined)return cloud;const local=await agent.journal.work(input,origin);if(local!==undefined)return local;if(!options.field)throw new Error('FIELD_LOCAL_FEATURE_UNAVAILABLE');const call=workHttp(input);return field().call(call.path,call.body,call.key);});
  app.get('/local-original/:id',async(request,reply)=>{
    const cookie=String(request.headers.cookie??'').split('; ').find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1)??'';
    if(!equal(cookie,session))return reply.code(401).send();
    const {id}=z.object({id:Id}).parse(request.params);await agent.cloud?.currentSession();agent.cloud?.assertVisible(id);const doc=agent.document(id);const file=await agent.sourcePath(doc);
    return reply.type(mimeFor(doc.ext)).header('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`).send(await readFile(file));
  });
  app.get("/api/field/today",async()=>field().today());
  app.post('/api/field/quotes/:id/pdf',async(request,reply)=>{
    const {id}=z.object({id:Id}).parse(request.params);const snapshot=await field().approvedQuote(id);
    const pdf=await renderApprovedQuote(agent.dataDir,snapshot);return reply.type('application/pdf').header('X-Content-SHA256',pdf.sha256).header('Content-Disposition','attachment; filename="quote.pdf"').send(pdf.bytes);
  });
  app.get("/api/field/projects",async()=>field().projects());
  app.get("/api/field/projects/:id",async request=>field().project(z.object({id:Id}).parse(request.params).id));
  app.post("/api/field/questions/:id/answer",async request=>{
    const {id}=z.object({id:Id}).parse(request.params);const {key,answer}=z.object({key:Id,answer:z.unknown()}).parse(request.body);
    return field().answer(id,answer,key);
  });
  app.post("/api/field/events",async request=>{
    const b=z.object({control:z.string().max(40),screen:z.string().max(40),actor:z.enum(['human','agent_test']),task_id:Id.optional(),document_id:Id.optional(),active_ms:z.number().int().min(0).max(60000).optional()}).strict().parse(request.body);
    field().record(b.control,b.screen,b.actor,{...(b.task_id?{task_id:b.task_id}:{}),...(b.document_id?{document_id:b.document_id}:{}),...(b.active_ms!==undefined?{active_ms:b.active_ms}:{})});return {queued:true};
  });
  const admins=new Map<string,{token:string;expires:number}>();
  app.post("/api/admin/login",async(request,reply)=>{
    const b=z.object({email:z.email(),password:z.string().min(1).max(200)}).strict().parse(request.body);
    const result=await field().login(b.email,b.password);
    const today=new Date().toISOString().slice(0,10);await field().admin(result.access_token,today,today);
    const key=randomBytes(32).toString('hex');admins.set(key,{token:result.access_token,expires:Date.now()+Math.min(result.expires_in,1800)*1000});
    reply.header('Set-Cookie',`sigongnote_admin=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);return {authenticated:true};
  });
  const adminToken=(cookies:string|undefined)=>{
    const key=String(cookies??'').split('; ').find(x=>x.startsWith('sigongnote_admin='))?.slice(17)??'';
    const entry=admins.get(key);if(!entry||entry.expires<Date.now())throw new Error('FIELD_ADMIN_LOGIN_REQUIRED');return entry.token;
  };
  app.get("/api/admin/report",async request=>{
    const q=z.object({from:z.iso.date(),to:z.iso.date()}).parse(request.query);
    return field().admin(adminToken(request.headers.cookie),q.from,q.to);
  });
  app.get("/api/admin/report.csv",async(request,reply)=>{
    const q=z.object({from:z.iso.date(),to:z.iso.date()}).parse(request.query);
    const report=await field().admin(adminToken(request.headers.cookie),q.from,q.to) as Parameters<typeof reportCsv>[0];
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="sigongnote-report.csv"').send(reportCsv(report));
  });
  const backupTickets=new Map<string,{id:string;expires:number}>();
  app.post('/api/admin/backup',async request=>{
    const token=adminToken(request.headers.cookie),today=new Date().toISOString().slice(0,10);await field().admin(token,today,today);
    if(!options.backup)throw new Error('FIELD_BACKUP_UNAVAILABLE');const snapshot=await options.backup.create();const verified=await options.backup.verify(snapshot.id);
    const ticket=randomBytes(32).toString('hex');backupTickets.set(ticket,{id:snapshot.id,expires:Date.now()+60000});
    return {snapshot,verified,download:`/api/admin/backup/${ticket}`};
  });
  app.get('/api/admin/backup/:ticket',async(request,reply)=>{
    adminToken(request.headers.cookie);const {ticket}=z.object({ticket:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params);
    const item=backupTickets.get(ticket);if(!item||item.expires<Date.now()||!options.backup)throw new Error('FIELD_BACKUP_EXPIRED');
    backupTickets.delete(ticket);return reply.type('application/octet-stream').header('Content-Disposition','attachment; filename="sigongnote-index.sgnbackup"').send(await options.backup.read(item.id));
  });
  app.get("/*", async (request, reply) => {
    const pathname = new URL(request.url, origin).pathname;
    const asset = (pathname === "/" || pathname === "/admin") ? "index.html" : pathname.slice(1);
    if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+\.(js|css))$/.test(asset)) return reply.code(404).send();
    const mime = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html";
    const body=await readFile(path.join(options.webDir, asset));
    // The native bundle disallows all fetches because native calls normally use a
    // bridge. On loopback this server owns the self-only policy instead.
    return reply.type(mime).send(asset==='index.html'?body.toString('utf8').replace(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi,''):body);
  });
  return app;
}
