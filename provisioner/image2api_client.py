from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request


BASE_URL = os.getenv("IMAGE2API_BASE", "http://127.0.0.1:2000").rstrip("/")
ADMIN_ID = os.getenv("IMAGE2API_ADMIN", "admin")
ADMIN_PASSWORD = os.getenv("IMAGE2API_ADMIN_PW", "")

_token = ""
_lock = threading.Lock()
_metrics_cache: tuple[float, tuple[int, int]] | None = None


def _request(method: str, path: str, body: dict | None = None, retry: bool = True) -> dict:
    global _token
    with _lock:
        if not _token:
            _token = _login()
        token = _token
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        BASE_URL + path,
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403) and retry:
            with _lock:
                _token = ""
            return _request(method, path, body, retry=False)
        detail = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(f"image2api HTTP {exc.code}: {detail}") from exc


def _login() -> str:
    if not ADMIN_PASSWORD:
        raise RuntimeError("IMAGE2API_ADMIN_PW is required")
    request = urllib.request.Request(
        BASE_URL + "/admin/api/auth/login",
        data=json.dumps({"identifier": ADMIN_ID, "password": ADMIN_PASSWORD}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        token = str(json.loads(response.read().decode() or "{}").get("token") or "")
    if not token:
        raise RuntimeError("image2api login returned no token")
    return token


def import_chatgpt_token(access_token: str, email: str) -> None:
    _request(
        "POST",
        "/admin/api/tokens/import-chatgpt-token",
        {"access_token": access_token, "name": email},
    )


def active_metrics() -> tuple[int, int] | None:
    global _metrics_cache
    now = time.time()
    if _metrics_cache and now - _metrics_cache[0] < 15:
        return _metrics_cache[1]
    try:
        accounts = _request("GET", "/admin/api/accounts").get("data") or []
    except Exception:
        return _metrics_cache[1] if _metrics_cache else None
    usable = [
        account
        for account in accounts
        if account.get("pool") == "chatgpt"
        and not account.get("dead")
        and not account.get("image_limited")
        and int(account.get("remaining") or 0) > 0
    ]
    metrics = len(usable), sum(int(account.get("remaining") or 0) for account in usable)
    _metrics_cache = now, metrics
    return metrics
