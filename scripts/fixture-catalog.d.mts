export function verifyFixtureCatalog(): {
  structures: { documents: unknown[] };
  oracles: { execution_state: string; cases: Array<{ execution_state?: string }> };
  registries: { base: string[]; "joinery-v1": string[] };
  sourceIndex: { cases: unknown[] };
  fixtureSha256: string;
};
