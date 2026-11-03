import {existsSync,readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {z} from 'zod';
import {claudeProductAiConfig,claudeRuntimeConfig} from './claude-runtime.js';

export const ProductPriceSchema=z.strictObject({version:z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
 provider:z.enum(['openai','anthropic']),model:z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
 input_krw_per_million:z.number().int().min(1).max(10000000),output_krw_per_million:z.number().int().min(1).max(10000000),
 valid_until:z.iso.datetime(),conversion_note:z.string().min(1).max(200)});
export type ProductPrice=z.infer<typeof ProductPriceSchema>;
/** runtime 'claude-agent-sdk' routes the request through the Agent SDK instead of a raw HTTP call. */
export type ProductAiConfig={provider:'openai'|'anthropic';key:string;model:string;price:ProductPrice;maxOutputTokens:number;runtime?:'messages'|'claude-agent-sdk'};
export const AudioPriceSchema=z.strictObject({version:z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),model:z.string().min(1).max(100),krw_per_minute:z.number().int().min(1).max(1000),valid_until:z.iso.datetime()});
export type AudioPrice=z.infer<typeof AudioPriceSchema>;
export function audioPrice(raw:string|undefined,model:string):AudioPrice|undefined{try{const p=AudioPriceSchema.parse(JSON.parse(raw??''));return p.model===model&&Date.parse(p.valid_until)>Date.now()?p:undefined;}catch{return undefined;}}
export const audioCostKrw=(price:AudioPrice,seconds:number)=>Math.max(1,Math.ceil(Math.ceil(seconds)*price.krw_per_minute/60));
/** Explicit development-only secret file. Never override a host's existing secrets. */
export function loadProductLocalEnvironment(env:NodeJS.ProcessEnv=process.env,file:string|URL=new URL('../../../.env.product.local',import.meta.url)){
 if(env.APP_ENV!=='development'||!existsSync(file))return;
 const values=parseEnv(readFileSync(file,'utf8'));
 const keys=['ANTHROPIC_API_KEY','CLAUDE_AGENT_ENABLED','CLAUDE_AGENT_MODEL','CLAUDE_AGENT_PRICE_JSON','CLAUDE_AGENT_MAX_USD','SEMANTIC_ENABLED','CAPTURE_POLICY_JSON','SEMANTIC_PROVIDER','SEMANTIC_API_KEY','SEMANTIC_MODEL','SEMANTIC_PRICE_JSON','SHORT_STT_API_KEY','SHORT_STT_ENABLED','SHORT_STT_FFPROBE','SHORT_STT_DAILY_SECONDS','SHORT_STT_PRICE_JSON','CLOVA_SPEECH_KEY','CLOVA_SPEECH_INVOKE_URL','LONG_STT_PROVIDER','LONG_STT_MODEL','LONG_STT_API_KEY','LONG_STT_ENABLED','LONG_STT_OBS_CONFIGURED','LONG_STT_PRICE_JSON','LONG_STT_TENANT_SECONDS','LONG_STT_GLOBAL_SECONDS'];
 for(const key of keys)if(!env[key]&&values[key])env[key]=values[key];
 for(const key of ['SIGONGNOTE_TESSERACT','SIGONGNOTE_TESSDATA_DIR'])if(!env[key]&&values[key])env[key]=values[key];
}
/** Explicit AI_PROVIDER selects the product runtime. Unset preserves the legacy SEMANTIC_* override. */
function claudeConfig(env:NodeJS.ProcessEnv,now:number):ProductAiConfig|undefined{
 const explicit=env.AI_PROVIDER==='claude';
 if(!explicit&&(env.SEMANTIC_PROVIDER||env.SEMANTIC_API_KEY||env.SEMANTIC_MODEL))return undefined;
 if(env.CLAUDE_AGENT_ENABLED!=='true'&&env.SEMANTIC_ENABLED!==undefined&&env.SEMANTIC_ENABLED!=='true')return undefined;
 if(explicit&&env.CLAUDE_AGENT_ENABLED!=='false'){
  if(!env.ANTHROPIC_API_KEY)throw Error('PRODUCT_AI_KEY_MISSING');
  if(env.ANTHROPIC_API_KEY.length<20||/\s/.test(env.ANTHROPIC_API_KEY))throw Error('PRODUCT_AI_KEY_INVALID');
 }
 const runtime=claudeRuntimeConfig(env,now);return runtime?claudeProductAiConfig(runtime,env):undefined;
}
export function productAiConfig(env:NodeJS.ProcessEnv=process.env,now=Date.now()):ProductAiConfig|undefined {
 if(env.AI_PROVIDER==='fixture')return undefined;
 const claude=claudeConfig(env,now);if(claude||env.AI_PROVIDER==='claude')return claude;
 if(env.SEMANTIC_ENABLED!==undefined&&env.SEMANTIC_ENABLED!=='true')return undefined;
 if(!env.SEMANTIC_PROVIDER&&!env.SEMANTIC_API_KEY&&!env.SEMANTIC_MODEL)return undefined;
 if(!env.SEMANTIC_PROVIDER||!env.SEMANTIC_API_KEY||!env.SEMANTIC_MODEL||!env.SEMANTIC_PRICE_JSON)return undefined;
 let value:unknown;try{value=JSON.parse(env.SEMANTIC_PRICE_JSON);}catch{throw Error('PRODUCT_AI_PRICE_INVALID');}
 const price=ProductPriceSchema.safeParse(value);
 if(!price.success||price.data.provider!==env.SEMANTIC_PROVIDER||price.data.model!==env.SEMANTIC_MODEL||Date.parse(price.data.valid_until)<=now)throw Error('PRODUCT_AI_PRICE_INVALID');
 if(env.SEMANTIC_API_KEY.length<20||/\s/.test(env.SEMANTIC_API_KEY))throw Error('PRODUCT_AI_KEY_INVALID');
 return {provider:price.data.provider,key:env.SEMANTIC_API_KEY,model:price.data.model,price:price.data,maxOutputTokens:4096};
}
export function tokenCostKrw(price:ProductPrice,input:number,output:number){
 if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)throw Error('PRODUCT_AI_USAGE_INVALID');
 const micros=BigInt(input)*BigInt(price.input_krw_per_million)+BigInt(output)*BigInt(price.output_krw_per_million);
 return Number((micros+999999n)/1000000n);
}
/** An absent/disabled provider is intentional local mode; malformed setup is never a fallback. */
export function agentConfiguration(env:NodeJS.ProcessEnv=process.env,now=Date.now()):{config?:ProductAiConfig;configurationBlocked?:boolean;mode:'model'|'local'|'blocked'}{
 if(env.AI_PROVIDER==='fixture')return {mode:'local'};
 try{const claude=claudeConfig(env,now);if(claude)return {mode:'model',config:claude};}catch{return {mode:'blocked',configurationBlocked:true};}
 if(env.AI_PROVIDER==='claude')return env.CLAUDE_AGENT_ENABLED==='false'||env.SEMANTIC_ENABLED==='false'?{mode:'local'}:{mode:'blocked',configurationBlocked:true};
 if(env.SEMANTIC_ENABLED==='false')return {mode:'local'};
 const values=['SEMANTIC_PROVIDER','SEMANTIC_API_KEY','SEMANTIC_MODEL','SEMANTIC_PRICE_JSON'];
 if(!values.some(k=>Boolean(env[k]))&&env.SEMANTIC_ENABLED===undefined)return {mode:'local'};
 if(env.SEMANTIC_ENABLED!==undefined&&env.SEMANTIC_ENABLED!=='true')return {mode:'blocked',configurationBlocked:true};
 try{const config=productAiConfig(env,now);return config?{mode:'model',config}:{mode:'blocked',configurationBlocked:true};}catch{return {mode:'blocked',configurationBlocked:true};}
}
