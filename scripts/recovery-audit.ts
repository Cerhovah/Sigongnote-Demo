import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import {verifyLocalDevelopmentDb} from './db-gate.mjs';
import {parseStrictLocalEnv} from './local-env-values.mjs';

/** Counts only: never return original rows, tenant IDs, object keys or credentials. */
export async function foreignKeyGapDetails(db:postgres.TransactionSql){
 const keys=await db`select con.conname,con.convalidated,n.nspname ns,c.relname tab,pn.nspname pns,pc.relname ptab,
 (select jsonb_agg(jsonb_build_object('child',a.attname,'parent',pa.attname) order by k.ord) from unnest(con.conkey,con.confkey) with ordinality k(child,parent,ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.child join pg_attribute pa on pa.attrelid=con.confrelid and pa.attnum=k.parent) columns
 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class pc on pc.oid=con.confrelid join pg_namespace pn on pn.oid=pc.relnamespace where con.contype='f' and n.nspname='app' order by c.relname,con.conname`;
 const gaps:Record<string,{rows:number;validated:boolean}>={};const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
 for(const k of keys){const cols=k.columns as {child:string;parent:string}[];const [row]=await db.unsafe(`select count(*)::int n from ${q(k.ns)}.${q(k.tab)} c where ${cols.map(x=>'c.'+q(x.child)+' is not null').join(' and ')} and not exists(select 1 from ${q(k.pns)}.${q(k.ptab)} p where ${cols.map(x=>'p.'+q(x.parent)+'=c.'+q(x.child)).join(' and ')})`);if(Number(row?.n))gaps[k.tab+'.'+k.conname]={rows:Number(row?.n),validated:Boolean(k.convalidated)};}
 return gaps;
}
export async function foreignKeyGaps(db:postgres.TransactionSql){
 return Object.fromEntries(Object.entries(await foreignKeyGapDetails(db)).map(([key,value])=>[key,value.rows]));
}
/** Device-only evidence is not a missing server object; its recovery remains unverified. */
export async function originalLocationCounts(db:postgres.Sql|postgres.TransactionSql){
 const [row]=await db`select count(*) filter(where b.storage_location='server')::int server_original_references,
 count(*) filter(where b.storage_location='device')::int device_originals_not_checked,
 count(*) filter(where b.storage_location='server' and not exists(select 1 from storage.objects o where o.bucket_id='sigongnote-originals' and o.name=b.storage_key))::int missing_original_metadata
 from app.evidence_blobs b`;
 return {server_original_references:Number(row?.server_original_references??0),device_originals_not_checked:Number(row?.device_originals_not_checked??0),missing_original_metadata:Number(row?.missing_original_metadata??0)};
}
export async function localRecoveryAudit(){
 if((await verifyLocalDevelopmentDb()).status!=='READY')throw Error('LOCAL_DB_REQUIRED');
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));
 const db=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
 try{return await db.begin('isolation level repeatable read read only',async tx=>{
  const details=await foreignKeyGapDetails(tx),gaps=Object.fromEntries(Object.entries(details).map(([key,value])=>[key,value.rows]));
  const locations=await originalLocationCounts(tx);
  return {schema:3,checked_at:new Date().toISOString(),foreign_key_gaps:gaps,foreign_key_gap_details:details,broken_reference_rows:Object.values(gaps).reduce((a,b)=>a+b,0),...locations,object_bytes_checked:false,read_only:true};
 });}finally{await db.end();}
}
if(process.argv[1]?.endsWith('recovery-audit.ts'))localRecoveryAudit().then(v=>{console.log(JSON.stringify(v));if(v.broken_reference_rows||v.missing_original_metadata)process.exitCode=1;},()=>{console.error('RECOVERY_AUDIT_UNAVAILABLE');process.exitCode=1;});
