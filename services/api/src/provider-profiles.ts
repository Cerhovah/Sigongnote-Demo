import type { FastifyInstance } from "fastify";
import { z } from "zod";

export type ProfileProvider = "naver" | "kakao";
const endpoints = { naver:"https://openapi.naver.com/v1/nid/me", kakao:"https://kapi.kakao.com/v2/user/me" } as const;
export function configuredProfileProviders(raw = ""): ProfileProvider[] {
  const values=raw.split(",").map(value=>value.trim()).filter(Boolean);
  if(values.some(value=>value!=="naver" && value!=="kakao") || new Set(values).size!==values.length)throw new Error("Invalid OAuth profile provider configuration");
  return values as ProfileProvider[];
}
const unsafeDisplay = (char:string) => { const code=char.charCodeAt(0);return code<32 || (code>=127 && code<=159) || (code>=0x202a && code<=0x202e) || (code>=0x2066 && code<=0x2069); };
const StableId=z.string().min(1).max(255).refine(value=>![...value].some(char=>unsafeDisplay(char) || /\s/.test(char)));
export function normalizeProviderProfile(provider: ProfileProvider, input: unknown) {
  let id:string,name:string|undefined;
  if(provider==="naver") {
    const profile=z.object({resultcode:z.literal("00"),response:z.object({id:StableId,name:z.string().max(200).optional(),nickname:z.string().max(200).optional()})}).parse(input);
    id=profile.response.id;name=profile.response.name ?? profile.response.nickname;
  } else {
    const profile=z.object({id:z.number().int().safe().positive(),properties:z.object({nickname:z.string().max(200).optional()}).optional()}).parse(input);
    id=String(profile.id);name=profile.properties?.nickname;
  }
  // Deliberately omit email/phone and email_verified: provider email equality must not merge accounts.
  const display=name ? [...name].filter(char=>!unsafeDisplay(char)).join("").trim() : "";
  return { sub:id,id,...(display ? {name:display} : {}) };
}
export function registerProviderProfileRoutes(app:FastifyInstance, enabled:readonly ProfileProvider[]=[], transport:typeof fetch=fetch) {
  let active=0;
  app.get<{Params:{provider:string}}>("/v1/auth/provider-profile/:provider",async(request,reply)=>{
    reply.header("Cache-Control","no-store").header("Pragma","no-cache");
    const provider=request.params.provider;
    if((provider!=="naver" && provider!=="kakao") || !enabled.includes(provider))return reply.code(404).send({error:"provider_unavailable"});
    const authorization=request.headers.authorization ?? "";
    if(!/^Bearer [A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(authorization))return reply.code(401).send({error:"invalid_token"});
    if(active>=8)return reply.code(429).send({error:"temporarily_unavailable"});
    active++;
    let upstream: Response | undefined;
    try {
      const result=await transport(endpoints[provider],{headers:{Authorization:authorization,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(8000)});
      upstream=result;
      if(!result.ok)return reply.code(result.status===401 || result.status===403 ? 401 : 503).send({error:"provider_unavailable"});
      if(!result.headers.get("content-type")?.includes("application/json") || Number(result.headers.get("content-length") ?? 0)>32768)throw new Error("Invalid profile");
      const reader=result.body?.getReader();if(!reader)throw new Error("Missing profile");
      const chunks:Uint8Array[]=[];let size=0;
      try { for(;;) {const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>32768)throw new Error("Profile too large");chunks.push(next.value);} }
      finally {await reader.cancel().catch(()=>{});}
      return normalizeProviderProfile(provider,JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {return reply.code(502).send({error:"profile_unavailable"});}
    finally { if(upstream?.body && !upstream.body.locked)await upstream.body.cancel().catch(()=>{});active--; }
  });
}
