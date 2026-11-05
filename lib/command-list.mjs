// lib/command-list.mjs — THE COMMAND LIST: every preset shortcut key, every bar and console command, and the phrases that
// turn a tool on, in one place. The README's "Command list" section is rendered from it (a test keeps them the same), and
// the bar's controller icon (bottom row) opens it as the command library: a glassy panel with a search bar (@@ghost {"commands": …}, sent once at launch). Add a command here and
// both follow. Only what the code really answers belongs here: each phrase is the wording its module matches.
//
// An entry: { keys, does } for a shortcut (`key` + `mods` when the Mac can draw it as a menu shortcut: the menu then shows
// it the native way, right-aligned), or { say, does } for something typed or said (`fill` when choosing it in the menu
// should put it in the box, ready to finish and send; nothing is ever sent from the menu itself).

import { ronin } from './addons.mjs';

export const COMMAND_GROUPS = Object.freeze([
  { title: 'Shortcut keys', icon: 'keyboard', items: [
    { keys: '⌥Space', key: 'space', mods: ['option'], does: 'Open the bar from anywhere (Customize → Shortcut: ⌃Space, ⇧⌘K or none)' },
    { keys: 'Hold fn', does: 'Talk to Kingmaker while it\'s held; let go and it\'s one command (Customize → Hold to talk)' },
    { keys: '↵', key: 'return', mods: [], does: 'Send' },
    { keys: '⌘↵', key: 'return', mods: ['command'], does: 'Queue it for after the current answer' },
    { keys: '⌥-click the mic', does: 'Talk to Kingmaker (a plain click dictates into the box)' },
    { keys: 'Tab', key: 'tab', mods: [], does: 'Take the suggested next command, or the highlighted pick' },
    { keys: '↑ ↓', does: 'Move through the picks under the box' },
    { keys: 'Esc', key: 'escape', mods: [], does: 'Close the picks; again to hide the bar' },
    { keys: '⌘M', key: 'm', mods: ['command'], does: 'Minimize the bar (⌘W too); Kingmaker keeps running' },
    { keys: '⌘V', key: 'v', mods: ['command'], does: 'Paste: copied files, images, video and audio attach to the message' },
    { keys: '⌘Z', key: 'z', mods: ['command'], does: 'Undo (⇧⌘Z redo)' },
    { keys: '⌘X ⌘C ⌘A', does: 'Cut, copy, select all' },
    { keys: '↵ / Esc on a card', does: 'Answer the card in the bar (↵ takes its highlighted button) when you\'re in the bar and not typing' },
    { keys: '⌘S', key: 's', mods: ['command'], does: 'Save in Customize → How should Kingmaker behave?' },
  ] },
  { title: 'In the bar', icon: 'text.cursor', items: [
    { say: '/off', icon: 'power', fill: '/off', does: 'A real off: no listening, no wake word, until /on' },
    { say: '/on', icon: 'power', fill: '/on', does: 'Turn it back on' },
    { say: '/mute', icon: 'speaker.slash', fill: '/mute', does: 'No voice: answers here as text' },
    { say: '/unmute', icon: 'speaker.wave.2', fill: '/unmute', does: 'Speak again' },
    { say: '/folder', icon: 'folder', fill: '/folder', does: 'Choose the folder Kingmaker works in' },
    { say: '/clear', icon: 'square.and.pencil', fill: '/clear', does: 'A new conversation (/new too)' },
    { say: '/connectors', icon: 'puzzlepiece', fill: '/connectors', does: 'Connectors & keys (/keys, /settings, /connections)' },
    { say: '/behave', icon: 'slider.horizontal.3', fill: '/behave', does: 'How Kingmaker should behave, and its guardrails (/instructions, /guardrails)' },
    { say: '/<program> …', fill: '/', does: 'Drive that program with the rest of the words (type / for the list)' },
    { say: '@name', icon: 'paperclip', fill: '@', does: 'Attach a file from this Mac' },
  ] },
  { title: 'Typed commands (console, or the bar)', icon: 'terminal', items: [
    { say: ':key <provider>', icon: 'key', does: 'Put an API key in the vault (console only)' },
    { say: ':key import · :key setup', does: 'The keys the scan found · free keys still missing (console only)' },
    { say: ':craft <app> …', does: 'Run an ArtCraft app (console only)' },
    { say: ':tools · :scan', does: 'What it can drive · rescan this Mac (console only)' },
    { say: ':pending · y · n', does: 'What\'s waiting · approve it · cancel it (console only)' },
    { say: ':help · :quit', does: 'The console\'s help · stop Kingmaker (console only)' },
  ] },
  { title: 'Say or type to turn a tool on', icon: 'waveform', items: [
    { say: 'open youtube · open Photos · open gmail', icon: 'arrow.up.forward.app', fill: 'open ', does: 'Open an app or site' },
    { say: 'how many files on my desktop', icon: 'number', fill: 'how many files on my desktop', does: 'Count files' },
    { say: 'whatsapp Ana saying on my way', icon: 'message', fill: 'whatsapp ', does: 'WhatsApp someone from Contacts: it opens ready, you press Send' },
    { say: 'make a poster for …', icon: 'photo', fill: 'make a poster for ', does: 'Draw a picture on this Mac (about 90 s); it shows in the chat' },
    { say: 'make an ad about …', icon: 'film', fill: 'make an ad about ', does: 'Make an ad video on this Mac' },
    { say: 'write … · draft … · research …', icon: 'doc.text', fill: 'write ', does: 'Written work or research, by the local writer' },
    { say: 'build …', icon: 'hammer', fill: 'build ', does: 'Build a tool, tracker, dashboard or small site: the engine reads the plan back and builds it on your yes' },
    { say: 'research …', icon: 'magnifyingglass', fill: 'research ', does: 'Research a question on the open internet, governed (online mode + consent); answers grounded or says it is not' },
    { say: 'merchant clover dry-run …', icon: 'cart', fill: 'merchant clover dry-run ', does: 'Dry-run a Clover menu change (proposes the diff, changes nothing); applying is the owner\'s word at the console' },
    { say: 'fabricate …', icon: 'cube', fill: 'fabricate ', does: 'Plan a part with the engine (CAD): planning only, it proposes a plan and never runs a machine' },
    { say: 'twin list · twin show …', icon: 'square.stack.3d.up', fill: 'twin list', does: 'Project Twins: list, show, back-burner, export; reviewing a task is your word at the console' },
    { say: 'connect my CRM', icon: 'person.2', fill: 'connect my CRM', does: 'Dock the CRM (the key goes through the hidden field into the vault)' },
    { say: 'connect my GitHub key', icon: 'key', fill: 'connect my GitHub key', does: 'Any provider\'s key into the vault' },
    { say: 'scan my Mac', icon: 'magnifyingglass', fill: 'scan my Mac', does: 'Rescan what it can drive (read-only)' },
    { say: 'what can you drive', icon: 'wrench.and.screwdriver', fill: 'what can you drive', does: 'Its tools and the proposals' },
    { say: 'find tools for my apps', icon: 'shippingbox', fill: 'find tools for my apps', does: 'Your OK to look online for open-source tools' },
    { say: 'install <tool>', icon: 'arrow.down.app', fill: 'install ', does: 'Acquire a tool: studied in quarantine, rebuilt, and only run on your yes' },
    { say: 'put my keys in the vault', icon: 'lock', fill: 'put my keys in the vault', does: 'The keys the scan found, into the vault on your yes' },
    { say: 'set up my keys · get me a Groq key', icon: 'key.horizontal', fill: 'set up my keys', does: 'The free API keys it still needs' },
    { say: 'learning on · learning off', icon: 'brain', fill: 'learning ', does: 'Learn your preferences from what you say' },
    { say: 'keep that · drop that', fill: 'keep that', does: 'Keep or drop what it just offered to learn' },
    { say: 'what have you learned about me', fill: 'what have you learned about me', does: 'What it has learned about you' },
    { say: 'forget what you learned about …', fill: 'forget what you learned about ', does: 'Forget it' },
    { say: 'where did you learn …', fill: 'where did you learn ', does: 'Where a preference came from' },
    { say: 'sharing on · sharing off', fill: 'sharing ', does: 'Community learning (kept preferences only)' },
    { say: 'new conversation', icon: 'bubble.left.and.bubble.right', fill: 'new conversation', does: 'A fresh Claude/ChatGPT conversation; what it learned stays' },
    { say: 'stop approving', icon: 'hand.raised', fill: 'stop approving', does: 'Kill switch: everything that approves without asking stops, at once' },
  ] },
]);

