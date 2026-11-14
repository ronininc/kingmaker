// server-main.mjs — the frame's entry point: serve the surface on the light-runtime port (8931).
// State dir + audit path come from the environment the session/installer sets; loopback only.
import { startSurfaceServer } from './server.mjs';
const stateDir = process.env.RONIN_STATE_DIR ?? new URL('.', import.meta.url).pathname;
const auditPath = process.env.RONIN_AUDIT ?? `${stateDir}/audit.jsonl`;
const server = await startSurfaceServer({ stateDir, auditPath, port: Number(process.env.RONIN_PORT ?? 8931) });
console.log(`ronin surface on http://127.0.0.1:${server.address().port}/`);
