// The iPhone bridge's methods in Kingmaker's MCP registry (lib/mcp.mjs adds IPHONE_TOOLS to TOOLS). Names are the
// build order's. There is no tool that approves, trusts a contact, syncs the do-not-call list or changes policy:
// those are the owner's own acts at the Kingmaker CLI, each behind their Touch ID.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runProcess } from './iphone-bridge.mjs';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SCREEN_NOTE = 'Returns the screen after the action (text elements with x/y tap points in window points) so you can decide the next step.';

export const IPHONE_TOOLS = Object.freeze([
  {
    name: 'see-phone-screen',
    description: 'See the owner\'s iPhone screen now (through iPhone Mirroring on this Mac): every text element with its tap point, a screen class (ok | compose | secret), and a picture. Read-only, local.',
    inputSchema: obj({ image: { type: 'boolean', description: 'Include a picture of the screen (default true).' } }),
    annotations: { title: 'iPhone: see the screen', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'tap-phone',
    description: `Tap on the iPhone: by the text on screen (preferred: "Settings", "General") or by x/y in window points from see-phone-screen. Stops on a password/code/payment screen. Tapping Send/Call-like buttons, or anything on a message-compose screen, waits for the owner's Touch ID. ${SCREEN_NOTE}`,
    inputSchema: obj({ text: { type: 'string' }, index: { type: 'integer', description: 'Which match, top to bottom (0 = first).' }, x: { type: 'number' }, y: { type: 'number' } }),
    annotations: { title: 'iPhone: tap', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'type-on-phone',
    description: `Type text into the focused field on the iPhone. Never passwords, codes or payment details (refused; the owner types those). Typing into a message box waits for the owner's Touch ID: to message someone use send-imessage-to-contact. ${SCREEN_NOTE}`,
    inputSchema: obj({ text: { type: 'string' }, submit: { type: 'boolean', description: 'Press Return after typing.' } }, ['text']),
    annotations: { title: 'iPhone: type', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'press-phone-button',
    description: `Press home, app-switcher, spotlight, return, delete, escape, tab or an arrow on the iPhone. ${SCREEN_NOTE}`,
    inputSchema: obj({ button: { type: 'string', enum: ['home', 'app-switcher', 'spotlight', 'return', 'delete', 'escape', 'tab', 'up', 'down', 'left', 'right'] } }, ['button']),
    annotations: { title: 'iPhone: button', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'swipe-phone',
    description: `Swipe on the iPhone (up scrolls down the page). ${SCREEN_NOTE}`,
    inputSchema: obj({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } }),
    annotations: { title: 'iPhone: swipe', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'open-phone-app',
    description: `Open an app on the iPhone by name (through Spotlight). Wallet and Passwords are refused. ${SCREEN_NOTE}`,
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    annotations: { title: 'iPhone: open app', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'call-from-phone',
    description: 'Call someone IN THE OWNER\'S CONTACTS from their iPhone\'s SIM (macOS Calls from iPhone). Strangers, do-not-call numbers and ambiguous names are refused. Waits for the owner\'s Touch ID unless they trusted that contact for calls themself.',
    inputSchema: obj({ to: { type: 'string', description: 'A contact name, or their number.' } }, ['to']),
    annotations: { title: 'iPhone: call a known contact', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'send-imessage-to-contact',
    description: 'Send an iMessage (or SMS) from the owner\'s number to someone IN THEIR CONTACTS. Unknown numbers/handles are refused, as are do-not-call numbers, ambiguous names and messages carrying passwords, codes or card details. Waits for the owner\'s Touch ID unless they trusted that contact themself.',
    inputSchema: obj({ to: { type: 'string', description: 'A contact name, or their number or email.' }, text: { type: 'string' }, channel: { type: 'string', enum: ['imessage', 'sms'] } }, ['to', 'text']),
    annotations: { title: 'iPhone: message a known contact', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'phone-bridge-status',
    description: 'Is the iPhone bridge ready: helper built, permissions (Screen Recording, Accessibility, Contacts), iPhone Mirroring open, do-not-call snapshot fresh. Read-only.',
    inputSchema: obj({}),
    annotations: { title: 'iPhone: bridge status', readOnlyHint: true, openWorldHint: false },
  },
]);

export const IPHONE_TOOL_NAMES = new Set(IPHONE_TOOLS.map((t) => t.name));

const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
const slim = (screen) => screen && { screen: screen.screen, window: screen.window, elements: screen.elements.map(({ text: t, x, y }) => ({ text: t, x, y })), ms: screen.ms };

async function picture(image, run) {
  const small = join(dirname(image), 'latest-small.png');
  const r = await run('/usr/bin/sips', ['-Z', '1000', image, '--out', small]);
  return r.code === 0 ? { type: 'image', data: readFileSync(small).toString('base64'), mimeType: 'image/png' } : null;
}

/** One iPhone tool call → MCP result. */
export async function callIphoneTool(name, args = {}, { bridge, run = runProcess } = {}) {
  if (!bridge) return { content: [text('The iPhone bridge is not set up on this Mac: kingmaker iphone build, then kingmaker iphone status.')], isError: true };
  try {
    let r;
    switch (name) {
      case 'phone-bridge-status': return { content: [text(await bridge.status())] };
      case 'see-phone-screen': {
        const s = await bridge.see();
        const content = [text(slim(s))];
        if (args.image !== false) { const p = await picture(s.image, run); if (p) content.push(p); }
        return { content };
      }
      case 'tap-phone': r = await bridge.tap(args); break;
      case 'type-on-phone': r = await bridge.type(args); break;
      case 'press-phone-button': r = await bridge.press(args); break;
      case 'swipe-phone': r = await bridge.swipe(args); break;
      case 'open-phone-app': r = await bridge.openApp(args); break;
      case 'call-from-phone': r = await bridge.placeCall(args); break;
      case 'send-imessage-to-contact': r = await bridge.sendMessage(args); break;
      default: return { content: [text(`unknown tool: ${name}`)], isError: true };
    }
    const { screen, ...rest } = r;
    return { content: [text({ ...rest, ...(screen ? { after: slim(screen) } : {}) })], ...(r.ok ? {} : { isError: true }) };
  } catch (error) {
    return { content: [text(`iPhone bridge: ${error?.message ?? error}`)], isError: true };
  }
}
