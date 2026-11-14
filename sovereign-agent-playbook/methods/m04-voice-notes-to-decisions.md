---
id: m04-voice-notes-to-decisions
name: Voice Notes to Decisions
source: Angus public post 2026-08-11 (2,609 voice notes into a decision aid)
trigger: owner voice memo lands / decision question asked
inputs: owner voice memos (transcribed locally), the decision log
tools_local: local transcription (whisper-class), local model, decision log file
approval_gates: none to transcribe/summarise; a decision is recorded only when the owner states it
outputs: searchable decision memory; answers cite the memo + date they rest on
---
Steps:
1. Transcribe memos locally; index by date, people, projects.
2. On a decision question, retrieve the owner's own past statements on it before answering.
3. Conflicts surface explicitly (old position vs new), never silently overwritten.
Stoppers: none. Owner's memos only; no third-party recordings.
