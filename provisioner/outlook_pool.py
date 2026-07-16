"""Hotmail / Outlook 注册邮箱池（持久化 + 领用 + 别名生成）。

与 temp-mail 类 provider 不同，hotmail 走「导入真实账号 + 领用」模式：
每个账号带 ``client_id`` / ``refresh_token`` 用于 OAuth 收码；可选生成 plus 别名
（``main+tag@domain``，共享主箱凭据，收码时登录主箱）。领用即标记已用，避免重复注册。

存储：``DATA_DIR/outlook_pool.json``，进程内 :class:`threading.RLock` 保护，
每次改动落盘（与 register.json 一致的轻量持久化，无跨进程锁——注册 worker 为单进程多线程）。
"""

from __future__ import annotations

import json
import secrets
import threading
import time
from typing import Any

from .storage import DATA_DIR

POOL_FILE = DATA_DIR / "outlook_pool.json"

_lock = threading.RLock()


def _load() -> list[dict]:
    try:
        data = json.loads(POOL_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    items = data.get("accounts") if isinstance(data, dict) else data
    return [dict(item) for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _save(accounts: list[dict]) -> None:
    POOL_FILE.parent.mkdir(parents=True, exist_ok=True)
    POOL_FILE.write_text(
        json.dumps({"accounts": accounts}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _alias_addresses(account: str, count: int) -> list[str]:
    """基于主箱本地部分生成 plus 别名 ``base+tag@domain``。"""
    local, _, domain = account.partition("@")
    base = local.split("+", 1)[0].strip()
    if not base or not domain:
        return []
    out: list[str] = []
    seen: set[str] = set()
    attempts = 0
    while len(out) < count and attempts < count * 30:
        attempts += 1
        alias = f"{base}+{secrets.token_hex(3)}@{domain}"
        if alias in seen or alias.lower() == account.lower():
            continue
        seen.add(alias)
        out.append(alias)
    return out


def import_accounts(text: str, email_type: str = "", gen_alias: bool = False,
                    alias_count: int = 0) -> dict:
    """批量导入 ``邮箱----密码----client_id----refresh_token``（一行一条）。

    已存在的账号只更新凭据、不重置 ``used``。``gen_alias`` + ``alias_count`` 时，
    为每个带 client_id/refresh_token 的主箱生成别名（共享凭据）。
    """
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    try:
        alias_count = max(0, min(500, int(alias_count or 0)))
    except (TypeError, ValueError):
        alias_count = 0
    gen_alias = bool(gen_alias) and alias_count > 0
    email_type = (email_type or "").strip() or "Hotmail"
    now = int(time.time())
    added = updated = failed = alias_added = 0

    with _lock:
        accounts = _load()
        index = {str(item.get("account") or "").strip().lower(): item for item in accounts}

        def _upsert(acct: str, pwd: str, cid: str, rtok: str, notes: str = "") -> str:
            key = acct.strip().lower()
            existing = index.get(key)
            if existing:
                existing.update({"password": pwd, "client_id": cid,
                                 "refresh_token": rtok, "provider": email_type,
                                 "updated_at": now})
                if notes and not existing.get("notes"):
                    existing["notes"] = notes
                return "updated"
            item = {"account": acct, "password": pwd, "client_id": cid,
                    "refresh_token": rtok, "provider": email_type, "used": False,
                    "leased_at": 0, "notes": notes, "created_at": now, "updated_at": now}
            accounts.append(item)
            index[key] = item
            return "added"

        for line in lines:
            parts = [p.strip() for p in line.split("----")]
            account = parts[0] if parts else ""
            if not account or "@" not in account:
                failed += 1
                continue
            password = parts[1] if len(parts) > 1 else ""
            client_id = parts[2] if len(parts) > 2 else ""
            refresh_token = parts[3] if len(parts) > 3 else ""
            result = _upsert(account, password, client_id, refresh_token)
            if result == "added":
                added += 1
            else:
                updated += 1
            if gen_alias and client_id and refresh_token:
                for alias in _alias_addresses(account, alias_count):
                    if _upsert(alias, password, client_id, refresh_token,
                               notes=f"别名·主箱 {account}") == "added":
                        alias_added += 1

        _save(accounts)

    return {"added": added, "updated": updated, "failed": failed,
            "alias_added": alias_added, "total": len(lines), **stats()}


def lease() -> dict | None:
    """领取一个未使用、且带 client_id+refresh_token 的账号，并立即标记已用。

    返回副本 ``{account, password, client_id, refresh_token, provider}``；池空返回 None。
    """
    with _lock:
        accounts = _load()
        for item in accounts:
            if item.get("used"):
                continue
            if not (str(item.get("client_id") or "").strip()
                    and str(item.get("refresh_token") or "").strip()):
                continue
            item["used"] = True
            item["leased_at"] = int(time.time())
            _save(accounts)
            return {
                "account": str(item.get("account") or "").strip(),
                "password": str(item.get("password") or ""),
                "client_id": str(item.get("client_id") or "").strip(),
                "refresh_token": str(item.get("refresh_token") or "").strip(),
                "provider": str(item.get("provider") or "Hotmail"),
            }
    return None


def _set_used(account: str, used: bool) -> None:
    account = (account or "").strip().lower()
    if not account:
        return
    with _lock:
        accounts = _load()
        for item in accounts:
            if str(item.get("account") or "").strip().lower() == account:
                item["used"] = used
                if not used:
                    item["leased_at"] = 0
                _save(accounts)
                return


def release(account: str) -> None:
    """注册失败时把账号放回池（重新可领）。"""
    _set_used(account, False)


def mark_used(account: str) -> None:
    _set_used(account, True)


def stats() -> dict:
    with _lock:
        accounts = _load()
    total = len(accounts)
    usable = [i for i in accounts if str(i.get("client_id") or "").strip()
              and str(i.get("refresh_token") or "").strip()]
    used = sum(1 for i in usable if i.get("used"))
    return {"pool_total": total, "pool_available": len(usable) - used, "pool_used": used}


def list_accounts(limit: int = 200) -> list[dict]:
    with _lock:
        accounts = _load()
    limit = max(1, min(2000, int(limit or 200)))
    out = []
    for item in accounts[-limit:]:
        out.append({
            "account": item.get("account"),
            "provider": item.get("provider"),
            "used": bool(item.get("used")),
            "has_creds": bool(str(item.get("client_id") or "").strip()
                              and str(item.get("refresh_token") or "").strip()),
            "notes": item.get("notes") or "",
        })
    return out
