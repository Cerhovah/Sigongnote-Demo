import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {recoveryCommand} from './recovery-io.js';
type Inventory=Record<string,{count:number;hash:string}>;
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
async function removeIsolated(id:string){
 const label=(await recoveryCommand(['inspect','--format','{{index .Config.Labels "sigongnote.recovery"}}',id])).toString().trim();
 if(label!=='isolated')throw Error('RECOVERY_CLEANUP_SCOPE');
 await recoveryCommand(['rm','--force',id]);
}
/** New, disconnected PostgreSQL cluster: no source credentials, host ports or application processes. */
export async function isolatedDatabaseRestore(sourceContainer:string,dump:Uint8Array,roles:string[],expected:Inventory,tenantTest:string){
 if(!/^supabase_db_[a-z0-9-]+$/.test(sourceContainer)||!roles.every(r=>/^[a-z_][a-z0-9_]{0,62}$/.test(r)))throw Error('RECOVERY_TARGET_SCOPE');
 const image=(await recoveryCommand(['inspect','--format','{{.Image}}',sourceContainer])).toString().trim();if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('RECOVERY_IMAGE_REQUIRED');
 const name='sigongnote-recovery-'+randomUUID(),database='recovery_'+randomUUID().replaceAll('-','');let id:string|null=null;
 try{
  id=(await recoveryCommand(['run','--rm','--detach','--name',name,'--label','sigongnote.recovery=isolated','--network','none','--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=1073741824','--env','POSTGRES_HOST_AUTH_METHOD=trust',image])).toString().trim();
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('RECOVERY_CONTAINER_ID');
  let ready=false;for(let i=0;i<80;i++){try{const process=(await recoveryCommand(['exec',id,'cat','/proc/1/comm'])).toString().trim();if(/^(postgres|\.postgres-wrapp)$/.test(process)){await recoveryCommand(['exec',id,'pg_isready','-U','postgres']);ready=true;break;}}catch{/* A temporary initdb server is not the final cluster. */}await delay(250);}if(!ready)throw Error('RECOVERY_CLUSTER_NOT_READY');
  const sql=async(value:string,db=database)=>(await recoveryCommand(['exec','-i',id!,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',db],Buffer.from(value))).toString().trim();
  for(const role of roles.filter(r=>r!=='postgres'))await sql(`do $roles$ begin if not exists(select 1 from pg_roles where rolname='${role}') then create role ${quote(role)} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if; end $roles$;`,'postgres');
  await sql(`alter role sigongnote_api nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; alter role sigongnote_worker nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; create database ${database} template template0;`,'postgres');
  await recoveryCommand(['exec','-i',id,'pg_restore','-U','supabase_admin','-d',database,'--exit-on-error','--no-owner','--no-publications','--no-subscriptions'],dump);
  // Hash on the isolated server; no original rows leave its private database pipe.
  const raw=await sql(`create temporary table recovered_inventory(name text,n bigint,digest text);
do $inventory$ declare r record; begin for r in select schemaname,tablename from pg_tables where schemaname in ('app','auth','storage','supabase_migrations') order by schemaname,tablename loop
 execute format('insert into recovered_inventory select %L,count(*),encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text||chr(10),'''' order by to_jsonb(t)::text collate "C"),''''),''UTF8'')),''hex'') from %I.%I t',r.schemaname||'.'||r.tablename,r.schemaname,r.tablename);
end loop; end $inventory$;
select coalesce(jsonb_object_agg(name,jsonb_build_object('count',n,'hash',digest)),'{}') from recovered_inventory;`);
  const actual=JSON.parse(raw) as Inventory;const names=Object.keys(expected).sort();if(JSON.stringify(Object.keys(actual).sort())!==JSON.stringify(names)||names.some(n=>actual[n]?.count!==expected[n]?.count||actual[n]?.hash!==expected[n]?.hash))throw Error('RECOVERY_ISOLATED_ROWS_DIFFER');
  // The exact security registry exercises positive owners and negative tenant/source boundaries.
  await sql(tenantTest);
  const rolesSafe=JSON.parse(await sql(`select to_json(bool_and(not rolcanlogin and not rolsuper and not rolbypassrls and not rolcreatedb and not rolcreaterole and not rolreplication)) from pg_roles where rolname in ('sigongnote_api','sigongnote_worker');`));if(rolesSafe!==true)throw Error('RECOVERY_ROLE_PRIVILEGE');
  const network=JSON.parse((await recoveryCommand(['inspect','--format','{{json .HostConfig.NetworkMode}}',id])).toString());const ports=(await recoveryCommand(['port',id])).toString().trim();if(network!=='none'||ports)throw Error('RECOVERY_EFFECT_FENCE');
  const retained=JSON.parse(await sql(`select json_build_object('unknown_delivery_attempts',(select count(*) from app.delivery_attempts where state='unknown' and submitted_at is not null),'pending_outbox',(select count(*) from app.outbox where state='pending'));`));
  return {retained,isolated_cluster:true,roles_recreated:true,role_registry_verified:true,all_rows_equal:true,external_network:false,published_ports:0,app_role_login:false,provider_credentials_loaded:false,external_effects_replayed:false,physical_new_host:false};
 }finally{
  // Only the immutable ID returned by this call may be removed; never a pre-existing database/container.
  if(id&&/^[a-f0-9]{64}$/.test(id))await removeIsolated(id);
 }
}
