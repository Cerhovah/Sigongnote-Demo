-- Only workspace owners can see aggregate maintenance data; never return receipt/body/path.
create function app.maintenance_status(t uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when app.has_tenant_role(t,array['owner']) then jsonb_build_object(
 'checked_at',now(),
 'jobs',(select jsonb_build_object('waiting',count(*) filter(where state in ('queued','retry_wait')),
   'working',count(*) filter(where state='leased'),'failed',count(*) filter(where state='dead'),
   'oldest_wait_seconds',extract(epoch from now()-min(created_at) filter(where state in ('queued','retry_wait','leased'))),
   'last_completed_at',max(updated_at) filter(where state='succeeded')) from app.jobs where tenant_id=t),
 'capture',(select jsonb_build_object('connected',count(*) filter(where active),'gated',count(*) filter(where active and capability='policy_gated'),
   'pending',coalesce(sum(pending_count) filter(where active),0),'bytes_pending',coalesce(sum(bytes_pending) filter(where active),0),
   'last_received_at',max(last_server_ack_at)) from app.capture_sources where tenant_id=t),
 'usage',(select jsonb_build_object('period_start',date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul',
   'voice_reserved_seconds',coalesce(sum(reserved_seconds),0),'voice_known_cost_minor',sum(cost_minor)::text,
   'voice_unknown_cost_count',count(*) filter(where cost_minor is null),
   'audio_reserved_seconds',(select coalesce(sum(seconds),0) from app.audio_reservations where tenant_id=t and created_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'),
   'total_cost_minor',null,'cost_status','unreconciled') from app.voice_requests where tenant_id=t and created_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
 ) else null end
$$;
revoke all on function app.maintenance_status(uuid) from public,anon,authenticated,service_role;
grant execute on function app.maintenance_status(uuid) to sigongnote_api;
