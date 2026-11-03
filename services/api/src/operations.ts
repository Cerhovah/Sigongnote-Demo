import type {Tx} from './auth.js';
import {workerHealth} from './worker-health.js';
import {releaseIdentity} from './release.js';
/** Called only after current-company owner authorization; all SQL keeps RLS enabled. */
export async function readOperations(tx:Tx,tenant:string){
 const queues=await tx`select job_type as kind,count(*) filter(where state in ('queued','retry_wait','leased'))::int pending,
 count(*) filter(where state='leased' and lease_expires_at<now())::int expired_leases,count(*) filter(where state='dead')::int failed,
 coalesce(extract(epoch from now()-min(created_at) filter(where state in ('queued','retry_wait','leased'))),0)::int oldest_seconds
 from app.jobs where tenant_id=${tenant}::uuid group by job_type order by job_type`;
 const [outbox]=await tx`select count(*) filter(where state='pending')::int pending from app.outbox where tenant_id=${tenant}::uuid`;
 const [delivery]=await tx`select count(*) filter(where state in ('unknown','submitted'))::int unknown,
 coalesce(sum(actual_krw),0)::text known_krw,coalesce(sum(reserved_krw) filter(where actual_krw is null),0)::text reserved_krw
 from app.delivery_attempts where tenant_id=${tenant}::uuid and (created_at>=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' or actual_krw is null)`;
 const [budget]=await tx`select app.product_ai_summary() value`;const [storage]=await tx`select app.capture_storage_usage() value`;
 return {checked_at:new Date().toISOString(),scope:'current_company',queues,outbox,delivery,budget:{...budget?.value,scope:'current_user_all_companies',includes_reservations:true},storage:{...storage?.value,scope:'current_user_all_companies'},worker:workerHealth(),release:releaseIdentity(),acceptance:'not_evaluated'};
}
