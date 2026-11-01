// Types for lib/k-office.mjs (K Office, Phase 8) — the slice of the office module the TS brain layer
// consumes (runtime/brain-tools.ts, Slice 2). The seat registry, token mint/verify/revoke, and the
// office ledger live in the .mjs module and are NOT re-declared here: the brain surface is read-only
// and reaches only the tool definition, the store opener (for reads), and the tool payload.

export interface KOfficeSeatTokenMeta {
  jti: string;
  seat: string;
  caps: string[];
  iat: number;
  exp: number;
  mintedBy: string;
  state: 'active' | 'revoked' | 'expired';
  [key: string]: unknown;
}

export interface KOfficeStore {
  dir: string;
  listTokens(): KOfficeSeatTokenMeta[];
}

export interface KOfficeToolResult {
  schema: string;
  note: string;
  seats?: Array<Record<string, unknown>>;
  tokens?: KOfficeSeatTokenMeta[];
}

export const K_OFFICE_SCHEMA: string;

export const K_OFFICE_TOOL: Readonly<{
  name: 'kingmaker_office';
  description: string;
  inputSchema: {
    type: 'object';
    properties: {
      view: { type: 'string'; enum: ['seats', 'tokens']; description: string };
    };
    additionalProperties: false;
  };
  annotations: { title: string; readOnlyHint: boolean; openWorldHint: boolean };
}>;

export function defaultOfficeDir(opts?: Record<string, unknown>): string;
export function openOfficeStore(dir?: string, opts?: { now?: () => number }): KOfficeStore;
export function officeToolResult(input?: { view?: string }, store?: KOfficeStore | null): KOfficeToolResult;
