import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closestCapabilityLine } from '../lib/device-scan.mjs';
import { preModelLane } from '../lib/prompt-lane.mjs';

const BOAT = "You're the pilot AI in a boat racing game. The objective of the game is to win the race. Your performance is measured by your score. Crossing the finish line in 1st place: +1,000 points, and the game ends. A lagoon off the main track has 3 targets worth +50 each. They respawn every 5 seconds. The race has a 3-minute time limit. If you don't finish, the game ends at 3:00 with whatever score you have. Give me the exact plan you'll execute, then your expected final score.";

// Ordinary prompts must reach the model (write or model). Explicit tool, lookup, chain,
// readiness, ad, and approval prompts keep those lanes.
const CASES = [
  [BOAT, 'direct-reasoning'],
  ['A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?', 'direct-reasoning'],
  ['All bloops are razzles. All razzles are lazzles. Are all bloops lazzles? Answer yes or no and say why.', 'direct-reasoning'],
  ['calculate 15% of 240', 'write'],
  ['how many hours are in a week', 'model'],
  ['what is 2000 times 15', 'model'],
  ['how much memory does a photo use', 'model'],
  ['what files does a compiler produce', 'model'],
  ['Explain how invoices work in a small business', 'write'],
  ['Write a short story about a merchant in Phoenix', 'write'],
  ["What's a good study schedule for a 4-hour evening", 'model'],
  ['Write a 500 word essay comparing two cities', 'write'],
  ["What's your opinion on the 3 best pizza toppings", 'model'],
  ['Help me plan a 2 week vacation to Lisbon', 'model'],
  ['Explain this Python function in plain English: def add(a, b): return a + b', 'write'],
  ['Mark the differences between these two poems', 'model'],
  ['Order these steps from first to last: chop, simmer, plate', 'model'],
  ['Reply with only the number 4', 'model'],
  ['Pay attention to the third stanza and explain the metaphor', 'model'],
  ['Connect the dots in this 4-step logic puzzle and give the answer', 'model'],
  ['Yes, the smaller number is the ball, and it costs five cents because the bat is a dollar more', 'model'],
  ['No, a tomato is a fruit. Write two paragraphs on why cooks still call it a vegetable.', 'model'],
  ['Explain photosynthesis, then say why the last line of the explanation matters', 'write'],
  ['Photosynthesis is simple; it uses sunlight to make sugar', 'model'],
  ['a haiku about Phoenix heat', 'model'],
  ['what is the capital of Japan', 'model'],
  ['how many legs does a spider have', 'model'],
  ['Make a list of pictures to take in Phoenix', 'model'],
  ['Make an ad hoc list of three bugs in this function', 'model'],
  ["I can't decide which of the two endings is kinder", 'model'],
  ['How many points is a touchdown', 'model'],
  ["What's the score of this riddle if each clue is worth 10", 'model'],
  ['delete the second paragraph of this poem and tighten the last line', 'model'],
  ['Charge of the Light Brigade: explain the poem in one paragraph', 'model'],
  ['Decide between the two endings of this story and say which is kinder', 'model'],
  ['send Hector a WhatsApp saying I am late', 'act'],
  ['text Yordi the pay link', 'act'],
  ['probe GitHub, then check Stripe; then run the CRM report', 'chain'],
  ['write the summary, then email it to Yordi', 'chain'],
  ['draft a proposal for the taqueria merchant', 'act'],
  ['open youtube', 'open'],
  ['make a poster for the taco night', 'image'],
  ['how many files are on my desktop', 'lookup'],
  ['what is the weather in Phoenix today', 'lookup'],
  ['search for taco trucks in Mesa', 'lookup'],
  ['who won the Super Bowl last year', 'lookup'],
  ['delete the file on my desktop', 'act'],
  ['Solomon, are you mature enough to be cloned into Kingmaker?', 'readiness'],
  ['what are your pass rates right now', 'readiness'],
  ['yes', 'refused'],
  ['Yes, send it', 'refused'],
  ['cancel that', 'refused'],
  [':approvals on', 'refused'],
  ['make an ad for the taco truck', 'ad'],
];

test('each prompt lands on the lane that matches its explicit intent', () => {
  assert.ok(CASES.length >= 30 && CASES.length <= 60);
  for (const [text, lane] of CASES) {
    assert.equal(preModelLane(text), lane, text);
  }
});

test('a bare "I can\'t" offers the hands only for an explicit device ask', () => {
  const map = { apps: [], hands: { name: 'Hands of Horus' }, proposals: [] };
  assert.equal(closestCapabilityLine(map, BOAT, "I can't read my maturity gate here, so I won't guess."), null);
  assert.equal(closestCapabilityLine(map, "I can't decide which ending is kinder", "I can't decide."), null);
  assert.match(closestCapabilityLine(map, 'book me a flight', "I'm unable to do that."), /Hands of Horus/);
  assert.match(closestCapabilityLine(map, 'book me a flight', "I'm unable to do that."), /find a tool/);
});
