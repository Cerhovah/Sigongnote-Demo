export function assessDevelopmentDb(env: Record<string, string | undefined>): { status: "BLOCKED"; scope: string; reason: string };
export function localEnvironmentMatches(content: string, local: Record<string, string>): boolean;
export function verifyLocalDevelopmentDb(envPath?: string, options?: { requireRuntimeRole?: boolean }): Promise<{ status: "BLOCKED" | "READY"; scope?: string; reason: string }>;
