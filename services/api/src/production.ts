import {configuredFax} from './fax-provider.js';
import {configuredActivityObservers} from './work-activity.js';
import { configuredProfileProviders } from "./provider-profiles.js";
import {configuredShortStt} from './short-stt.js';
import postgres from "postgres";
import { createTokenVerifier } from "./auth.js";
import { createStorageGateway } from "./storage.js";
import { loadProductionConfig } from "./production-config.js";
import { assertProductionDatabase, createProductionApp } from "./production-app.js";
import { registerCloudWeb } from "./cloud-web.js";
import { CapturePolicySchema } from "@sigongnote/contracts";
import { resolve } from "node:path";

// The hosting ingress owns HTTPS. This listener is private to its service container.
try {
  const config = loadProductionConfig();
  const db = postgres(config.databaseUrl, { max: config.poolSize, prepare: false,
    ssl: { rejectUnauthorized: true, ca: config.ca },
    connect_timeout: 5, idle_timeout: 20,
    onnotice: () => {} });
  try { await assertProductionDatabase(db); }
  catch { await db.end({ timeout: 5 }); throw new Error("Database unavailable"); }
  const policy=process.env.CAPTURE_POLICY_JSON?CapturePolicySchema.parse(JSON.parse(process.env.CAPTURE_POLICY_JSON)):undefined;
  const app = createProductionApp({ activityObserverUserIds:configuredActivityObservers(),fax:configuredFax(),agentRuntime:true,db, shortStt:configuredShortStt(), ...(policy?{capturePolicy:policy}:{}), profileProviders:configuredProfileProviders(process.env.OAUTH_PROFILE_PROVIDERS),
    verifyToken: createTokenVerifier(config.supabaseUrl, config.publishableKey),
    storage: createStorageGateway(config.supabaseUrl, config.secretKey) });
  if(process.env.CLOUD_WEB_ORIGIN){
    await registerCloudWeb(app,{authOrigin:config.supabaseUrl,publishableKey:config.publishableKey,
      sessionSecret:process.env.CLOUD_WEB_SESSION_SECRET??'',publicOrigin:process.env.CLOUD_WEB_ORIGIN,
      providers:(process.env.CLOUD_WEB_LOGIN_PROVIDERS??'').split(',').filter(Boolean),webRoot:resolve('apps/web/dist')});
  }
  app.addHook("onClose", async () => { await db.end({ timeout: 5 }); });
  try { await app.listen({ host: "0.0.0.0", port: config.port }); }
  catch { await app.close(); throw new Error("Listener unavailable"); }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    const limit = setTimeout(() => process.exit(1), 25000).unref();
    void app.close().then(() => { clearTimeout(limit); }, () => { process.exitCode = 1; });
  });
  console.log("Sigongnote API started");
} catch {
  // Libraries can attach connection URLs to errors; never print the original error.
  console.error("Sigongnote API startup failed: check private configuration and database access");
  process.exitCode = 1;
}
