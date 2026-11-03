export const E2E_ENV_FILE: string;
export type E2eEnv = { database: string; admin_url: string; api_url: string; worker_url: string; migrations?: number; created_at?: string };
export function migrationFiles(dir?: string): string[];
export function createE2eDatabase(options?: { name?: string; admin?: string; quiet?: boolean; writeEnv?: boolean }): Promise<E2eEnv>;
export function readE2eEnv(): E2eEnv | null;
export function dropE2eDatabase(env?: E2eEnv | null, admin?: string): Promise<boolean>;
export function writeApplicationEnv(env: E2eEnv, file?: string): boolean;
