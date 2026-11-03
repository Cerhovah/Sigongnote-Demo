const localDb = new URL("postgresql://127.0.0.1:54322/postgres");
localDb.username = "postgres";
localDb.password = "fixture";
export const local = {
  API_URL: "http://127.0.0.1:54321",
  DB_URL: localDb.toString(),
  PUBLISHABLE_KEY: "fixture-publishable",
  SECRET_KEY: "fixture-secret",
};
export const values = {
  SUPABASE_URL: local.API_URL,
  SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: local.SECRET_KEY,
  MIGRATION_DATABASE_URL: local.DB_URL,
  VITE_SUPABASE_URL: local.API_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
  AI_PROVIDER: "claude",
  AI_DAILY_BUDGET_KRW: "10000",
};
export const content = `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n")}\nDATABASE_URL=\n`;
