// lib/kingmaker-facts.mjs — what Kingmaker is, for work about Kingmaker itself (2026-10-15: "make an ad about Kingmaker"
// came back as "Kingmaker is the unseen hand that guides commerce": the writer was never told what Kingmaker is).
// A job opened from the bar about Kingmaker carries these facts (the open_job `detail`). Only what Kingmaker does today:
// no prices, no claims it can't back.

export const KINGMAKER_FACTS = `What Kingmaker is (facts to use; don't add features or prices that aren't here):
- AI that runs on your own Mac. Download Kingmaker, click, and it sets itself up: no accounts, no command line, no technical setup.
- It thinks with open AI models that run on the Mac itself. No cloud AI is needed: what you type, say and share stays on your Mac, and there are no per-message AI fees.
- It picks good open models for your Mac (by benchmark, including uncensored ones), downloads them itself and checks each file before using it.
- A black bar on your desktop: type into it, or hold the fn key and talk. It answers in green text and speaks back in its own natural voice.
- It does things, not just chat: opens apps and websites, finds and attaches files, drafts messages (you press Send), researches the web with sources, makes pictures, and can record its own screen.
- Connectors: it plugs into the apps and services you use. Keys are pasted once into a hidden field, kept in the Mac's own vault, and rotated for you.
- You stay in charge: anything that sends a message, moves money or changes your records waits for your OK.
- When you step away it can keep working in the background, quietly, with the microphone off.
- Source-available: anyone can read the code.
Why someone would choose it over cloud AI: privacy (it runs on your own Mac), no usage fees for the AI, no setup skills needed, it works your actual apps rather than only chatting, and you can read the code.`;

/** Pure: the facts a job needs, from its words: Kingmaker's own sheet when the work is about Kingmaker, else ''. */
export function factsFor(request) {
  return /\bking\s?maker\b/i.test(String(request || '')) ? KINGMAKER_FACTS : '';
}
