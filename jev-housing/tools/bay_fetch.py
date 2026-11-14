#!/usr/bin/env python3
"""Bay fetch with signed-URL mint + Range resume + sha256 pin verification.
Usage: bay_fetch.py <manifest.json> <artifact-id> <dest-dir> [path ...]
Without path args, fetches every file in the manifest."""
import hashlib, json, os, sys, time
import urllib.request, urllib.error

def mint(url):
    req = urllib.request.Request(url, method="GET")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    op = urllib.request.build_opener(NoRedirect)
    last = None
    for attempt in range(8):
        try:
            with op.open(req, timeout=60) as r:
                return r.headers.get("Location")
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location")
            if loc:
                return loc
            last = e
        except Exception as e:
            last = e
        time.sleep(1 + attempt)
    raise last

def fetch_one(base, path, dest, want_size, want_sha):
    url = base + path
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    if have == want_size and want_size > 0:
        pass  # fall through to verify
    else:
        loc = None
        tries = 0
        while have < want_size:
            tries += 1
            if tries > 200:
                raise RuntimeError(f"too many resume rounds for {path}")
            if loc is None:
                loc = mint(url)
            req = urllib.request.Request(loc)
            if have:
                req.add_header("Range", f"bytes={have}-")
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    mode = "ab" if (have and r.status == 206) else "wb"
                    if mode == "wb":
                        have = 0
                    with open(dest, mode) as f:
                        while True:
                            chunk = r.read(1 << 20)
                            if not chunk:
                                break
                            f.write(chunk)
                            have += len(chunk)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):  # signed URL expired; re-mint
                    loc = None
                    have = os.path.getsize(dest) if os.path.exists(dest) else 0
                    continue
                raise
            except Exception:
                loc = None
                have = os.path.getsize(dest) if os.path.exists(dest) else 0
                time.sleep(1)
                continue
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    got = h.hexdigest()
    ok = (got == want_sha) and (os.path.getsize(dest) == want_size)
    print(("OK      " if ok else "MISMATCH") + f" {path} size={os.path.getsize(dest)} sha256={got[:16]}…", flush=True)
    return ok

def main():
    man_path, art_id, dest_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    only = sys.argv[4:]
    man = json.load(open(man_path))
    base = f"https://huggingbay.xyz/api/downloads/{art_id}/"
    ok_all = True
    for f in man["files"]:
        p = f["path"]
        if only and p not in only:
            continue
        dest = os.path.join(dest_dir, p)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        ok_all &= fetch_one(base, p, dest, f["size"], f["sha256"])
    print("ALL PINS MATCH" if ok_all else "PIN FAILURES PRESENT", flush=True)
    sys.exit(0 if ok_all else 1)

if __name__ == "__main__":
    main()
