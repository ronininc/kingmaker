# Method — Self-contained reasoning

A method file for a closed problem. The prompt supplies the facts, the rules, and the numbers, and asks for a plan, a total, or a decision. Nothing is looked up. The hunter-picked model runs the procedure once.

## Trigger

The owner pasted a self-contained problem (a score to maximize, a word problem, a syllogism) and asked for the plan or the answer.

## Steps

1. Quantify each option from the numbers in the prompt.
2. Compute each total.
3. Compare the totals.
4. Decide, and state the plan and the expected result.

## Executable block

```kingmaker-method
{
  "id": "self-contained-reasoning",
  "version": "1.0",
  "title": "Self-contained reasoning",
  "domain": "puzzle",
  "kind": "self-contained-reasoning",
  "inputs": {
    "prompt": ""
  },
  "steps": [
    {
      "n": 1,
      "id": "quantify",
      "type": "note",
      "text": "Quantify every option using only the numbers and rules in the prompt."
    },
    {
      "n": 2,
      "id": "compute",
      "type": "note",
      "text": "Compute a total for each option from those numbers."
    },
    {
      "n": 3,
      "id": "compare",
      "type": "note",
      "text": "Compare the totals."
    },
    {
      "n": 4,
      "id": "decide",
      "type": "reason",
      "into": "answer",
      "preamble": "Think step by step. Quantify the options. Compute each total from the numbers in the prompt. Compare the totals. Then answer with the plan and the result. Use only the facts in the prompt. Do not look anything up and do not use tools.",
      "prompt": "{{inputs.prompt}}"
    }
  ]
}
```
