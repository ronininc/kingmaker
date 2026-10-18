"""Scrape HuggingBay metadata (no weights). Usage: python3 -I scrape_hb.py OUTDIR"""
import json, re, sys, time, urllib.request, urllib.parse

OUT = sys.argv[1]
BASE = "https://huggingbay.xyz"
UA = {"User-Agent": "kingmaker-catalog/1.0 (metadata only)", "Accept": "application/json"}


def get(url, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8"), ", ".join(r.headers.get_all("Link") or [])
        except Exception as e:
            wait = 5 * (i + 1)
            print(f"retry {i+1} {url[:120]} {e}; sleep {wait}", flush=True)
            time.sleep(wait)
    raise SystemExit(f"failed: {url}")


def programs():
    cursor, n, out = "", 0, []
    while True:
        q = {"limit": 60, "sort": "popular"}
        if cursor:
            q["cursor"] = cursor
        body, _ = get(f"{BASE}/api/downloadable-programs?" + urllib.parse.urlencode(q))
        d = json.loads(body)
        out.extend(d.get("groups", []))
        n += 1
        cursor = d["page"].get("nextCursor")
        if n % 20 == 0:
            print(f"programs page {n}: {len(out)}/{d['page'].get('total')}", flush=True)
        if not cursor or not d.get("groups"):
            return out, d["page"].get("total")
        time.sleep(0.4)


def hosted_files():
    url, n = f"{BASE}/api/dumps/hosted-files.jsonl?limit=1000", 0
    with open(f"{OUT}/hosted_files.jsonl", "w") as f:
        while url:
            body, headers = get(url)
            f.write(body if body.endswith("\n") else body + "\n")
            n += 1
            link = headers
            m = re.search(r'<([^>]+)>;\s*rel="next"', link)
            url = m.group(1) if m else None
            if n % 10 == 0:
                print(f"hosted page {n}", flush=True)
            time.sleep(0.4)
    return n


if __name__ == "__main__":
    if "--hosted-only" not in sys.argv:
        groups, total = programs()
        json.dump({"total": total, "groups": groups}, open(f"{OUT}/programs.json", "w"))
        print(f"programs done: {len(groups)} (site total {total})", flush=True)
    pages = hosted_files()
    print(f"hosted done: {pages} pages", flush=True)