/** The core groups with an add-on's items appended to the group they belong in (by title). The README lists the core only. */
export function withAddons(groups, extra = ronin?.COMMAND_ITEMS ?? {}) {
  return groups.map((g) => (extra[g.title] ? { ...g, items: [...g.items, ...extra[g.title]] } : g));
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
/** The README's section (between its BEGIN/END command-list markers). */
export function commandListMarkdown(groups = COMMAND_GROUPS) {
  const out = ['## Command list', '', 'Every preset shortcut key, every bar and console command, and the words that turn a tool on. The bar shows the same list as its command library: click the small controller icon in its bottom row (🎮, beside Voice) for a glassy panel with every category side by side and a search bar on top (type what you want to do, e.g. *poster*, *approve*, *keys*). Choosing an entry puts it in the box, ready to finish and send.'];
  for (const g of groups) {
    out.push('', `### ${g.title}`, '', `| ${g.items[0].keys ? 'Keys' : 'Say or type'} | What it does |`, '|---|---|');
    for (const i of g.items) out.push(`| ${i.keys ? cell(i.keys) : `\`${cell(i.say)}\``} | ${cell(i.does)} |`);
  }
  return out.join('\n');
}

/** The bar's menu: the same groups plus an add-on's own (the Ronin add-on's console switches and phrases), as plain JSON. */
export function commandMenu(groups = withAddons(COMMAND_GROUPS)) {
  return groups.map((g) => ({ title: g.title, icon: g.icon, items: g.items.map((i) => ({
    title: i.keys ? i.does : i.say, detail: i.keys ? i.keys : i.does, kind: i.keys ? 'keys' : 'say', icon: i.icon ?? g.icon,
    ...(i.key ? { key: i.key, mods: i.mods } : {}), ...(i.fill ? { fill: i.fill } : {}),
  })) }));
}
