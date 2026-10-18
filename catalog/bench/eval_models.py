"""Tiny auto-graded accuracy check. Usage: python3 -I eval_models.py OUT.jsonl model [model...]"""
import json, re, sys, urllib.request

OUT, MODELS = sys.argv[1], sys.argv[2:]
HOST = "http://127.0.0.1:11434"


def ask(model, prompt):
    body = {"model": model, "prompt": prompt, "stream": False, "think": False,
            "options": {"num_predict": 300, "num_ctx": 4096, "temperature": 0}}
    req = urllib.request.Request(HOST + "/api/generate", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return re.sub(r"<think>.*?</think>", "", json.loads(r.read()).get("response", ""), flags=re.S).strip()


def grade_code(out):
    m = re.search(r"```(?:python)?\n(.*?)```", out, re.S)
    src = m.group(1) if m else out
    ns = {}
    try:
        exec(src, ns)  # local model output, run in a throwaway process; tiny pure function
        f = ns["is_valid_email"]
        cases = {"a@b.co": True, "john.doe+x@mail.example.com": True, "nope": False, "a@b": False, "@b.com": False, "a b@c.com": False}
        return all(bool(f(k)) == v for k, v in cases.items())
    except Exception:
        return False


def grade_json(out):
    m = re.search(r"\{.*\}", out, re.S)
    try:
        d = {k.lower(): str(v).lower() for k, v in json.loads(m.group(0)).items()}
        return "maria lopez" in d.get("name", "") and "mesa" in d.get("city", "")
    except Exception:
        return False


TASKS = [
    ("math", "What is 17*23? Answer with just the number.", lambda o: re.sub(r"[^\d]", "", o) == "391"),
    ("days", "Today is Monday. What day of the week is it 10 days from today? Answer with one word.", lambda o: "thursday" in o.lower() and len(o) < 40),
    ("intent", "Customer text: 'I can't make it tomorrow, can we move it to Friday?'. Intent, one of: book, cancel, reschedule, question. Answer with one word.", lambda o: o.lower().strip(" .") == "reschedule"),
    ("exact", "Reply with exactly the word READY and nothing else.", lambda o: o.strip(" .\"'") == "READY"),
    ("json", "Extract the person's name and city as JSON with keys name and city, nothing else: 'Maria Lopez moved from Tucson and now lives in Mesa.'", grade_json),
    ("code", "Write a Python function is_valid_email(s) that returns True only for addresses like user@domain.tld (no spaces, a non-empty user part, a dot in the domain). Code only, standard library only.", grade_code),
    ("units", "A shop sells 3 boxes at $4.50 each and gives a $2 discount on the total. What is the final price in dollars? Answer with just the number.", lambda o: re.search(r"11\.5", o) is not None),
    ("refuse-check", "Summarize in one sentence: 'The meeting moved from 2pm to 4pm because the client was late.'", lambda o: "4" in o and len(o) < 300),
]

with open(OUT, "a") as f:
    for model in MODELS:
        score, rows = 0, []
        for name, prompt, check in TASKS:
            try:
                out = ask(model, prompt)
                ok = bool(check(out))
            except Exception as e:
                out, ok = f"ERROR {e}", False
            score += ok
            rows.append({"task": name, "ok": ok, "out": out[:200]})
        rec = {"model": model, "score": score, "of": len(TASKS), "tasks": rows}
        f.write(json.dumps(rec) + "\n")
        print(model, f"{score}/{len(TASKS)}", " ".join(f"{r['task']}:{'✓' if r['ok'] else '✗'}" for r in rows), flush=True)
        urllib.request.urlopen(urllib.request.Request(HOST + "/api/generate", json.dumps({"model": model, "keep_alive": 0}).encode(), {"Content-Type": "application/json"}), timeout=60).read()
