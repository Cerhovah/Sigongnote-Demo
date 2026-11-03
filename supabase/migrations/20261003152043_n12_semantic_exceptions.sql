-- A human-selected question binds a durable answer; model output cannot grant approval.
alter table app.agent_runs add column answer_target jsonb check(answer_target is null or jsonb_typeof(answer_target)='object' and octet_length(answer_target::text)<256);
