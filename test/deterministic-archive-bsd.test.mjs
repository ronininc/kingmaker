import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, chmodSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDeterministicArchive, probeTarFlavor } from '../lib/deterministic-archive.mjs';

test('BSD mtree normalization preserves special names, links, modes and source metadata', { skip: probeTarFlavor() !== 'bsd' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'km-bsd-test-'));
  try {
    const source = join(root, 'Sample app'); mkdirSync(source);
    const name = 'space ü # equals= newline\nfile';
    const file = join(source, name); writeFileSync(file, 'exact content\n'); chmodSync(file, 0o755);
    symlinkSync(name, join(source, 'relative link'));
    const before = statSync(file).mtimeMs;
    const a = await createDeterministicArchive({ dir: source, outFile: join(root, 'a.tgz') });
    assert.equal(statSync(file).mtimeMs, before, 'source is never normalized in place');
    utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
    const b = await createDeterministicArchive({ dir: source, outFile: join(root, 'b.tgz') });
    assert.equal(a.sha256, b.sha256);
    const out = join(root, 'out'); mkdirSync(out);
    execFileSync('tar', ['-xzf', join(root, 'b.tgz'), '-C', out]);
    assert.equal(readFileSync(join(out, 'Sample app', name), 'utf8'), 'exact content\n');
    assert.equal(readlinkSync(join(out, 'Sample app', 'relative link')).normalize('NFC'), readlinkSync(join(source, 'relative link')).normalize('NFC'), 'macOS archive extraction canonically normalizes Unicode names');
    assert.equal(readFileSync(join(out, 'Sample app', 'relative link'), 'utf8'), 'exact content\n');
    assert.equal(statSync(join(out, 'Sample app', name)).mode & 0o777, 0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
