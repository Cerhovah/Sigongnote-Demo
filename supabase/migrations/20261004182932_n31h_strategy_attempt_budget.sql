alter table app.strategy_evaluations add column attempts integer not null default 1 check(attempts>0),add column attempt_day date not null default ((now() at time zone 'Asia/Seoul')::date);
grant update(attempts,attempt_day,prediction,passed) on app.strategy_evaluations to sigongnote_api;
