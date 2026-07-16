from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

from . import openai_register
from .image2api_client import active_metrics
from .storage import DATA_DIR, snapshot_file



REGISTER_FILE = DATA_DIR / "register.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_config() -> dict:
    return {**openai_register.config, "mode": "total", "target_quota": 100, "target_available": 10, "check_interval": 5, "enabled": False, "stats": {"success": 0, "fail": 0, "done": 0, "running": 0, "threads": openai_register.config["threads"], "elapsed_seconds": 0, "avg_seconds": 0, "success_rate": 0, "current_quota": 0, "current_available": 0}}


def _normalize(raw: dict) -> dict:
    cfg = _default_config()
    cfg.update({k: v for k, v in raw.items() if k not in {"stats", "logs"}})
    cfg["total"] = max(1, int(cfg.get("total") or 1))
    cfg["threads"] = max(1, int(cfg.get("threads") or 1))
    cfg["mode"] = str(cfg.get("mode") or "total").strip() if str(cfg.get("mode") or "total").strip() in {"total", "quota", "available", "low_watermark"} else "total"
    cfg["target_quota"] = max(1, int(cfg.get("target_quota") or 1))
    cfg["target_available"] = max(1, int(cfg.get("target_available") or 1))
    cfg["check_interval"] = max(1, int(cfg.get("check_interval") or 5))
    cfg["proxy"] = str(cfg.get("proxy") or "").strip()
    cfg["enabled"] = bool(cfg.get("enabled"))
    stats = {**_default_config()["stats"], **(raw.get("stats") if isinstance(raw.get("stats"), dict) else {}),
             "threads": cfg["threads"]}
    cfg["stats"] = stats
    return cfg


def _provider_type(item: object) -> str:
    return str((item or {}).get("type") or (item or {}).get("name") or "").strip() if isinstance(item, dict) else ""


def _merge_mail_config(current: object, incoming: object) -> dict:
    """Merge mail providers by type so switching UI tabs cannot wipe domains."""
    current_mail = current if isinstance(current, dict) else {}
    incoming_mail = incoming if isinstance(incoming, dict) else {}
    merged = {**current_mail, **incoming_mail}
    current_providers = current_mail.get("providers") if isinstance(current_mail.get("providers"), list) else []
    incoming_providers = incoming_mail.get("providers") if isinstance(incoming_mail.get("providers"), list) else None
    if incoming_providers is None:
        return merged

    by_type: dict[str, dict] = {}
    order: list[str] = []
    for item in current_providers:
        if not isinstance(item, dict):
            continue
        provider_key = _provider_type(item)
        if not provider_key:
            continue
        by_type[provider_key] = dict(item)
        order.append(provider_key)
    for item in incoming_providers:
        if not isinstance(item, dict):
            continue
        provider_key = _provider_type(item)
        if not provider_key:
            continue
        previous = by_type.get(provider_key, {})
        next_item = {**previous, **item}
        # Preserve existing domain lists when the submitted provider only
        # carries type/enable fields from a tab switch.
        for key in ("domains", "domain", "allowed_domains", "custom_domains"):
            if previous.get(key) and not item.get(key):
                next_item[key] = previous.get(key)
        by_type[provider_key] = next_item
        if provider_key not in order:
            order.append(provider_key)
    merged["providers"] = [by_type[key] for key in order if key in by_type]
    return merged


