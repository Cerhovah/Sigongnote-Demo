import {startDeliveryWorker} from './delivery-worker.js';
import {startDocumentReadiness} from './document-readiness.js';
import {startOwnerMemory} from './owner-memory.js';
import {startAgentWorker} from './agent-runs.js';
import {startImprovements} from './improvements.js';
import {agentConfiguration} from './product-ai-config.js';
import {claudeRuntime,withClaudePlanner} from './claude-wiring.js';
import {startContextRestore} from './context-restore.js';
import { createApp } from "./app.js";
import { assertRuntimeRole } from "./auth.js";
import { execute, type Services } from "./routes.js";
import { makeApiError } from "@sigongnote/contracts";
import { randomUUID } from "node:crypto";
import { workerHealth } from './worker-health.js';
import {releaseIdentity} from './release.js';

export async function assertProductionDatabase(db: Services["db"]) {
  await assertRuntimeRole(db);
  const [setting] = await db`select setting::bigint as ms from pg_settings where name='statement_timeout'`;
  const timeout = Number(setting?.ms);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000)
    throw new Error("Production role statement timeout is required");
}

export function createProductionApp(services: Services, releaseFile?: URL) {
  const app = createApp(services);
  startOwnerMemory(app,services.db,services.capturePolicy);startDocumentReadiness(app,services);
  startDeliveryWorker(app,services);
  startImprovements(app,services);
  if(services.agentRuntime)startAgentWorker(app,services,withClaudePlanner(services,agentConfiguration()));
 const claude=claudeRuntime();if(claude)startContextRestore(app,services,claude);
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.get("/health/ready", async (_request, reply) => {
    try {
      await assertProductionDatabase(services.db);
      const [row] = await services.db`select to_regclass('app.capture_sources') is not null
        and to_regprocedure('app.session_is_active(uuid,uuid)') is not null
        and to_regclass('app.improvement_heads') is not null
        and to_regclass('app.delivery_attempts') is not null
        and to_regprocedure('app.agent_chain_usage(uuid,uuid)') is not null
        and to_regprocedure('app.strategy_version_allowed(uuid,uuid)') is not null
        and to_regclass('app.strategy_evaluations') is not null
        and exists(select 1 from information_schema.columns where table_schema='app' and table_name='agent_runs' and column_name='root_run_id')
        and exists(select 1 from information_schema.columns where table_schema='app' and table_name='improvement_heads' and column_name='budget_hold_day')
        and to_regprocedure('app.capture_storage_usage()') is not null as ready,
        to_regprocedure('app.release_migrations_applied(text[])') is not null as migration_gate`;
      if (!row?.ready) throw new Error("Not ready");
      const worker=workerHealth();
      const release=releaseIdentity(releaseFile);if(process.env.APP_ENV==='production'&&(release.status!=='identified'||!release.archive_sha256))return reply.code(503).send({service:'sigongnote-api',database:'ready',release});
      if(release.status==='identified'){
        if(!row.migration_gate)return reply.code(503).send({service:'sigongnote-api',database:'migration_pending',release});
        const [schema]=await services.db`select app.release_migrations_applied(${release.migrations}::text[]) as ready`;
        if(!schema?.ready)return reply.code(503).send({service:'sigongnote-api',database:'migration_pending',release});
      }
      if(!worker.ready)return reply.code(503).send({service:'sigongnote-api',database:'ready',worker});
      return { service: "sigongnote-api", database: "ready",migrations:release.status==='identified'?'ready':'unverified',worker,release };
    } catch {
      return reply.code(503).send({ service: "sigongnote-api", database: "unavailable" });
    }
  });
  app.get('/health/release',async(_req,reply)=>reply.header('Cache-Control','no-store').send(releaseIdentity(releaseFile)));
  app.setErrorHandler((error, _request, reply) => {
    const code = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
    if (code === 400 || code === 413 || code === 415) {
      const fault = makeApiError(code === 413 ? "PAYLOAD_TOO_LARGE" :
        code === 415 ? "UNSUPPORTED_MEDIA" : "INVALID_CONTRACT", randomUUID());
      return reply.code(fault.status).send(fault.body);
    }
    return execute(reply, async () => { throw error; });
  });
  return app;
}
