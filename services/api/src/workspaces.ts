import { createHash } from "node:crypto";
import { WorkspaceCreateRequestSchema, WorkspaceResponseSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, principal, type Services } from "./routes.js";

export function registerWorkspaceRoutes(app: FastifyInstance, services: Services) {
  app.post("/v1/workspaces", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services), key = idempotencyKey(request);
    const parsed = WorkspaceCreateRequestSchema.safeParse(request.body);
    if (!parsed.success || request.headers["x-tenant-id"] !== undefined) throw new ApiFault("INVALID_CONTRACT");
    const hash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
    return inAuthorizedTransaction(services.db, actor, async tx => {
      const [row] = await tx`select app.bootstrap_workspace(${actor.sessionId}::uuid,${key}::uuid,${parsed.data.display_name},${hash}) as receipt`;
      if (row?.receipt?.requires_invitation === true) throw new ApiFault("FORBIDDEN");
      return { status: 201, body: WorkspaceResponseSchema.parse(row?.receipt) };
    });
  }));
}
