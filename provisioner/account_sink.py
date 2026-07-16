from __future__ import annotations

import json
import threading
from datetime import datetime, timezone

from .image2api_client import import_chatgpt_token
from .storage import DATA_DIR


STORE_FILE = DATA_DIR / "registered_accounts.json"
_lock = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> list[dict]:
    try:
        data = json.loads(STORE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def _save(items: list[dict]) -> None:
    STORE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = STORE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(STORE_FILE)


def save_and_import(result: dict) -> None:
    email = str(result.get("email") or "").strip()
    access_token = str(result.get("access_token") or "").strip()
    if not email or not access_token:
        raise RuntimeError("registered account is missing email or access_token")
    with _lock:
        items = _load()
        current = next((item for item in items if str(item.get("email") or "").lower() == email.lower()), None)
        if current is None:
            current = {"email": email}
            items.append(current)
        current.update({"access_token": access_token, "registered_at": result.get("created_at") or _now(), "synced_at": ""})
        _save(items)
    import_chatgpt_token(access_token, email)
    with _lock:
        items = _load()
        for item in items:
            if str(item.get("email") or "").lower() == email.lower():
                item["synced_at"] = _now()
        _save(items)


def sync_pending() -> tuple[int, int]:
    synced = failed = 0
    with _lock:
        items = _load()
        for item in items:
            if item.get("synced_at"):
                continue
            try:
                import_chatgpt_token(str(item.get("access_token") or ""), str(item.get("email") or ""))
                item["synced_at"] = _now()
                synced += 1
            except Exception:
                failed += 1
        if synced:
            _save(items)
    return synced, failed
