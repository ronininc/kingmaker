"""Kingmaker's real load on one machine: its role models resident together, turns alternating between them.
Usage: python3 -I bench_concurrent.py OUT.json model [model...]   (first model = the always-warm reflex)"""
import json, subprocess, sys, time, urllib.request

OUT, MODELS = sys.argv[1], sys.argv[2:]
HOST = "http://127.0.0.1:11434"


def post(body, timeout=600):
    req = urllib.request.Request(HOST + "/api/generate", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def swap_mb():
    s = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    return float(s.split("used = ")[1].split("M")[0])


def loaded():
    with urllib.request.urlopen(HOST + "/api/ps", timeout=10) as r:
        return [(m["name"], round(m["size"] / 1e9, 2), round(m.get("size_vram", 0) / 1e9, 2)) for m in json.loads(r.read())["models"]]


for m in MODELS:
    post({"model": m, "keep_alive": 0}, 60)
time.sleep(2)
swap0, turns = swap_mb(), []
prompts = ["Classify: 'book me for tuesday'. One word.", "Draft a two-sentence follow-up text to a customer who missed a call.",
           "What should I do first today: call a hot lead or answer email? One sentence.", "Write a JS function that sums an array. Code only."]
for rnd in range(2):
    for i, m in enumerate(MODELS):
        t0 = time.time()
        r = post({"model": m, "prompt": prompts[i % len(prompts)], "stream": False, "think": False, "keep_alive": "10m",
                  "options": {"num_predict": 120, "num_ctx": 4096, "temperature": 0}})
        turns.append({"round": rnd, "model": m, "wall_s": round(time.time() - t0, 2), "load_s": round(r.get("load_duration", 0) / 1e9, 2),
                      "gen_tok_s": round(r.get("eval_count", 0) / max(r.get("eval_duration", 1) / 1e9, 1e-9), 1)})
        print(json.dumps(turns[-1]), flush=True)
res = {"models": MODELS, "resident_after": loaded(), "swap_delta_mb": round(swap_mb() - swap0), "turns": turns}
print(json.dumps({k: res[k] for k in ("resident_after", "swap_delta_mb")}), flush=True)
json.dump(res, open(OUT, "w"), indent=1)
for m in MODELS:
    post({"model": m, "keep_alive": 0}, 60)
