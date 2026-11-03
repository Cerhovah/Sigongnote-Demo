import {pathToFileURL} from 'node:url';

/** Offline executable check against the compiled production module; it never transcribes or starts the server. */
export async function checkShortSttRuntime(decoder=process.env.SHORT_STT_FFPROBE??'/usr/bin/ffprobe'){
 const {configuredShortStt}=await import('../services/api/dist/short-stt.js');
 let externalRequests=0;
 const engine=configuredShortStt({SHORT_STT_ENABLED:'true',SHORT_STT_API_KEY:'synthetic-offline-runtime-check',SHORT_STT_FFPROBE:decoder,
  SHORT_STT_DAILY_SECONDS:'60',SHORT_STT_PRICE_JSON:JSON.stringify({version:'offline-runtime-v1',model:'gpt-transcribe',krw_per_minute:1,valid_until:'2099-01-01T00:00:00Z'})},
  async()=>{externalRequests++;throw Error('OFFLINE_RUNTIME_NETWORK_FORBIDDEN');});
 if(!engine)throw Error('SHORT_STT_RUNTIME_UNAVAILABLE');
 const rate=16000,size=rate*2,bytes=Buffer.alloc(44+size);
 bytes.write('RIFF',0);bytes.writeUInt32LE(36+size,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
 bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);
 bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(size,40);
 const seconds=await engine.probe(bytes,'audio/wav');
 if(seconds!==1||externalRequests!==0)throw Error('SHORT_STT_RUNTIME_PROBE_INVALID');
 return {check:'short_stt_runtime',status:'PASS',synthetic_wav_seconds:seconds,external_requests:externalRequests,transcription:'NOT_RUN',database:'NOT_USED'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--help')console.log('node scripts/check-short-stt-runtime.mjs [--decoder <absolute-ffprobe-path>] — offline 1s WAV probe using the compiled production module; no HTTP, DB or real keys.');
 else if(args.length!==0&&(args.length!==2||args[0]!=='--decoder')){console.error('SHORT_STT_RUNTIME_ARGUMENTS');process.exitCode=1;}
 else try{console.log(JSON.stringify(await checkShortSttRuntime(args[1])));}catch(e){console.error(/^[A-Z][A-Z0-9_]{0,80}$/.test(e.message??'')?e.message:'SHORT_STT_RUNTIME_UNVERIFIED');process.exitCode=1;}
}