class RegisterService:
    def __init__(self, store_file: Path):
        self._store_file = store_file
        self._lock = threading.RLock()
        self._runner: threading.Thread | None = None
        self._logs: list[dict] = []
        openai_register.register_log_sink = self._append_log
        self._config = self._load()
        if self._config["enabled"]:
            self.start()

    def _load(self) -> dict:
        try:
            return _normalize(json.loads(self._store_file.read_text(encoding="utf-8")))
        except Exception:
            return _normalize({})

    def _save(self) -> None:
        self._store_file.parent.mkdir(parents=True, exist_ok=True)
        snapshot_file(self._store_file, prefix="register")
        self._store_file.write_text(json.dumps(self._config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def get(self) -> dict:
        with self._lock:
            cfg = json.loads(json.dumps({**self._config, "logs": self._logs[-300:]}, ensure_ascii=False))
        # 号池可用/额度实时刷新(删号后立即反映,不必等注册轮询更新缓存 stats)
        try:
            metrics = self._pool_metrics()
            if isinstance(cfg.get("stats"), dict):
                cfg["stats"].update(metrics)
        except Exception:
            pass
        return cfg

    def update(self, updates: dict) -> dict:
        should_restart_runner = False
        with self._lock:
            next_updates = dict(updates or {})
            if "mail" in next_updates:
                next_updates["mail"] = _merge_mail_config(self._config.get("mail"), next_updates.get("mail"))
            if "proxy" in next_updates and not str(next_updates.get("proxy") or "").strip() and str(self._config.get("proxy") or "").strip():
                next_updates.pop("proxy", None)
            self._config = _normalize({**self._config, **next_updates})
            openai_register.config.update({k: self._config[k] for k in ("mail", "proxy", "total", "threads")})
            self._save()
            should_restart_runner = bool(self._config.get("enabled")) and not (self._runner and self._runner.is_alive())
        if should_restart_runner:
            self._append_log("注册配置已更新，检测到调度线程未运行，自动重新启动注册任务", "yellow")
            return self.start()
        with self._lock:
            return self.get()

    def start(self) -> dict:
        with self._lock:
            if self._runner and self._runner.is_alive():
                self._config["enabled"] = True
                self._save()
                return self.get()
            self._config["enabled"] = True
            self._logs = []
            metrics = self._pool_metrics()
            self._config["stats"] = {"job_id": uuid.uuid4().hex, "success": 0, "fail": 0, "done": 0, "running": 0, "threads": self._config["threads"], **metrics, "started_at": _now(), "updated_at": _now()}
            openai_register.config.update({k: self._config[k] for k in ("mail", "proxy", "total", "threads")})
            with openai_register.stats_lock:
                openai_register.stats.update({"done": 0, "success": 0, "fail": 0, "start_time": time.time()})
            self._save()
            self._runner = threading.Thread(target=self._run, daemon=True, name="openai-register")
            self._runner.start()
            self._append_log(f"注册任务启动，模式={self._config['mode']}，线程数={self._config['threads']}", "yellow")
            return self.get()

    def stop(self) -> dict:
        with self._lock:
            self._config["enabled"] = False
            self._config["stats"]["updated_at"] = _now()
            self._save()
            self._append_log("已请求停止注册任务，正在等待当前运行任务结束", "yellow")
            return self.get()

    def reset(self) -> dict:
        with self._lock:
            self._logs = []
            self._config["stats"] = {"success": 0, "fail": 0, "done": 0, "running": 0, "threads": self._config["threads"], "elapsed_seconds": 0, "avg_seconds": 0, "success_rate": 0, **self._pool_metrics(), "updated_at": _now()}
            with openai_register.stats_lock:
                openai_register.stats.update({"done": 0, "success": 0, "fail": 0, "start_time": 0.0})
            self._save()
            return self.get()

    def _append_log(self, text: str, color: str = "") -> None:
        with self._lock:
            self._logs.append({"time": _now(), "text": str(text), "level": str(color or "info")})
            self._logs = self._logs[-300:]

    def _pool_metrics(self) -> dict:
        # 当前可用 = image2api 真实活号数(低水位据此触发);拿不到才回退老号池。
        m = active_metrics()
        if m is not None:
            return {"current_quota": m[1], "current_available": m[0]}
        stats = self._config.get("stats") if isinstance(self._config.get("stats"), dict) else {}
        return {
            "current_quota": int(stats.get("current_quota") or 0),
            "current_available": int(stats.get("current_available") or 0),
        }

    def _mail_pool_exhausted(self) -> bool:
        """启用的 mail provider 全是 outlook_oauth（hotmail 号池）且号池已空时返回 True，
        用于暂停提交新任务（避免号池空时空转刷失败）；补号后自动恢复。"""
        mail = self._config.get("mail") if isinstance(self._config.get("mail"), dict) else {}
        provs = [p for p in (mail.get("providers") or []) if isinstance(p, dict) and p.get("enable")]
        types = {str(p.get("type") or "") for p in provs}
        if not types or (types - {"outlook_oauth", "hotmail", "outlook"}):
            return False
        try:
            from . import outlook_pool
            return int(outlook_pool.stats().get("pool_available", 0)) <= 0
        except Exception:
            return False

    def _target_reached(self, cfg: dict, submitted: int) -> bool:
        mode = str(cfg.get("mode") or "total")
        metrics = self._pool_metrics()
        self._bump(**metrics)
        if mode == "quota":
            reached = metrics["current_quota"] >= int(cfg.get("target_quota") or 1)
            self._append_log(f"检查号池：当前正常账号={metrics['current_available']}，当前剩余额度={metrics['current_quota']}，目标额度={cfg.get('target_quota')}，{'跳过注册' if reached else '继续注册'}", "yellow")
            return reached
        if mode == "available":
            reached = metrics["current_available"] >= int(cfg.get("target_available") or 1)
            self._append_log(f"检查号池：当前正常账号={metrics['current_available']}，目标账号={cfg.get('target_available')}，当前剩余额度={metrics['current_quota']}，{'跳过注册' if reached else '继续注册'}", "yellow")
            return reached
        if mode == "low_watermark":
            target_available = int(cfg.get("target_available") or 1)
            if submitted <= 0:
                reached = metrics["current_available"] >= target_available
                self._append_log(
                    f"检查号池：当前正常账号={metrics['current_available']}，触发阈值={target_available}，本轮注册数量={cfg.get('total')}，当前剩余额度={metrics['current_quota']}，{'等待低于阈值' if reached else '开始本轮注册'}",
                    "yellow",
                )
                return reached
            return submitted >= int(cfg.get("total") or 1)
        return submitted >= int(cfg.get("total") or 1)

    def _bump(self, **updates) -> None:
        with self._lock:
            self._config["stats"].update(updates)
            stats = self._config["stats"]
            started_at = str(stats.get("started_at") or "")
            if started_at:
                try:
                    elapsed = max(0.0, (datetime.now(timezone.utc) - datetime.fromisoformat(started_at)).total_seconds())
                except Exception:
                    elapsed = 0.0
                done = int(stats.get("done") or 0)
                success = int(stats.get("success") or 0)
                fail = int(stats.get("fail") or 0)
                stats["elapsed_seconds"] = round(elapsed, 1)
                stats["avg_seconds"] = round(elapsed / success, 1) if success else 0
                stats["success_rate"] = round(success * 100 / max(1, success + fail), 1)
            self._config["stats"]["updated_at"] = _now()
            self._save()

    def _run(self) -> None:
        threads = int(self.get()["threads"])
        submitted, cycle_submitted, done, success, fail = 0, 0, 0, 0, 0
        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = set()
            while True:
                cfg = self.get()
                mode = str(cfg.get("mode") or "total")
                _exhausted = self._mail_pool_exhausted()
                if _exhausted and not getattr(self, "_mail_paused", False):
                    self._mail_paused = True
                    self._append_log("Hotmail 注册号池已空，暂停提交新任务（补号后自动继续；或点停止结束）", "yellow")
                elif not _exhausted and getattr(self, "_mail_paused", False):
                    self._mail_paused = False
                    self._append_log("Hotmail 号池已补充，继续注册", "yellow")
                if mode == "low_watermark" and not futures and cycle_submitted >= int(cfg.get("total") or 1):
                    self._append_log(
                        f"本轮低量自动注册已提交 {cycle_submitted} 个任务，已跑完注册总数，继续监控账号池",
                        "yellow",
                    )
                    cycle_submitted = 0
                while self.get()["enabled"] and not self._target_reached(cfg, cycle_submitted) and len(futures) < threads and not self._mail_pool_exhausted():
                    submitted += 1
                    cycle_submitted += 1
                    futures.add(executor.submit(openai_register.worker, submitted))
                self._bump(running=len(futures), done=done, success=success, fail=fail)
                if mode == "low_watermark" and not futures and cycle_submitted <= 0:
                    self._append_log(
                        f"当前正常账号未低于触发阈值 {cfg.get('target_available')}，暂不启动注册，继续监控",
                        "yellow",
                    )
                if not futures and (not self.get()["enabled"] or str(cfg.get("mode") or "total") == "total"):
                    break
                if not futures:
                    time.sleep(max(1, int(cfg.get("check_interval") or 5)))
                    continue
                finished, futures = wait(futures, return_when=FIRST_COMPLETED, timeout=2)
                for future in finished:
                    done += 1
                    try:
                        result = future.result()
                        success += 1 if result.get("ok") else 0
                        fail += 0 if result.get("ok") else 1
                    except Exception:
                        fail += 1
                if not self.get()["enabled"]:
                    for future in futures:
                        future.cancel()
                    if futures:
                        self._append_log(f"已停止主调度，{len(futures)} 个在跑的任务后台跑完后自然结束（不再统计）", "yellow")
                    break
        self._bump(running=0, done=done, success=success, fail=fail, finished_at=_now())
        with self._lock:
            self._config["enabled"] = False
            self._save()
        self._append_log(f"注册任务结束，成功{success}，失败{fail}", "yellow")


register_service = RegisterService(REGISTER_FILE)
