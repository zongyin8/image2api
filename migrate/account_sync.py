#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ChatGPT 号池 -> image2api 账号管理 同步(备用上游)。
读 /opt/gpt/data/accounts.json 里的有效号,把 access_token 幂等导入 image2api
(image2api 按 (pool,email) 去重:新邮箱=新增,同邮箱token变化=刷新)。
只推送 status=正常 且有 access_token 的号;用本地 state 避免重复推送未变化的号。
独立进程,只调 image2api 的 admin API,不触碰其内部,保证新版稳定。
"""
import json, os, time, hashlib, urllib.request, urllib.error

ACCOUNTS = os.getenv("ACCOUNTS_JSON", "/opt/gpt/data/accounts.json")
STATE    = os.getenv("SYNC_STATE", "/opt/image2api-g2a/account-sync-state.json")
BASE     = os.getenv("IMAGE2API_BASE", "http://127.0.0.1:2000").rstrip("/")
ADMIN_ID = os.getenv("IMAGE2API_ADMIN", "admin")
ADMIN_PW = os.getenv("IMAGE2API_ADMIN_PW", "").strip()
INTERVAL = int(os.getenv("SYNC_INTERVAL", "60"))

_token = {"v": ""}


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def _req(path, data=None, tok=None):
    h = {"Content-Type": "application/json"}
    if tok:
        h["Authorization"] = "Bearer " + tok
    r = urllib.request.Request(BASE + path,
                               data=json.dumps(data).encode() if data is not None else None,
                               headers=h, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(r, timeout=15) as resp:
        return resp.status, json.loads(resp.read().decode() or "{}")


def login():
    _, r = _req("/admin/api/auth/login", {"identifier": ADMIN_ID, "password": ADMIN_PW})
    _token["v"] = r.get("token") or ""
    if not _token["v"]:
        raise RuntimeError("image2api 登录未返回 token")
    return _token["v"]


def push(access_token, email):
    body = {"access_token": access_token, "name": email}
    for attempt in range(2):
        tok = _token["v"] or login()
        try:
            _req("/admin/api/tokens/import-chatgpt-token", body, tok)
            return True
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and attempt == 0:
                _token["v"] = ""
                continue
            log(f"导入失败 {email}: HTTP {e.code} {e.read().decode()[:120]}")
            return False


def load_json(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def sync_once():
    accounts = load_json(ACCOUNTS, [])
    if not isinstance(accounts, list):
        return
    state = load_json(STATE, {})
    changed = 0
    seen = set()
    for a in accounts:
        if not isinstance(a, dict):
            continue
        at = str(a.get("access_token") or "").strip()
        email = str(a.get("email") or "").strip()
        status = str(a.get("status") or "").strip()
        if not at or not email or status not in ("正常", "active", ""):
            continue
        seen.add(email)
        sig = hashlib.sha256(at.encode()).hexdigest()[:16]
        if state.get(email) == sig:
            continue  # 未变化,跳过
        if push(at, email):
            state[email] = sig
            changed += 1
    if changed:
        json.dump(state, open(STATE, "w", encoding="utf-8"))
        log(f"同步完成:推送/刷新 {changed} 个号(有效号 {len(seen)})")


def main():
    if not ADMIN_PW:
        raise RuntimeError("IMAGE2API_ADMIN_PW is required")
    log(f"account_sync 启动 base={BASE} interval={INTERVAL}s src={ACCOUNTS}")
    while True:
        try:
            sync_once()
        except Exception as e:
            log(f"同步异常: {e}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
