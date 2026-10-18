"""Per-model file lists for programs missing from the hosted dump. Resumable.
Usage: python3 -I files_hb.py OUTDIR   (reads OUTDIR/programs.json + hosted_files.jsonl, appends OUTDIR/files_by_artifact.jsonl)"""
import json, os, sys, threading, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

OUT = sys.argv[1]
UA = {"User-Agent": "kingmaker-catalog/1.0 (metadata only)", "Accept": "application/json"}
groups = json.load(open(f"{OUT}/programs.json"))["groups"]
have = {json.loads(l)["artifactId"] for l in open(f"{OUT}/hosted_files.jsonl") if l.strip()}
done_path = f"{OUT}/files_by_artifact.jsonl"
if os.path.exists(done_path):
    have |= {json.loads(l)["artifactId"] for l in open(done_path) if l.strip()}
pri = {g["artifactId"]: (not ("gguf" in g.get("formats", [])), not g.get("uncensored"), g["artifactId"]) for g in groups}
todo = sorted({g["artifactId"] for g in groups} - have, key=pri.get)
print(f"todo {len(todo)}", flush=True)
lock, pace, last = threading.Lock(), 0.33, [0.0]  # global spacing: <=10 req/s, half the published limit
out = open(done_path, "a")
count = [0]


def fetch(aid):
    url = "https://huggingbay.xyz/api/downloadable-files?" + urllib.parse.urlencode({"artifactId": aid, "limit": 100})
    for i in range(6):
        with lock:
            wait = last[0] + pace - time.time()
            if wait > 0:
                time.sleep(wait)
            last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                rem = int(r.headers.get("RateLimit-Remaining") or 999)
                d = json.loads(r.read())
            if rem < 100:
                time.sleep(15)
            rows = [{k: x.get(k) for k in ("filePath", "format", "sizeBytes", "sha256", "downloadUrl", "hosted", "serveDecision", "license", "sourceKind")} for x in d.get("rows", [])]
            with lock:
                out.write(json.dumps({"artifactId": aid, "rows": rows}) + "\n")
                out.flush()
                count[0] += 1
                if count[0] % 500 == 0:
                    out.flush()
                    print(f"{count[0]}/{len(todo)}", flush=True)
            return
        except urllib.error.HTTPError as e:
            time.sleep(int(e.headers.get("Retry-After") or 10 * (i + 1)))
        except Exception:
            time.sleep(5 * (i + 1))
    with lock:
        out.write(json.dumps({"artifactId": aid, "rows": None, "error": "failed"}) + "\n")


with ThreadPoolExecutor(2) as ex:
    list(ex.map(fetch, todo))
out.close()
print("files done", flush=True)
