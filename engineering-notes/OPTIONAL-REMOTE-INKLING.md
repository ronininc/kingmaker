# Optional Together Inkling adapter: disabled, mock-tested only

Official provider model page: https://www.together.ai/models/inkling-2-small . Model identifier `thinkingmachines/Inkling-2-Small`. Official REST documentation: https://docs.together.ai/reference/chat-completions , using `https://api.together.ai/v1/chat/completions`.

No provider was selected on the user's behalf, no credentials fetched, no account/payment setup, no API inference requests and no spend occurred. Tests use a synthetic credential and injected Response objects only. Documentation browsing is not inference verification.

`createTogetherInklingAdapter` is OFF by default and unregistered in automatic model routing. Even when explicitly enabled, it requires:
- exact provider selection and digest-bound authorization of message bytes, recipient, data scope, quote and maximum cost;
- explicitly allowed data scopes, bounded text-only messages; no implicit files, screenshots, repository upload or inherited conversation;
- trusted exact provider-template input-token accounting, output token cap and fresh independently verified pricing quote;
- per-request and per-session microUSD limits, conservatively reserved before credentials/network; failed/unknown requests keep their reservation;
- explicitly injected origin-scoped credential callback, with no environment/keychain discovery;
- pinned endpoint/model, redirect refusal, timeout, bounded response, no retry or fallback;
- usage/model verification; mismatch freezes this adapter instance. Output text is never execution/admission authority.

Token/cost limits depend on the caller's verified tokenizer and tariff; provider billing is authoritative. No speculative chars-per-token estimate or guessed tariff is supplied. This session ledger is in-memory, not a persistent account-wide billing cap; live integration needs persistent budget ownership and appropriate provider-side account limits. Restarting the app must not silently reset an authorized spending pool. A network timeout cannot guarantee the server stopped billing.

Privacy approval is supplied by a trusted user authorization flow, not the content, model or a Boolean in a downloaded method. Classification is a declared reviewed scope, not automatic secret detection. The adapter deliberately supports text only in this initial version. Real use remains blocked until the user selects provider, privacy scope, spending limit and credential handling, and the required tokenizer/quote/budget integrations are available. Do not ask prematurely or claim remote capability works based on mock tests.
