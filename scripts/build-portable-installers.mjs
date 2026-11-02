#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPayload, payloadProblem } from '../lib/payload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function buildPortableInstallers({ payload, out, version } = {}) {
  payload = resolve(payload); out = resolve(out); version = String(version || '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('portable version is invalid');
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'kingmaker-portable-'));
  try {
    execFileSync('tar', ['-xf', payload, '-C', scratch]);
    const runtime = join(scratch, 'sol-ghost'), proof = checkPayload(runtime, { deep: true, installed: true });
    if (!proof.ok || proof.version !== version) throw new Error(payloadProblem(proof) || `payload version ${proof.version} does not match ${version}`);
    const linuxRoot = join(scratch, `Kingmaker-${version}-linux-x64`), windowsRoot = join(scratch, `Kingmaker-${version}-windows-x64`);
    mkdirSync(linuxRoot); mkdirSync(windowsRoot);
    cpSync(runtime, join(linuxRoot, 'sol-ghost'), { recursive: true }); cpSync(runtime, join(windowsRoot, 'sol-ghost'), { recursive: true });
    cpSync(join(ROOT, 'platform/linux/kingmaker'), join(linuxRoot, 'kingmaker')); execFileSync('chmod', ['755', join(linuxRoot, 'kingmaker')]);
    cpSync(join(ROOT, 'platform/windows/kingmaker.cmd'), join(windowsRoot, 'kingmaker.cmd'));
    cpSync(join(ROOT, 'platform/PORTABLE-NOTES.txt'), join(linuxRoot, 'PORTABLE-NOTES.txt')); cpSync(join(ROOT, 'platform/PORTABLE-NOTES.txt'), join(windowsRoot, 'PORTABLE-NOTES.txt'));
    const linux = join(out, `Kingmaker-${version}-linux-x64.tar.gz`), windows = join(out, `Kingmaker-${version}-windows-x64.zip`);
    execFileSync('tar', ['-czf', linux, '-C', scratch, `Kingmaker-${version}-linux-x64`], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    execFileSync('ditto', ['-c', '-k', '--keepParent', windowsRoot, windows]);
    const artifacts = [{ platform: 'linux', name: linux.split('/').at(-1), size: readFileSync(linux).length, sha256: sha(linux) }, { platform: 'windows', name: windows.split('/').at(-1), size: readFileSync(windows).length, sha256: sha(windows) }];
    writeFileSync(join(out, 'portable-artifacts.json'), `${JSON.stringify({ schema: 'kingmaker.portable-artifacts/1', version, status: 'native-acceptance-pending', artifacts }, null, 2)}\n`);
    return artifacts;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const value = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
  console.log(JSON.stringify(buildPortableInstallers({ payload: value('--payload'), out: value('--out'), version: value('--version') }), null, 2));
}
