import {access} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/** Render the frozen report locally. No report content or network request leaves the browser process. */
export async function renderReportPdf(html:string,executablePath?:string){
 let executable=executablePath;
 if(!executable){
  const candidates=process.platform==='win32'?[
   `${process.env['PROGRAMFILES(X86)']??''}/Microsoft/Edge/Application/msedge.exe`,
   `${process.env.PROGRAMFILES??''}/Microsoft/Edge/Application/msedge.exe`,
   `${process.env.PROGRAMFILES??''}/Google/Chrome/Application/chrome.exe`,
  ]:process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'];
  for(const candidate of candidates){try{await access(candidate);executable=candidate;break;}catch{}}
 }
 if(!executable)throw new Error('PDF_BROWSER_REQUIRED');
 const browser=await chromium.launch({executablePath:executable,headless:true});
 try{const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.abort());const page=await context.newPage();await page.setContent(html,{waitUntil:'load'});await page.emulateMedia({media:'print'});await page.evaluate(()=>document.fonts.ready);return await page.pdf({format:'A4',preferCSSPageSize:true,printBackground:true,margin:{top:'14mm',bottom:'14mm',left:'12mm',right:'12mm'}});}finally{await browser.close();}
}
