import {registerArchiveProcessing} from './work-archive.js';
import {registerLocalJournalSync} from './local-journal-sync.js';
import {registerJournalActions} from './journal-actions.js';
import {registerWorkJournal} from './work-journal.js';
import {registerWorkLedger} from './work-ledger.js';
import {registerBusinessEventRoutes} from './business-events.js';
import {registerAgentRuns} from './agent-runs.js';
import {registerDocumentSummary} from './document-summary.js';
import {registerContextLearning} from './context-learning.js';
import {claudeRuntime} from './claude-wiring.js';
import { registerProviderProfileRoutes } from "./provider-profiles.js";
import Fastify from "fastify";

import type { Services } from "./routes.js";
import { registerRoutes } from "./routes.js";
export function createApp(services?: Services) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  if (services) registerLocalJournalSync(app, services);
  if (services) registerContextLearning(app, services);
  app.get("/health/live", async () => ({ service: "sigongnote-api", status: "alive" }));
  // Liveness is deliberately not DB readiness or tenant access.
  if (services) { registerRoutes(app, services); registerBusinessEventRoutes(app, services); registerWorkLedger(app,services); registerWorkJournal(app,services); registerJournalActions(app,services); registerArchiveProcessing(app,services); registerAgentRuns(app,services); registerDocumentSummary(app,services,services.claudeRuntime??claudeRuntime(),services.claudeRunner); registerProviderProfileRoutes(app, services.profileProviders, services.profileTransport); }
  return app;
}
