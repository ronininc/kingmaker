// profiles.mjs — DESIGN §9.4 layer 1: named workflow profiles. A starting arrangement, never a fence:
// everything in the bundle stays installable from the catalog regardless of profile.
export const PROFILES = {
  Creator:  { forward: ['Blender', 'FFmpeg', 'OBS Studio', 'OpenCut', 'GIMP', 'ComfyUI', 'yt-dlp', 'Kokoro-82M (weights)'], laneEmphasis: 'FORGE', methods: ['blog-to-reel', 'carousel-forge'] },
  Builder:  { forward: ['OpenCode', 'Hermes Agent', 'FreeCAD', 'OpenSCAD', 'Godot', 'Git', 'Node.js'], laneEmphasis: 'library', methods: ['conducted-build', 'method-writeback'] },
  Operator: { forward: ['PostgreSQL', 'Postiz', 'SearXNG', 'Playwright', 'Chromium'], laneEmphasis: 'money', methods: ['morning-board', 'reply-watch'] },
  Security: { forward: ['ZAP', 'OWASP Nettacker', 'Ghidra', 'Strix', 'OWASP Juice Shop'], laneEmphasis: 'security', methods: ['scope-first-engagement'], note: 'RED\u2019s scope law applies: the lab bench arms only inside a declared RED state with a scope on file (§2.3).' },
  Desk:     { forward: ['Ollama', 'SearXNG', 'Node.js'], laneEmphasis: 'mesh', methods: ['morning-board'] },
};
