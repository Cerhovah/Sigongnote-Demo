import {spawn} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {isAbsolute,join} from "node:path";
import {audioPrice,type AudioPrice} from './product-ai-config.js';

export const VOICE_VERSION="short-voice-v1";
export const MAX_VOICE_BYTES=786432;
export class ShortSttNotAccepted extends Error{constructor(readonly status:number){super('VOICE_PROVIDER_NOT_ACCEPTED');}}
export interface ShortStt {
 readonly label:string;readonly model:string;readonly version:string;readonly dailySeconds:number;
 readonly billing?:AudioPrice;
 probe(bytes:Uint8Array,mime:string):Promise<number>;
 transcribe(bytes:Uint8Array,mime:string,signal:AbortSignal):Promise<string>;
}
export function shortAudio(bytes:Uint8Array,mime:string){
 if(bytes.length<16||bytes.length>MAX_VOICE_BYTES)throw new Error("VOICE_SIZE");
 const b=Buffer.from(bytes);
 const valid=mime==="audio/webm"?b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):
 mime==="audio/ogg"?b.subarray(0,4).toString()==="OggS":
 mime==="audio/wav"?b.subarray(0,4).toString()==="RIFF"&&b.subarray(8,12).toString()==="WAVE":false;
 if(!valid)throw new Error("VOICE_FORMAT");
}
/** Disabled unless an operator explicitly supplies provider, decoder and bounded usage. No paid call at startup. */
export function configuredShortStt(env:NodeJS.ProcessEnv=process.env,transport:typeof fetch=fetch):ShortStt|undefined {
 if(env.SHORT_STT_ENABLED!=="true")return undefined;
 const key=env.SHORT_STT_API_KEY,decoder=env.SHORT_STT_FFPROBE,seconds=Number(env.SHORT_STT_DAILY_SECONDS);
 if(!key||!decoder||!isAbsolute(decoder)||!existsSync(decoder)||!Number.isInteger(seconds)||seconds<31||seconds>3600)return undefined;
 const billing=audioPrice(env.SHORT_STT_PRICE_JSON,'gpt-transcribe');if(!billing)return undefined;
 return {label:"OpenAI 음성 인식",model:"gpt-transcribe",version:VOICE_VERSION,dailySeconds:seconds,billing,
  async probe(bytes,mime){shortAudio(bytes,mime);const dir=await mkdtemp(join(tmpdir(),"sigongnote-voice-"));
   try{const path=join(dir,"request.audio");await writeFile(path,bytes,{mode:0o600});
    const output=await new Promise<string>((resolve,reject)=>{
     const child=spawn(decoder,["-v","error","-protocol_whitelist","file","-show_entries","format=duration:stream=codec_type,duration:packet=pts_time,duration_time","-of","json",path],{windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP},stdio:["ignore","pipe","ignore"]});
     let out="";const timer=setTimeout(()=>{child.kill();reject(new Error("VOICE_PROBE_TIMEOUT"));},5000);
     child.stdout.on("data",chunk=>{out+=chunk;if(out.length>524288){child.kill();reject(new Error("VOICE_PROBE_LIMIT"));}});
     child.once("error",()=>{clearTimeout(timer);reject(new Error("VOICE_DECODER_UNAVAILABLE"));});child.once("close",code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error("VOICE_FORMAT"));});
    });return measuredVoiceSeconds(JSON.parse(output));
   }finally{await rm(dir,{recursive:true,force:true});}
  },
  async transcribe(bytes,mime,signal){const body=new FormData();body.set("model","gpt-transcribe");body.set("languages[]","ko");body.set("file",new Blob([new Uint8Array(bytes)],{type:mime}),`request.${mime.split("/")[1]}`);
   const response=await transport("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{Authorization:`Bearer ${key}`},body,signal,redirect:"error"});
   if([400,401,403,404,413,422,429].includes(response.status))throw new ShortSttNotAccepted(response.status);
   if(!response.ok)throw new Error("VOICE_PROVIDER_UNAVAILABLE");const text=await response.text();if(text.length>16384)throw new Error("VOICE_OUTPUT_LIMIT");
   const result=JSON.parse(text);if(typeof result.text!=="string"||!result.text.trim()||result.text.length>2000)throw new Error("VOICE_EMPTY");return result.text.trim();
  }};
}

/** Scan all packets; an untrusted container duration can never shorten measured audio. */
export function measuredVoiceSeconds(data:{format?:{duration?:string};streams?:{codec_type:string;duration?:string}[];packets?:{pts_time?:string;duration_time?:string}[]}):number{
 if(!data.streams?.length||data.streams.some(s=>s.codec_type!=="audio")||!data.packets?.length)throw new Error("VOICE_DURATION");
 const packets=data.packets.map(p=>{const time=Number(p.pts_time),duration=Number(p.duration_time);if(!Number.isFinite(time)||!Number.isFinite(duration)||duration<=0)throw new Error("VOICE_DURATION");return time+duration;});
 const metadata=[data.format?.duration,...data.streams.map(s=>s.duration)].map(Number).filter(Number.isFinite);
 const duration=Math.max(...packets,...metadata);
 if(!Number.isFinite(duration)||duration<=0||duration>30.5)throw new Error("VOICE_DURATION");return Math.ceil(duration);
}
