import {deleteFixtureTenants} from './fixture-cleanup.js';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres from "postgres";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { createApp } from "../services/api/src/app.js";

test("first workspace is atomic, user-scoped, retryable and cannot grant a claimed company", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status,"READY");
  const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));assert(env.MIGRATION_DATABASE_URL && env.DATABASE_URL);
  const admin=postgres(env.MIGRATION_DATABASE_URL,{max:1}),runtime=postgres(env.DATABASE_URL,{max:4});
  const actor=randomUUID(),other=randomUUID(),former=randomUUID(),session=randomUUID(),otherSession=randomUUID(),formerSession=randomUUID(),key=randomUUID();
  const app=createApp({db:runtime,verifyToken:async token=>token==="fixture"?{userId:actor,sessionId:session}:token==="other"?{userId:other,sessionId:otherSession}:token==="former"?{userId:former,sessionId:formerSession}:null});
  const call=(payload:object,requestKey=key,token="fixture",extra={})=>app.inject({method:"POST",url:"/v1/workspaces",headers:{authorization:`Bearer ${token}`,"idempotency-key":requestKey,...extra},payload});
  try {
    await admin`insert into auth.users(id) values(${actor}::uuid),(${other}::uuid),(${former}::uuid)`;
    await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${actor}::uuid),(${otherSession}::uuid,${other}::uuid),(${formerSession}::uuid,${former}::uuid)`;
    assert.equal((await call({display_name:"fixture"},key,"invalid")).statusCode,401);
    assert.equal((await call({display_name:"fixture",tenant_id:randomUUID()})).statusCode,400);
    assert.equal((await call({display_name:"fixture",role:"owner"})).statusCode,400);
    assert.equal((await call({display_name:"fixture"},key,"fixture",{"x-tenant-id":randomUUID()})).statusCode,400);
    const pair=await Promise.all([call({display_name:" 합성 회사 "}),call({display_name:"합성 회사"})]);
    for(const result of pair)assert.equal(result.statusCode,201,result.body);
    assert.deepEqual(pair[0]?.json(),pair[1]?.json());
    const company=pair[0]?.json().tenant_id;
    assert.equal(pair[0]?.json().role,"owner");
    assert.equal((await call({display_name:"다른 회사"})).statusCode,409);
    assert.equal((await call({display_name:"합성 회사"},randomUUID())).statusCode,409);
    const me=await app.inject({method:"GET",url:"/v1/me",headers:{authorization:"Bearer fixture"}});
    assert.equal(me.json().memberships.length,1);assert.equal(me.json().memberships[0].tenant_id,company);
    const project=await app.inject({method:"POST",url:"/v1/projects",headers:{authorization:"Bearer fixture","x-tenant-id":company,"idempotency-key":randomUUID()},payload:{display_name:"첫 현장"}});
    assert.equal(project.statusCode,201,project.body);
    await admin`insert into app.memberships(tenant_id,user_id,role,active,revoked_at) values(${company}::uuid,${former}::uuid,'operator',false,now())`;
    assert.equal((await call({display_name:"새 회사"},randomUUID(),"former")).statusCode,403);
    const isolated=await call({display_name:"다른 사용자 회사"},key,"other");assert.equal(isolated.statusCode,201,isolated.body);assert.notEqual(isolated.json().tenant_id,company);
    const [count]=await admin`select count(*)::int n from app.workspace_bootstraps where user_id in (${actor}::uuid,${other}::uuid)`;assert.equal(count?.n,2);
    const [privileges]=await admin`select has_function_privilege('anon','app.bootstrap_workspace(uuid,uuid,text,text)','execute') a,has_function_privilege('authenticated','app.bootstrap_workspace(uuid,uuid,text,text)','execute') b,has_table_privilege('sigongnote_api','app.workspace_bootstraps','insert') c`;
    assert.deepEqual(privileges,{a:false,b:false,c:false});
    await admin`delete from auth.sessions where id=${session}::uuid`;
    assert.equal((await call({display_name:"합성 회사"})).statusCode,401);
  } finally {
    await app.close();
    await admin.begin(async tx=>{
      const tenants=await tx`select tenant_id from app.workspace_bootstraps where user_id in (${actor}::uuid,${other}::uuid)`;
      if(tenants.length)await deleteFixtureTenants(tx,tenants.map(row=>String(row.tenant_id)));
      await tx`delete from auth.sessions where id in (${session}::uuid,${otherSession}::uuid,${formerSession}::uuid)`;
      await tx`delete from auth.users where id in (${actor}::uuid,${other}::uuid,${former}::uuid)`;
    });
    await runtime.end();await admin.end();
  }
});
