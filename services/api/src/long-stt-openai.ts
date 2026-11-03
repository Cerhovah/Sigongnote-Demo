import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AudioNotAccepted,AudioResultInvalid,type AudioProvider} from './long-audio.js';
import {audioPrice} from './product-ai-config.js';

/** Explicit timed model; no fallback from a different provider's consent or price. */
export function openAiLongStt(env:NodeJS.ProcessEnv,transport:typeof fetch=fetch):AudioProvider|undefined{
 if(env.LONG_STT_ENABLED!=='true'||env.LONG_STT_PROVIDER!=='openai'||env.LONG_STT_MODEL!=='whisper-1'||!env.LONG_STT_API_KEY)return;
 const billing=audioPrice(env.LONG_STT_PRICE_JSON,'whisper-1');if(!billing)return;
 return {name:'openai',billing,async submit(bytes,signal){
  const body=new FormData();body.set('model','whisper-1');body.set('language','ko');body.set('response_format','verbose_json');body.set('timestamp_granularities[]','segment');body.set('file',new Blob([new Uint8Array(bytes)],{type:'audio/wav'}),'recording.wav');
  const response=await transport('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.LONG_STT_API_KEY}`},body,signal,redirect:'error'});
  if([400,401,403,404,413,415,422,429].includes(response.status))throw new AudioNotAccepted();
  if(!response.ok||!response.body)throw Error('AUDIO_OUTCOME_UNKNOWN');
  const receipt=createHash('sha256').update(response.headers.get('x-request-id')??String(Date.now())).digest('hex');
  try{
  const parts:Uint8Array[]=[];let length=0;for await(const part of response.body){length+=part.length;if(length>2097152)throw Error('AUDIO_RESPONSE_LIMIT');parts.push(part);}
  const raw=JSON.parse(Buffer.concat(parts).toString('utf8'));
  const rows=z.array(z.object({start:z.number().nonnegative(),end:z.number().positive(),text:z.string().trim().min(1).max(1000)})).max(3000).parse(raw.segments);
  return {receipt,segments:rows.map(s=>({start:Math.round(s.start*1000),end:Math.round(s.end*1000),text:s.text}))};
  }catch{throw new AudioResultInvalid(receipt);}
 },async poll(){throw Error('AUDIO_SYNCHRONOUS_RESULT_UNAVAILABLE');}};
}
