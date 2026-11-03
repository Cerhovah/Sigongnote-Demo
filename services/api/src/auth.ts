import { createClient } from "@supabase/supabase-js";
import { UuidSchema } from "@sigongnote/contracts";
import type postgres from "postgres";

export type Principal = { userId: string; sessionId: string };
export type TokenVerifier = (accessToken: string) => Promise<Principal | null>;
export type Db = postgres.Sql;
export type Tx = postgres.TransactionSql;

export class TransientAuthError extends Error {
  constructor() { super("Auth service is unavailable"); }
}
export class RateLimitedAuthError extends Error {
  constructor() { super("Auth service rate limited"); }
}

export async function assertRuntimeRole(db: Db) {
  const [role] = await db`select current_user as name, rolsuper, rolbypassrls,
    rolcreaterole, rolcreatedb, rolreplication,
    exists(select 1 from pg_auth_members where member = pg_roles.oid) as has_membership
    from pg_roles where rolname = current_user`;
  if (role?.name !== "sigongnote_api" || role.rolsuper || role.rolbypassrls ||
      role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.has_membership) {
    throw new Error("Unsafe API database role");
  }
}

export function createTokenVerifier(url: string, publishableKey: string): TokenVerifier {
  const client = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return async accessToken => {
    if (accessToken.length > 8192 || accessToken.split(".").length !== 3) return null;
    let result: Awaited<ReturnType<typeof client.auth.getUser>>;
    try { result = await client.auth.getUser(accessToken); }
    catch { throw new TransientAuthError(); }
    const { data, error } = result;
    if (error) {
      if (error.status === 429) throw new RateLimitedAuthError();
      if ((error.status ?? 0) >= 500 || error.name === "AuthRetryableFetchError") {
        throw new TransientAuthError();
      }
      return null;
    }
    if (!data.user) return null;
    try {
      const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
      const userId = UuidSchema.parse(payload.sub);
      const sessionId = UuidSchema.parse(payload.session_id);
      if (userId !== data.user.id) return null;
      return { userId, sessionId };
    } catch { return null; }
  };
}

export async function inAuthorizedTransaction(db: Db, principal: Principal,
  work: (tx: Tx) => Promise<{ status: number; body: unknown }> ) {
  return db.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub', ${principal.userId}, true)`;
    const [session] = await tx`select app.session_is_active(${principal.userId}::uuid,
      ${principal.sessionId}::uuid) as active`;
    if (session?.active !== true) return null;
    return work(tx);
  });
}
