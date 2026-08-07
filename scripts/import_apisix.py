#!/usr/bin/env python3
"""Import an APISIX standalone yaml into a RUNNING APISIX via Admin API.

APISIX traditional mode (etcd) has no "upload yaml" endpoint - only per-resource
REST endpoints. This script reads apisix.dev.yaml / apisix.yaml (the standalone
configs) and PUTs each upstream/route/consumer to the Admin API, so a running
APISIX absorbs the file's contents without restart or mode switch.

By default it first DELETEs all existing routes/upstreams/consumers, then PUTs
the yaml contents - so the running config ends up exactly matching the file.
Idempotent: safe to re-run after editing the yaml.

Usage:
    python scripts/import_apisix.py apisix/apisix.dev.yaml
    python scripts/import_apisix.py apisix/apisix.dev.yaml --host 192.168.138.128 --key admin-key-change-me
    python scripts/import_apisix.py apisix/apisix.dev.yaml --keep   # upsert only, no delete

Requires: pyyaml  ->  python -m pip install pyyaml
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

import yaml


def admin_call(method: str, url: str, key: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def list_ids(base: str, kind: str, key: str) -> list[str]:
    st, data = admin_call("GET", f"{base}/apisix/admin/{kind}", key)
    if st != 200:
        print(f"  list {kind} failed: {st} {data}")
        return []
    ids = []
    for item in data.get("list", []):
        # item["key"] looks like "/apisix/routes/123" or "/apisix/consumers/internal"
        rid = item.get("key", "").rstrip("/").split("/")[-1]
        if rid:
            ids.append(rid)
    return ids


def delete_all(base: str, key: str) -> None:
    # order matters: routes reference upstreams; delete routes first
    for kind in ("routes", "upstreams", "consumers"):
        for rid in list_ids(base, kind, key):
            st, _ = admin_call("DELETE", f"{base}/apisix/admin/{kind}/{rid}", key)
            print(f"  delete {kind}/{rid}: {st}")


def upsert(base: str, kind: str, rid: str, body: dict, key: str) -> bool:
    st, data = admin_call("PUT", f"{base}/apisix/admin/{kind}/{rid}", key, body)
    ok = st in (200, 201)
    detail = "" if ok else f" {data}"
    print(f"  {kind}/{rid}: {st}{detail}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("yaml", help="path to apisix.dev.yaml / apisix.yaml")
    ap.add_argument("--host", default="192.168.138.128", help="APISIX admin host (default VM)")
    ap.add_argument("--port", default=9180, type=int)
    ap.add_argument("--key", default="admin-key-change-me", help="admin X-API-KEY")
    ap.add_argument("--keep", action="store_true", help="upsert only, do not delete existing")
    args = ap.parse_args()

    base = f"http://{args.host}:{args.port}"
    with open(args.yaml, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    if not args.keep:
        print("== Deleting existing routes/upstreams/consumers ==")
        delete_all(base, args.key)
    else:
        print("== --keep: upsert only, no delete ==")

    ok = fail = 0
    print("== Importing upstreams ==")
    for u in cfg.get("upstreams", []):
        uid = u["id"]
        body = {k: v for k, v in u.items() if k != "id"}
        if upsert(base, "upstreams", uid, body, args.key):
            ok += 1
        else:
            fail += 1

    print("== Importing routes ==")
    for r in cfg.get("routes", []):
        rid = r["id"]
        body = {k: v for k, v in r.items() if k != "id"}
        if upsert(base, "routes", rid, body, args.key):
            ok += 1
        else:
            fail += 1

    print("== Importing consumers ==")
    for c in cfg.get("consumers", []):
        uname = c["username"]
        body = c  # consumer body must include username (it is the primary key)
        if upsert(base, "consumers", uname, body, args.key):
            ok += 1
        else:
            fail += 1

    print(f"\nDone: {ok} ok, {fail} fail")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
