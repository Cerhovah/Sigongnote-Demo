import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function checkImageRuntime(image){
 if(typeof image!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]+$/.test(image))throw Error('IMAGE_REFERENCE_REQUIRED');
 const id=execFileSync('docker',['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8',windowsHide:true}).trim();
 if(!/^sha256:[a-f0-9]{64}$/.test(id))throw Error('IMAGE_ID_REQUIRED');
 const run=(entry,args)=>execFileSync('docker',['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=32m','--entrypoint',entry,id,...args],{encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:1024*1024}).trim();
 const python=run('/app/services/document-worker/.venv/bin/python',['-c',[
  'import ssl, sqlite3, ctypes, xml.parsers.expat, bz2, lzma, dbm.gnu, readline',
  'import av, xlrd, olefile, defusedxml, jsonschema, pdfplumber',
  'from io import BytesIO',
  'from PIL import Image',
  'from reportlab.pdfgen.canvas import Canvas',
  'from reportlab.pdfbase import pdfmetrics',
  'from reportlab.pdfbase.ttfonts import TTFont',
  'from pypdf import PdfReader',
  'from openpyxl import Workbook, load_workbook',
  "pdfmetrics.registerFont(TTFont('Korean','/usr/share/fonts/truetype/nanum/NanumGothic.ttf'))",
  "out=BytesIO(); c=Canvas(out); c.setFont('Korean',12); c.drawString(30,800,'내부 실행 검증'); c.save(); assert len(PdfReader(out).pages)==1",
  "image=BytesIO(); Image.new('RGB',(8,8),'white').save(image,format='JPEG'); image.seek(0); assert Image.open(image).size==(8,8)",
  "book=Workbook(); book.active.append(['synthetic',17]); data=BytesIO(); book.save(data); data.seek(0); assert load_workbook(data).active['B1'].value==17",
  "print('PYTHON_RENDER_PARSE_PASS')",
 ].join('\n')]);
 const identity=JSON.parse(run('node',['--input-type=module','-e',"import {releaseIdentity} from './services/api/dist/release.js';console.log(JSON.stringify(releaseIdentity()))"]));
 const voice=JSON.parse(run('node',['scripts/check-short-stt-runtime.mjs']));
 if(python!=='PYTHON_RENDER_PARSE_PASS'||identity.status!=='identified'||!identity.archive_sha256||identity.source_dirty!==false||voice.status!=='PASS'||voice.synthetic_wav_seconds!==1||voice.external_requests!==0)throw Error('IMAGE_RUNTIME_UNVERIFIED');
 return {image_id:id,release:identity,python_render_parse:true,short_stt_probe:true,network:'none',server_started:false,user_acceptance:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(checkImageRuntime(process.argv[2])));}catch{console.error('IMAGE_RUNTIME_UNVERIFIED');process.exitCode=1;}}
