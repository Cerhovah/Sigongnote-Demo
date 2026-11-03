import type postgres from 'postgres';
import {foreignKeyGaps} from '../scripts/recovery-audit.js';

/** Test-only: call inside the local fixture transaction with this test's freshly created IDs. */
export async function deleteFixtureTenants(tx:postgres.TransactionSql,tenantIds:string[]){
 if(!tenantIds.length||tenantIds.some(id=>!/^[a-f0-9-]{36}$/i.test(id)))throw Error('FIXTURE_IDS_REQUIRED');
 const [current]=await tx`select current_database() database`;const database=String(current?.database??'');
 if(database!=='postgres'&&!/^sigongnote_(?:drill_seed|e2e)_[a-f0-9]{1,40}$/.test(database))throw Error('LOCAL_FIXTURE_DATABASE_REQUIRED');
 // Fence background workers' FK inserts into these disposable tenants during cleanup.
 await tx`select id from app.tenants where id=any(${tenantIds}::uuid[]) order by id for update`;
 const before=await foreignKeyGaps(tx);
 const [setting]=await tx`select current_setting('session_replication_role') mode`;const mode=String(setting?.mode??'origin');
 await tx`set local session_replication_role=replica`;
 const tables=await tx`select c.table_name from information_schema.columns c join pg_tables p on p.schemaname=c.table_schema and p.tablename=c.table_name where c.table_schema='app' and c.column_name='tenant_id' order by c.table_name`;
 for(const table of tables)await tx`delete from ${tx('app.'+table.table_name)} where tenant_id=any(${tenantIds}::uuid[])`;
 // Restore FK cascades for the final parent deletion. No other session's triggers are changed.
 await tx`set local session_replication_role=origin`;
 await tx`delete from app.tenants where id=any(${tenantIds}::uuid[])`;
 const after=await foreignKeyGaps(tx);
 if(Object.entries(after).some(([key,count])=>count>(before[key]??0)))throw Error('FIXTURE_CLEANUP_CREATED_ORPHANS');
 if(mode==='replica')await tx`set local session_replication_role=replica`;
 else if(mode==='local')await tx`set local session_replication_role=local`;
}
