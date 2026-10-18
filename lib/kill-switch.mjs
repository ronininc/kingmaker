// lib/kill-switch.mjs — "stop approving", said or typed: the words that halt every approval that runs without asking
// (the automaton's money actions, lib/automaton.mjs, and the Ronin add-on's delegated approvals). Pure.
export const STOP_APPROVING = /^\s*(?:(?:hey|ok|okay)\s+\w+[,\s]+)?(?:please\s+)?(?:(?:stop|pause|halt|freeze|kill|disable|suspend|cut)\s+(?:the\s+|all\s+|your\s+)?(?:auto[-\s]?)?(?:approv(?:ing|als?)|approver)|turn\s+(?:off\s+(?:the\s+|all\s+)?(?:auto[-\s]?)?approv(?:ing|als?)|(?:the\s+|all\s+)?(?:auto[-\s]?)?approv(?:ing|als?)\s+off)|no\s+more\s+(?:auto[-\s]?)?approv(?:ing|als?))(?:\s+(?:now|right\s+now|immediately))?(?:\s+please)?[.!]*\s*$/i;
export const isStopApproving = (text) => STOP_APPROVING.test(String(text ?? ''));
