import { createProductionApp } from "../services/api/src/production-app.js";
import type { Db } from "../services/api/src/auth.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { configuredProfileProviders, normalizeProviderProfile, registerProviderProfileRoutes } from "../services/api/src/provider-profiles.js";

test("OAuth profile adapter uses verified provider subject and never email/name equality",()=>{
  const first=normalizeProviderProfile("naver",{resultcode:"00",response:{id:"first",email:"same@example.invalid",name:"동일 이름"}});
  const other=normalizeProviderProfile("naver",{resultcode:"00",response:{id:"other",email:"same@example.invalid",name:"동일 이름"}});
  assert.notEqual(first.sub,other.sub);assert.equal("email" in first,false);
  assert.deepEqual(normalizeProviderProfile("kakao",{id:123,properties:{nickname:"합성"},kakao_account:{email:"same@example.invalid"}}),{sub:"123",id:"123",name:"합성"});
  assert.throws(()=>normalizeProviderProfile("naver",{resultcode:"024",response:{id:"first"}}));
  assert.throws(()=>normalizeProviderProfile("kakao",{id:9007199254740992}));
  assert.deepEqual(configuredProfileProviders(),[]);assert.deepEqual(configuredProfileProviders("naver,kakao"),["naver","kakao"]);
  assert.throws(()=>configuredProfileProviders("https://untrusted.invalid"));
});
test("profile route is opt-in, fixed-destination, bounded and returns no upstream secrets",async()=>{
  const app=Fastify({logger:false});let calls=0,mode="ok";
  registerProviderProfileRoutes(app,["naver"],async(input,init)=>{
    calls++;assert(init);assert.equal(input,"https://openapi.naver.com/v1/nid/me");assert.equal(init?.redirect,"error");assert.equal((init.headers as Record<string,string>).Authorization,"Bearer fixture-profile-token");
    if(mode==="failure")throw new Error("private provider details");
    return new Response(mode==="large"?"x".repeat(32769):JSON.stringify({resultcode:"00",response:{id:"stable",email:"private@example.invalid"}}),{headers:{"content-type":"application/json"}});
  });
  try {
    assert.equal((await app.inject({url:"/v1/auth/provider-profile/kakao"})).statusCode,404);
    assert.equal((await app.inject({url:"/v1/auth/provider-profile/naver"})).statusCode,401);assert.equal(calls,0);
    const request={url:"/v1/auth/provider-profile/naver",headers:{authorization:"Bearer fixture-profile-token"}};
    const accepted=await app.inject(request);assert.equal(accepted.statusCode,200);assert.deepEqual(accepted.json(),{sub:"stable",id:"stable"});assert.equal(accepted.headers["cache-control"],"no-store");
    mode="large";assert.equal((await app.inject(request)).statusCode,502);
    mode="failure";const failed=await app.inject(request);assert.equal(failed.statusCode,502);assert(!failed.body.includes("private"));
  } finally {await app.close();}
});


test("assembled production app accepts provider token without application JWT or tenant",async()=>{
  let calls=0;
  const app=createProductionApp({db:{} as Db,verifyToken:async()=>{throw new Error("Application token verifier must not receive provider tokens");},profileProviders:["naver"],profileTransport:async()=>{
    calls++;return Response.json({resultcode:"00",response:{id:"stable-profile",name:"   "}});
  }});
  try {
    const result=await app.inject({url:"/v1/auth/provider-profile/naver",headers:{authorization:"Bearer fixture-provider-token"}});
    assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{sub:"stable-profile",id:"stable-profile"});assert.equal(calls,1);
  } finally {await app.close();}
});
