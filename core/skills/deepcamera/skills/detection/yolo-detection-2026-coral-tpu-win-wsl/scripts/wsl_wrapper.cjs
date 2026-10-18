const { spawn } = require('child_process');
const path = require('path');

// Ensure usbipd is on PATH (Aegis might have booted before the MSI updated System PATH)
const env = { ...process.env };
if (process.platform === 'win32' && (!env.PATH || !env.PATH.toLowerCase().includes('usbipd-win'))) {
    env.PATH = `${env.PATH || ''};C:\\Program Files\\usbipd-win\\`;
}

// 1. Spawan usbipd auto-attach process in the background
// This guarantees that the Google Coral USB Accelerator is actively passed
// to the WSL linux kernel as soon as this inference script starts!
const attachProcess = spawn('usbipd', ['attach', '--wsl', '--auto-attach', '--hardware-id', '18d1:9302'], {
    env,
    stdio: 'ignore', // We do not want usbipd logs corrupting the JSONL stdout stream!
    detached: true
});

// The absolute path to the skill directory, derived from this script's location
const skillDir = path.resolve(__dirname, '..');
const wslSkillDir = skillDir.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (match, p1) => `/mnt/${p1.toLowerCase()}`);

// Command to run the actual detect.py script inside WSL
// Stdbuf guarantees line-buffering across the WSL boundary so JSONL events stream instantly
const wslCommand = `cd "${wslSkillDir}" && source wsl_venv/bin/activate && stdbuf -oL python3.9 scripts/detect.py`;

// We don't want wsl to launch a login shell, just bash -c
const child = spawn('wsl.exe', ['-u', 'root', '-e', 'bash', '-c', wslCommand], {
    stdio: ['pipe', 'pipe', 'pipe']
});

// Proxy STDIN (Aegis-AI -> WSL)
process.stdin.pipe(child.stdin);

// Proxy STDOUT (WSL -> Aegis-AI)
child.stdout.pipe(process.stdout);

// Proxy STDERR directly to process.stderr so Aegis logs it
child.stderr.pipe(process.stderr);

// When WSL exits (e.g., from Aegis stopping the inference agent)
child.on('exit', (code) => {
    // Kill the background auto-attach loop
    try {
        process.kill(-attachProcess.pid); // Kill process group
    } catch(e) {
        attachProcess.kill();
    }
    process.exit(code || 0);
});

// Handle graceful terminate
process.on('SIGINT', () => {
    child.kill('SIGINT');
});

process.on('SIGTERM', () => {
    child.kill('SIGTERM');
});
