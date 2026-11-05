import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

function executable(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error('release refused: prerequisite executable missing: ' + file);
  fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  return file;
}
function run(file, args, env, input = '') {
  const result = spawnSync(file, args, { input, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.error || result.signal) throw new Error('release refused: prerequisite did not run: ' + path.basename(file));
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}
export function verifyPrerequisites({ ghidraHome, jdkHome }) {
  if (!ghidraHome || !jdkHome) throw new Error('release refused: real Ghidra and JDK homes are required');
  const propsFile = path.join(ghidraHome, 'Ghidra', 'application.properties');
  if (!fs.existsSync(propsFile)) throw new Error('release refused: Ghidra version metadata is missing');
  const props = fs.readFileSync(propsFile, 'utf8');
  const version = /^application.version=(.+)$/m.exec(props)?.[1]?.trim();
  const minimum = Number(/^application.java.min=(\d+)/m.exec(props)?.[1] || 25);
  if (!version || !Number.isInteger(minimum)) throw new Error('release refused: invalid Ghidra version metadata');
  const java = executable(path.join(jdkHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  const env = { ...process.env, JAVA_HOME: path.resolve(jdkHome) };
  const javaResult = run(java, ['-version'], env);
  const javaVersion = /version "([^\"]+)"/.exec(javaResult.output)?.[1];
  if (javaResult.status !== 0 || !javaVersion || Number(javaVersion.split('.')[0]) < minimum) throw new Error('release refused: JDK cannot satisfy Ghidra Java minimum ' + minimum);
  const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const arch = { arm64: 'arm_64', x64: 'x86_64' }[process.arch];
  if (!os || !arch) throw new Error('release refused: unsupported native decompiler platform');
  const native = executable(path.join(ghidraHome, 'Ghidra', 'Features', 'Decompiler', 'os', os + '_' + arch, process.platform === 'win32' ? 'decompile.exe' : 'decompile'));
  const header = fs.readFileSync(native).subarray(0, 4), magic = header.length === 4 ? header.readUInt32BE(0) : 0;
  if (!([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0x7f454c46].includes(magic) || header.subarray(0, 2).toString() === 'MZ')) throw new Error('release refused: native decompiler is not an executable image');
  const nativeResult = run(native, [], env);
  // Ghidra's protocol worker may return 1 on closed input without a command.
  // This checks actual OS loading, not analysis success; real fixture scans
  // separately prove the Java/native pipeline and literal-control behavior.
  if (![0, 1].includes(nativeResult.status)) throw new Error('release refused: native decompiler cannot start');
  const headless = executable(path.join(ghidraHome, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless'));
  const help = run(headless, [], env);
  if (![0, 1].includes(help.status) || !/analyzeHeadless|Headless Analyzer|Usage:/i.test(help.output)) throw new Error('release refused: Ghidra headless launcher cannot start');
  if (typeof crypto.encapsulate !== 'function' || typeof crypto.decapsulate !== 'function') throw new Error('release refused: Node lacks required post-quantum APIs');
  crypto.generateKeyPairSync('ml-kem-768'); crypto.generateKeyPairSync('ml-dsa-65');
  return { schema: 'scripture-armor.prerequisites/1', platform: process.platform, arch: process.arch, ghidraVersion: version, javaVersion, nodeVersion: process.version, requiresExternalNode: true,
    nativeDecompilerSha256: crypto.createHash('sha256').update(fs.readFileSync(native)).digest('hex'), checks: ['java-version', 'native-decompiler-start', 'headless-launcher-start', 'node-pq-key-generation'] };
}
