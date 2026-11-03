import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
test('N23 SQLite queue v2 to v3 preserves encrypted originals, receipts and cursors',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("create table scopes(id text primary key,sms_cursor integer,mms_cursor integer);create table messages(scope_id text,message_key text,payload text,receipt text,state text,transfer text);insert into scopes values('scope',150,45);insert into messages values('scope','key','protected-original','protected-receipt','pending','protected-transfer')");
  const source=readFileSync('apps/android/app/src/smsSync/kotlin/com/sigongnote/app/SmsSyncStore.kt','utf8');
  const steps=[...source.matchAll(/db\.execSQL\("(ALTER TABLE scopes ADD COLUMN [^"]+)"\)/g)].map(m=>m[1]!);assert.equal(steps.length,2);
  db.exec('begin');for(const sql of steps)db.exec(sql);db.exec('commit');
  assert.deepEqual({...db.prepare('select * from scopes').get()},{id:'scope',sms_cursor:150,mms_cursor:45,sms_sweep_at:0,mms_sweep_at:0});
  assert.deepEqual({...db.prepare('select * from messages').get()},{scope_id:'scope',message_key:'key',payload:'protected-original',receipt:'protected-receipt',state:'pending',transfer:'protected-transfer'});
 }finally{db.close();}
});
