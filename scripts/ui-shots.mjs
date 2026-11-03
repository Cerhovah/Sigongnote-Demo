#!/usr/bin/env node
/**
 * Screen capture + quick audit for the common work UI (`?work=preview`).
 * Gives headless Claude/Codex runs "eyes": PNG per screen per width, axe-core violations,
 * horizontal overflow, small text and small tap targets. No browser download: uses the
 * installed Edge (or Chrome) through playwright-core.
 *
 *   node scripts/ui-shots.mjs                              # start vite, shoot default routes at 320/390
 *   node scripts/ui-shots.mjs --url http://127.0.0.1:5280  # reuse a running ui-preview server
 *   node scripts/ui-shots.mjs --routes today,documents --widths 320
 *   node scripts/ui-shots.mjs --script .work/flows.json    # scripted clicks, see FLOW FORMAT below
 *   node scripts/ui-shots.mjs --out .work/ui-pass/2026-10-06/after
 *   node scripts/ui-shots.mjs --no-build                   # skip the contracts/domain/ui tsc step
 *
 * FLOW FORMAT (JSON array): [{ "name": "documents", "hash": "documents",
 *   "steps": [], "expect": { "heading": "문서", "button": "문서 만들기", "enabled": true } }]
 * See scripts/ui-flows.json for clicks, fills and intermediate shots. Clicks require a unique
 * interactive target; final expectations are mandatory. Output: <out>/index.md + PNG + audit.json.
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parse(process.argv.slice(2));
const widths = (args.widths ?? "320,390").split(",").map(Number).filter(Boolean);
const routes = (args.routes ?? "today,questions,ask,materials,documents,more").split(",").map(s => s.trim()).filter(Boolean);
const stamp = new Date().toISOString().replace(/[:.]/g, "-")+"-"+randomUUID().slice(0,8);
const out = path.resolve(root, args.out ?? path.join(".work", "ui-shots", stamp));
const height = Number(args.height ?? 844);
// Query must enter the synthetic DEV client. No live-workspace capture is implied.
const query = args.query === undefined ? "?work=preview" : (args.query === true || args.query === "" ? "" : `?${String(args.query).replace(/^\?/, "")}`);
if(!widths.length||widths.some(w=>!Number.isInteger(w)||w<240||w>2560)||!Number.isInteger(height)||height<320||height>4000)throw new Error("Invalid viewport");
const relativeOut=path.relative(path.join(root,".work"),out);
if(!relativeOut||relativeOut.startsWith("..")||path.isAbsolute(relativeOut))throw new Error("--out must be a new folder inside .work");
const baseUrl=new URL(args.url??"http://127.0.0.1");
if(baseUrl.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(baseUrl.hostname)||baseUrl.username||baseUrl.password)throw new Error("Only loopback HTTP preview URLs are allowed");
if(new URLSearchParams(query.replace(/^\?/,"")).get("work")!=="preview")throw new Error("Only work=preview is supported; real data needs a separately authorized flow");

function parse(list) {
  const o = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) o[key] = true; else { o[key] = next; i++; }
  }
  return o;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

async function waitFor(url, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server did not answer at ${url}`);
}

async function buildPackages() {
  // The web dev server imports @sigongnote/contracts|domain|ui from their dist folders (package exports),
  // so a stale dist shows up as a Vite "Failed to resolve import" overlay instead of the app. Same order as scripts/build.mjs.
  if (args["no-build"]) return;
  for (const pkg of ["contracts", "domain", "ui"]) {
    const config = path.join(root, "packages", pkg, "tsconfig.build.json");
    if (!fs.existsSync(config)) continue;
    const tsc = spawn(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", config], { cwd: root, stdio: "inherit", windowsHide: true });
    await new Promise((res, rej) => tsc.on("close", c => c === 0 ? res() : rej(new Error(`packages/${pkg} build failed`))));
  }
}

async function startVite() {
  await buildPackages();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort", "--clearScreen", "false"], { cwd: path.join(root, "apps", "web"), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const log = fs.createWriteStream(path.join(out, "vite.log"));
  child.stdout.pipe(log); child.stderr.pipe(log);
  const base = `http://127.0.0.1:${port}`;
  try { await waitFor(base + "/"); } catch (error) { child.kill(); log.end(); throw error; }
  return { base, stop: () => { try { child.kill(); } catch {} } };
}

async function launch() {
  const errors = [];
  for (const channel of ["msedge", "chrome"]) {
    try { return await chromium.launch({ channel, headless: true }); } catch (e) { errors.push(`${channel}: ${e.message.split("\n")[0]}`); }
  }
  throw new Error("No installed Edge/Chrome found for playwright-core.\n" + errors.join("\n"));
}

const axeSource = fs.readFileSync(path.join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");

async function audit(page) {
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ["violations"], rules: { "color-contrast": { enabled: true } } });
    return r.violations.map(v => ({ id: v.id, impact: v.impact, count: v.nodes.length, sample: v.nodes[0]?.target?.[0] ?? "" }));
  });
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const textEls = [...document.querySelectorAll("body *")].filter(el => visible(el) && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
    const small = textEls.filter(el => parseFloat(getComputedStyle(el).fontSize) < 18).map(el => `${el.tagName.toLowerCase()}:${el.textContent.trim().slice(0, 24)}`);
    const targets = [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button]")].filter(visible);
    const smallTargets = targets.filter(el => el.getBoundingClientRect().height < 48).map(el => `${el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}`);
    return { overflow: doc.scrollWidth > doc.clientWidth + 1, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, smallText: small.slice(0, 20), smallTextCount: small.length, smallTargets: smallTargets.slice(0, 20), smallTargetCount: smallTargets.length, title: document.title, heading: document.querySelector("h1,h2")?.textContent?.trim() ?? "" };
  });
  return { axe, ...metrics };
}

async function locate(page, text) {
  for (const role of ["button", "link", "tab", "menuitem", "checkbox", "radio"]) {
    const exact = page.getByRole(role, { name: text, exact: true });
    if (await exact.count() === 1) return exact;
  }
  for (const role of ["button", "link", "tab", "menuitem", "checkbox", "radio"]) {
    const l = page.getByRole(role, { name: text, exact: false });
    if (await l.count() === 1) return l;
  }
  const t = page.locator('button,a[href],summary,[role="button"],[role="link"],[role="tab"]').filter({hasText:text});
  if (await t.count() === 1) return t;
  throw new Error(`No element matching "${text}"`);
}

async function runSteps(page, steps, shoot) {
  for (const step of steps ?? []) {
    if (step.click) await (await locate(page, step.click)).click();
    else if (step.fill) { const [label, value] = step.fill; const f = page.getByLabel(label, { exact: false }).first(); await (await f.count() ? f : page.getByPlaceholder(label).first()).fill(value); }
    else if (step.select) { const [label, text] = step.select; const target=page.getByLabel(label,{exact:false}); if(await target.count()!==1)throw new Error("Select label must be unique: "+label); await target.selectOption({label:text}); }
    else if (step.press) await page.keyboard.press(step.press);
    else if (step.hash) await page.evaluate(h => { location.hash = h; }, step.hash);
    else if (step.wait) await page.waitForTimeout(Number(step.wait));
    else if (step.shot) await shoot(step.shot);
    else if(step.expect)await expectVisible(page,step.expect);
    else throw new Error("Unknown flow step");
    await page.waitForTimeout(250);
  }
}


async function expectVisible(page, expected){
 if(expected.heading)await page.getByRole("heading",{name:expected.heading,exact:true,level:1}).waitFor({state:"visible"});
 if(expected.button){
  const button=page.getByRole("button",{name:expected.button,exact:true});await button.waitFor({state:"visible"});
  if(expected.enabled){const until=Date.now()+5000;while(!await button.isEnabled()){if(Date.now()>=until)throw new Error("Expected enabled button: "+expected.button);await page.waitForTimeout(100);}}
 }
 if(expected.text)await page.getByText(expected.text,{exact:true}).first().waitFor({state:"visible"});
 if(!expected.heading&&!expected.button&&!expected.text)throw new Error("Expected heading, button, or text is required");
 if(await page.locator('h1:visible').count()!==1)throw new Error('Expected exactly one visible h1');
 if(await page.locator('.button-primary:visible').count()>1)throw new Error('More than one primary action is visible');
}
const main=async()=>{
 const defaults={today:"오늘",materials:"현장",documents:"문서",more:"설정",questions:"확인할 일",ask:"무엇을 도와드릴까요?"};
 const flows=args.script?JSON.parse(fs.readFileSync(path.resolve(root,args.script),"utf8")):routes.map(r=>({name:r,hash:r,expect:{heading:defaults[r]??r},steps:[]}));
 if(!Array.isArray(flows)||!flows.length)throw new Error("At least one flow is required");
 for(const flow of flows){
  if(!/^[a-z0-9_-]+$/i.test(flow.name)||!flow.expect)throw new Error("Every flow needs a safe name and an expected screen");
  for(const step of flow.steps??[])if(step.shot&&!/^[a-z0-9_-]+$/i.test(step.shot))throw new Error("Invalid screenshot suffix");
 }
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(out);
 let server,browser;
 const rows=[],report={generatedAt:new Date().toISOString(),widths,thresholds:{text:18,targetHeight:48},shots:[],failures:[]};
 try{
  server=args.url?{base:String(args.url).replace(/\/$/,""),stop(){}}:await startVite();
  report.base=server.base;browser=await launch();
  for(const width of widths){
   for(const flow of flows){
    const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,isMobile:true,hasTouch:true,locale:"ko-KR",reducedMotion:"reduce"});
    // A capture must not contact product APIs or external services, including redirects and popups.
    await context.route("**/*",route=>{
     const url=new URL(route.request().url());
     const request=route.request();
     if(["GET","HEAD"].includes(request.method())&&!/^\/(api|v1|auth)(\/|$)/.test(url.pathname)&&(url.origin===new URL(server.base).origin||["data:","blob:"].includes(url.protocol)))return route.continue();
     return route.abort("blockedbyclient");
    });
    const page=await context.newPage();page.setDefaultTimeout(5000);
    const consoleErrors=[],unhandled=new Set();
    page.on("pageerror",e=>consoleErrors.push(e.message));
    page.on("console",m=>{if(m.type()==="error")consoleErrors.push(m.text());if(m.type()==="warning"&&m.text().startsWith("[preview] unhandled route"))unhandled.add(m.text());});
    const shoot=async suffix=>{
     const file=flow.name+(suffix?"-"+suffix:"")+"-"+width+".png";
     await page.screenshot({path:path.join(out,file),fullPage:true});const a=await audit(page);
     report.shots.push({flow:flow.name,step:suffix??"",width,file,...a,consoleErrors:[...consoleErrors],unhandledRoutes:[...unhandled]});
     rows.push("| "+[flow.name+(suffix?"/"+suffix:""),width,a.overflow?"YES":"no",a.axe.length,a.smallTextCount,a.smallTargetCount,consoleErrors.length,file].join(" | ")+" |");
     if(a.overflow||a.axe.length||consoleErrors.length||unhandled.size)report.failures.push({flow:flow.name,width,reason:"audit",overflow:a.overflow,axe:a.axe.length,consoleErrors:consoleErrors.length,unhandled:[...unhandled]});
    };
    try{
     const params=new URLSearchParams(query.replace(/^\?/,""));if(flow.scenario)params.set("scenario",flow.scenario);
     const response=await page.goto(server.base+"/?"+params+"#/"+(flow.hash??"today"),{waitUntil:"networkidle"});
     if(!response?.ok())throw new Error("Preview HTTP request failed");
     await page.locator('#root[data-work-preview="synthetic"]').waitFor({state:"visible"});
     await page.locator("h1").waitFor({state:"visible"});
     await page.waitForTimeout(400);
     if(await page.locator("vite-error-overlay").count())throw new Error("Vite overlay");
     await runSteps(page,flow.steps,shoot);
     await expectVisible(page,flow.expect);
     await page.waitForTimeout(350);
     await shoot(flow.steps?.length?"end":"");
     await page.waitForTimeout(150);
     if(consoleErrors.length||unhandled.size)report.failures.push({flow:flow.name,width,reason:"end-of-flow errors",consoleErrors:[...consoleErrors],unhandled:[...unhandled]});
    }catch(error){
     const file=flow.name+"-FAILED-"+width+".png";try{await page.screenshot({path:path.join(out,file),fullPage:true});}catch{}
     report.failures.push({flow:flow.name,width,error:error.message,file});
     rows.push("| "+[flow.name,width,"FAILED","—","—","—",consoleErrors.length,file].join(" | ")+" |");
    }finally{await context.close();}
   }
  }
 }catch(error){report.failures.push({error:error.message});}
 finally{
  await browser?.close();server?.stop();
  const findings=report.shots.reduce((n,s)=>n+s.smallTextCount+s.smallTargetCount,0);
  report.status=report.failures.length?"FAILED":findings?"CAPTURED_WITH_FINDINGS":"CAPTURED";
  fs.writeFileSync(path.join(out,"audit.json"),JSON.stringify(report,null,2));
  const md=["# UI captures","",report.status+"; synthetic browser only; real API/device/production NOT RUN.","",
   "| flow | width | overflow | axe | text<18px | target height<48px | console | file |","|---|---|---|---|---|---|---|---|",...rows,"",
   ...report.failures.map(f=>"- "+JSON.stringify(f)),"","Small-text/target findings are advisory; flow/runtime/unsupported-route/axe/overflow failures return nonzero."].join("\n");
  fs.writeFileSync(path.join(out,"index.md"),md);console.log(JSON.stringify({status:report.status,shots:report.shots.length,failures:report.failures.length,out}));
  if(report.failures.length)process.exitCode=1;
 }
};
main().catch(e=>{console.error(e.message);process.exitCode=1;});
