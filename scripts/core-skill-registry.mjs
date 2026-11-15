import { buildCoreSkillRegistry, verifyCoreSkillRegistry } from '../lib/core-skill-registry.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[2] === '--verify') {
 const result = verifyCoreSkillRegistry(root, JSON.parse(readFileSync(process.argv[3], 'utf8')));
 console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
} else console.log(JSON.stringify(buildCoreSkillRegistry(root), null, 2));
