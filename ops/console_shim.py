#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
console_shim.py — 只读适配层（go2api / 43.155.234.236）
把 image2api(Go) 的数据、主机指标和独立 Provisioner 拼成集群控制台
(ChatGPT2API 风格) 期望的 /api/* 契约。控制台代码/配置零改动：它本来就轮询
https://tu.go2api.cc/api/*，nginx 把 /api/ 与 /healthz 转到本 shim(127.0.0.1:18099)。

不改 image2api：全部走它的 /admin/api/* HTTP 接口(会话登录)。
纯 stdlib，无第三方依赖。
"""
import json
import os
import time
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

I2A = os.getenv("IMAGE2API_BASE", "http://127.0.0.1:2000").rstrip("/")
I2A_ID = os.getenv("IMAGE2API_ADMIN", "admin")
I2A_PW = os.getenv("IMAGE2API_ADMIN_PW", "")
PROVISION = os.getenv("PROVISION_BASE", "http://127.0.0.1:18002").rstrip("/")
PROVISION_KEY = os.getenv("PROVISION_ADMIN_KEY", "")
SHIM_KEY = os.getenv("CONSOLE_SHIM_KEY", "")
IMG_PUBLIC = os.getenv("IMAGE_PUBLIC_BASE", "https://tu.go2api.cc").rstrip("/")
LISTEN = (os.getenv("CONSOLE_SHIM_HOST", "127.0.0.1"), int(os.getenv("CONSOLE_SHIM_PORT", "18099")))

# ---------------------------------------------------------------- image2api 会话
# 令牌持久化到磁盘并长期复用(登录接口有限流，重启/冷启动不再重登)。
# 只有真正 401/403 才清掉重登。
TOKFILE = os.getenv("CONSOLE_SHIM_TOKEN_FILE", "/opt/image2api-g2a/.shim_token")
_tok = {"v": ""}
_tok_lock = threading.Lock()

try:
    with open(TOKFILE) as _f:
        _tok["v"] = _f.read().strip()
except Exception:
    pass


def _i2a_login():
    r = urllib.request.Request(
        I2A + "/admin/api/auth/login",
        data=json.dumps({"identifier": I2A_ID, "password": I2A_PW}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(r, timeout=8) as resp:
        _tok["v"] = (json.loads(resp.read().decode()).get("token") or "")
    try:
        with open(TOKFILE, "w") as f:
            f.write(_tok["v"])
    except Exception:
        pass
    return _tok["v"]


def i2a(method, path, body=None, timeout=15, _retry=True):
    """调用 image2api admin API，返回 (status, json)。401/403 自动重登一次。"""
    with _tok_lock:
        tok = _tok["v"] or _i2a_login()
    data = json.dumps(body).encode() if body is not None else None
    h = {"Authorization": "Bearer " + tok}
    if data is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(I2A + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode() or "{}"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and _retry:
            with _tok_lock:
                _tok["v"] = ""
            return i2a(method, path, body, timeout, _retry=False)
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def provision(method, path, body=None, timeout=15):
    """调用独立 Provisioner 的注册和主机指标兼容接口。"""
    data = json.dumps(body).encode() if body is not None else None
    h = {"Authorization": "Bearer " + PROVISION_KEY}
    if data is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(PROVISION + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "application/json")


# ---------------------------------------------------------------- 工具
def fmt_ts(ts):
    """unix 秒 -> 'YYYY-MM-DD HH:MM:SS'(Asia/Shanghai, +8 固定)。"""
    try:
        ts = float(ts)
        if ts <= 0:
            return ""
        return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts + 8 * 3600))
    except Exception:
        return ""


_cache = {}


def cached(key, ttl, fn):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (now, val)
    return val


def _host_cpu_percent():
    # 容器 psutil 的 cpu_percent 常卡 0,shim 从宿主 /proc/stat 算(与上次采样的差,首次短采样)。
    def _read():
        with open("/proc/stat") as f:
            v = [int(x) for x in f.readline().split()[1:]]
        return sum(v), v[3] + (v[4] if len(v) > 4 else 0)
    total, idle = _read()
    prev = _cache.get("cpu_sample")
    _cache["cpu_sample"] = (total, idle)
    if not prev:
        time.sleep(0.3)
        t2, i2 = _read()
        _cache["cpu_sample"] = (t2, i2)
        dt, di = t2 - total, i2 - idle
    else:
        dt, di = total - prev[0], idle - prev[1]
    return round(100.0 * (dt - di) / dt, 1) if dt > 0 else 0.0


def _accounts_raw():
    st, d = i2a("GET", "/admin/api/accounts")
    return d.get("data") or []


# 集群控制台的「号池」只代表 chatgpt 出图号池：统计与账号列表都只看 chatgpt，
# 其它池(adobe/runway/custom)是辅助上游，不计入号池管理。
_POOL = "chatgpt"

def _accounts_chatgpt():
    return [a for a in _accounts_raw() if (a.get("pool") or "") == _POOL]


def _default_conc():
    st, cg = i2a("GET", "/admin/api/concurrency-groups")
    groups = cg.get("data") or []
    g = next((x for x in groups if x.get("is_default")), (groups[0] if groups else {}))
    return int(g.get("max_concurrency") or 0), (g.get("id") or "")


# ---------------------------------------------------------------- 各端点实现
def ep_healthz():
    return 200, {"ok": True, "version": "go2api-image2api-shim/1"}


def ep_settings_get():
    conc, _ = cached("conc", 8, _default_conc)
    # image_pricing / video_pricing / model 接入：控制台的定价&模型页会读，
    # image2api 有独立后台管理，这里给可展示的默认结构，避免前端报错。
    return 200, {"config": {
        "image_global_concurrency": conc,
        "image_pricing": {"base_1k": 1, "plus_2k": 10, "plus_4k": 30},
        "video_pricing": {"per_second": 15, "surcharge_720p": 0},
        "image_gateway": {"enabled": False, "base_url": "", "api_key": "", "models": []},
        "video_provider": {"enabled": False, "base_url": "", "api_key": "", "model": "", "fallback": {}},
    }}


def ep_settings_post(body):
    # 仅并发可回写到 image2api(默认并发组)；定价/模型接入请在 image2api 后台管。
    if "image_global_concurrency" in (body or {}):
        try:
            val = int(body["image_global_concurrency"])
            _, gid = _default_conc()
            if gid:
                i2a("PATCH", "/admin/api/concurrency-groups/" + quote(gid),
                    {"max_concurrency": val})
                _cache.pop("conc", None)
        except Exception:
            pass
    return 200, {"ok": True}


def _metrics():
    # 主机资源来自独立 Provisioner；号池和生成统计来自 image2api。
    system, disk, uptime = {}, {}, None
    try:
        st, raw, _ = provision("GET", "/api/system/metrics", timeout=8)
        base = json.loads(raw.decode())
        system = base.get("system") or {}
        disk = base.get("disk") or {}
        uptime = base.get("uptime_seconds")
    except Exception:
        pass
    try:
        system = dict(system or {})
        system["cpu_percent"] = _host_cpu_percent()
    except Exception:
        pass

    # 号池 / 出图取自 image2api；任一失败(如登录限流)则回退上次好值，绝不整体报错。
    prev = (_cache.get("metrics") or (0, {}))[1]
    running = 0
    try:
        accs = _accounts_chatgpt()
        total = len(accs)
        active = sum(1 for a in accs if not a.get("dead") and not a.get("image_limited")
                     and int(a.get("remaining") or 0) > 0)
        limited = sum(1 for a in accs if a.get("image_limited"))
        abnormal = sum(1 for a in accs if a.get("dead"))
        total_quota = sum(int(a.get("remaining") or 0) for a in accs)
        accounts = {"total": total, "active": active, "limited": limited,
                    "abnormal": abnormal, "disabled": 0, "total_quota": total_quota}
        running = sum(int(a.get("in_flight") or 0) for a in accs)  # 实时在跑
    except Exception:
        accounts = prev.get("accounts") or {"total": 0, "active": 0, "limited": 0,
                                            "abnormal": 0, "disabled": 0, "total_quota": 0}

    try:
        st, dash = i2a("GET", "/admin/api/dashboard")
        today = dash.get("today") or {}
        _, stats = i2a("GET", "/admin/api/stats")
        tasks = {
            "running": running,
            "queued": max(0, int(today.get("pending") or 0) - running),
            "today_success": int(today.get("success") or 0),
            "today_error": int(today.get("failed") or 0),
            "today_total": int(today.get("total") or 0),
            "today_avg_duration_ms": int(stats.get("avg_elapsed_ms_24h") or stats.get("avg_elapsed_ms") or 0),
            "billed_success": int(today.get("success") or 0),
            "billed_failed": int(today.get("failed") or 0),
            "today_node_images": int(today.get("success") or 0),  # 本机=实际产出=成功数
            "today_node_failed": int(today.get("failed") or 0),
        }
    except Exception:
        tasks = prev.get("tasks") or {
            "running": 0, "queued": 0, "today_success": 0, "today_error": 0,
            "today_total": 0, "today_avg_duration_ms": 0, "billed_success": 0, "billed_failed": 0,
            "today_node_images": 0, "today_node_failed": 0}
    return {
        "generated_at": fmt_ts(time.time()),
        "uptime_seconds": uptime,
        "system": system, "disk": disk,
        "accounts": accounts,
        "tasks": tasks,
    }


def ep_metrics():
    return 200, cached("metrics", 10, _metrics)


def _acct_status(a):
    if a.get("dead"):
        return "异常"
    if a.get("image_limited"):
        return "限流"
    return "正常"


def ep_accounts_get():
    accs = _accounts_chatgpt()
    items = []
    for a in accs:
        items.append({
            # access_token 用 "pool/id" 复合键，删除时解析(image2api 无裸 token)
            "access_token": "%s/%s" % (a.get("pool") or "", a.get("id") or ""),
            "type": a.get("pool") or "",
            "status": _acct_status(a),
            "email": a.get("email") or "",
            "user_id": a.get("email") or "",
            "quota": a.get("remaining"),
            "image_quota_unknown": (a.get("quota_supported") is False),
            "created_at": fmt_ts(a.get("created_at")),
            "success": a.get("success_total"),
            "fail": a.get("fail_total"),
        })
    return 200, {"items": items}


def ep_accounts_delete(body):
    toks = (body or {}).get("tokens") or []
    n = 0
    for t in toks:
        if "/" in str(t):
            pool, _, aid = str(t).partition("/")
            st, _ = i2a("DELETE", "/admin/api/tokens/%s/%s" % (quote(pool), quote(aid)))
            if st < 400:
                n += 1
    return 200, {"ok": True, "deleted": n}


def ep_credit_get(qs):
    st, d = i2a("GET", "/admin/api/cdks")
    data = d.get("data") or []
    items = []
    for c in data:
        items.append({
            "id": c.get("code"),
            "code": c.get("code"),
            "points": c.get("amount"),
            "used": (c.get("status") == "redeemed"),
            "used_by_name": c.get("redeemed_by_name") or "",
            "used_by": c.get("redeemed_by") or "",
            "used_at": fmt_ts(c.get("redeemed_at")) if c.get("redeemed_at") else "",
            "batch": c.get("batch_id") or "",
            "created_at": fmt_ts(c.get("created_at")),
        })
    return 200, {"items": items, "total": (d.get("stats") or {}).get("total", len(items))}


def ep_credit_post(body):
    b = body or {}
    st, d = i2a("POST", "/admin/api/cdks", {
        "amount": int(b.get("points") or 0),
        "count": int(b.get("count") or 0),
        "note": b.get("batch") or "",
        "type": "normal",
    })
    created = d.get("created") or d.get("items") or []
    items = [{"code": c.get("code"), "id": c.get("code")} for c in created]
    return (200 if st < 400 else st), {"items": items, "ok": st < 400,
                                        "detail": d.get("detail")}


def ep_credit_delete(code):
    st, d = i2a("DELETE", "/admin/api/cdks/" + quote(code))
    return (200 if st < 400 else st), {"ok": st < 400, "detail": d.get("detail")}


def ep_logs_get(qs):
    t = (qs.get("type") or [""])[0].strip().lower()
    path = "/admin/api/logs?limit=800&scope=all"  # 全站日志+800条(控制台用户名搜索是前端过滤,窗口大点才搜得到老记录)
    # image2api 的日志本身就是"生成调用"：call(默认)/"" = 全部；只有 image/video 是真 kind；
    # account/admin/register 是 ChatGPT2API 分类，image2api 无对应，返回空。
    if t in ("account", "admin", "register"):
        return 200, {"items": [], "total": 0}
    if t in ("image", "video"):
        path += "&kind=" + quote(t)
    st, d = i2a("GET", path)
    data = d.get("data") or []
    items = []
    for r in data:
        detail = {
            "model": r.get("model") or "",
            "key_name": r.get("user_name") or r.get("user_id") or "",
            "key_id": r.get("user_id") or "",
            "status": r.get("status") or "",
            "duration_ms": r.get("elapsed_ms"),
            "credit_cost": r.get("cost"),
            "net_credit_cost": r.get("cost"),
            "refund_cost": 0,
            "error": r.get("error") or "",
            "error_message": r.get("error") or "",
            "account_email": r.get("account") or "",
            "provider": r.get("provider") or "",
            "source": r.get("source") or "",
            "resolution": r.get("resolution") or "",
            "ratio": r.get("ratio") or "",
            "request_text": r.get("prompt") or "",
        }
        items.append({
            "time": fmt_ts(r.get("created_at") or r.get("ts")),
            "created_at": fmt_ts(r.get("created_at") or r.get("ts")),
            "type": r.get("kind") or "image",
            "user_name": r.get("user_name") or "",
            "user_id": r.get("user_id") or "",
            "summary": (r.get("prompt") or "")[:80],
            "title": (r.get("prompt") or "")[:80],
            "detail": detail,
        })
    return 200, {"items": items, "total": d.get("total", len(items))}


def ep_images_get(qs):
    start = (qs.get("start_date") or [""])[0]
    end = (qs.get("end_date") or [""])[0]
    try:
        limit = int((qs.get("limit") or ["200"])[0])
    except Exception:
        limit = 200
    limit = max(1, min(limit, 2000))
    st, d = i2a("GET", "/admin/api/images?kind=image&limit=%d" % limit)
    data = d.get("data") or []
    items = []
    for it in data:
        name = it.get("name") or ""
        ca = fmt_ts(it.get("mtime"))
        day = ca[:10]
        if start and day and day < start:
            continue
        if end and day and day > end:
            continue
        owner = name.split("/")[0] if "/" in name else ""
        url = IMG_PUBLIC + "/images/" + name
        items.append({
            "rel": name,
            "created_at": ca,
            "size": it.get("size"),
            "owner_id": owner,
            "is_admin_owner": (owner == "admin"),
            "url": url,
            "thumbnail_url": url,
        })
    return 200, {"items": items}


def ep_images_delete(body):
    b = body or {}
    removed = 0
    if b.get("paths"):
        for rel in b["paths"]:
            st, _ = i2a("DELETE", "/admin/api/images?file=" + quote(str(rel)))
            if st < 400:
                removed += 1
        return 200, {"ok": True, "removed": removed}
    if b.get("all_matching"):
        end = b.get("end_date") or ""
        st, d = i2a("GET", "/admin/api/images?kind=image&limit=2000")
        for it in (d.get("data") or []):
            name = it.get("name") or ""
            day = fmt_ts(it.get("mtime"))[:10]
            if end and day and day <= end:
                s2, _ = i2a("DELETE", "/admin/api/images?file=" + quote(name))
                if s2 < 400:
                    removed += 1
        return 200, {"ok": True, "removed": removed}
    return 200, {"ok": True, "removed": 0}


def ep_users_get():
    st, d = i2a("GET", "/admin/api/users")
    data = d.get("data") or []
    items = []
    for u in data:
        # image2api 是余额(credits)模型：把余额当"剩余/额度"展示，已用置 0。
        items.append({
            "id": u.get("id"),
            "name": u.get("name") or u.get("email") or "",
            "quota": int(u.get("credits") or 0),
            "used": 0,
            "unlimited": False,
            "enabled": (u.get("status") == "active"),
            "image_concurrency": 0,
        })
    return 200, {"items": items}


def ep_user_post(uid, body):
    b = body or {}
    if uid:  # 编辑/充值：控制台把新额度当绝对值传(quota)，映射为设定 credits
        if "quota" in b:
            st, d = i2a("POST", "/admin/api/users/" + quote(uid) + "/credits",
                        {"set": int(b.get("quota") or 0)})
            return (200 if st < 400 else st), {"ok": st < 400, "detail": d.get("detail")}
        return 200, {"ok": True}
    # 新建用户(集群控制台少用；best-effort)
    st, d = i2a("POST", "/admin/api/users", {
        "name": b.get("name") or "",
        "credits": int(b.get("quota") or 0),
    })
    key = ""
    if isinstance(d, dict):
        key = d.get("key") or (d.get("api_key") or "")
    return (200 if st < 400 else st), {"ok": st < 400, "key": key, "detail": d.get("detail")}


def ep_user_delete(uid):
    st, d = i2a("DELETE", "/admin/api/users/" + quote(uid))
    return (200 if st < 400 else st), {"ok": st < 400, "detail": d.get("detail")}


def ep_user_history(uid, qs):
    # image2api 无"任意用户"充值记录的 admin 接口，返回空(前端优雅显示"无记录")。
    return 200, {"items": []}


def ep_concurrency():
    # 实时并发:从 pending 生图记录(status=pending,当前在跑)按用户聚合。image2api
    # 的 pending 可能残留卡住的老记录,>10min 的当卡住剔除,避免虚高。
    conc, _ = cached("conc", 8, _default_conc)
    users = []
    total = 0
    try:
        st, d = i2a("GET", "/admin/api/logs?scope=all&status=pending&limit=100")
        now = time.time()
        agg = {}
        for r in (d.get("data") or []):
            ca = float(r.get("created_at") or r.get("ts") or 0)
            age = int(now - ca) if ca else 0
            if age > 600:
                continue
            u = r.get("user_name") or r.get("user_id") or "?"
            e = agg.setdefault(u, {"n": 0, "oldest": 0})
            e["n"] += 1
            if age > e["oldest"]:
                e["oldest"] = age
        for u, e in agg.items():
            users.append({"name": u, "key": u, "running": e["n"],
                          "waiting": 0, "oldest_wait_seconds": e["oldest"]})
            total += e["n"]
        users.sort(key=lambda x: -x["running"])
    except Exception:
        pass
    return 200, {
        "global_limit": conc, "user_limit": conc,
        "global_running": total, "global_waiting": 0, "users": users,
    }


# ---------------------------------------------------------------- HTTP 路由
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, status, obj, ctype="application/json", raw=False):
        body = obj if raw else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _authed(self):
        return (self.headers.get("Authorization") or "") == "Bearer " + SHIM_KEY

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return {}

    # 注册兼容接口透传到独立 Provisioner。
    def _passthru_cgt(self, method, body=None):
        u = urlparse(self.path)
        st, raw, ct = provision(method, u.path + (("?" + u.query) if u.query else ""), body)
        self._send(st, raw, ctype=ct, raw=True)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        qs = parse_qs(u.query)
        try:
            if p == "/healthz":
                return self._send(*ep_healthz())
            if not self._authed():
                return self._send(401, {"detail": "unauthorized"})
            if p == "/api/settings":
                return self._send(*ep_settings_get())
            if p == "/api/system/metrics":
                return self._send(*ep_metrics())
            if p == "/api/system/concurrency":
                return self._send(*ep_concurrency())
            if p == "/api/accounts":
                return self._send(*ep_accounts_get())
            if p == "/api/admin/credit-codes":
                return self._send(*ep_credit_get(qs))
            if p == "/api/logs":
                return self._send(*ep_logs_get(qs))
            if p == "/api/images":
                return self._send(*ep_images_get(qs))
            if p == "/api/auth/users":
                return self._send(*ep_users_get())
            if p.startswith("/api/auth/users/") and p.endswith("/credit-history"):
                uid = p[len("/api/auth/users/"):-len("/credit-history")]
                return self._send(*ep_user_history(uid, qs))
            if p.startswith("/api/register") or p.startswith("/api/image-tasks"):
                return self._passthru_cgt("GET")
            return self._send(404, {"detail": "not found: " + p})
        except Exception as e:
            return self._send(502, {"detail": "shim error: %s" % e})

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        if not self._authed():
            return self._send(401, {"detail": "unauthorized"})
        body = self._body()
        try:
            if p == "/api/settings":
                return self._send(*ep_settings_post(body))
            if p == "/api/accounts/refresh":
                return self._send(200, {"ok": True, "message": "chatgpt 号池实时活号，无需手动刷新",
                                        "refreshed": 0, "deleted": 0, "after": 0, "errors": 0})
            if p == "/api/admin/credit-codes":
                return self._send(*ep_credit_post(body))
            if p == "/api/images/delete":
                return self._send(*ep_images_delete(body))
            if p == "/api/auth/users":
                return self._send(*ep_user_post("", body))
            if p.startswith("/api/auth/users/"):
                uid = p[len("/api/auth/users/"):]
                return self._send(*ep_user_post(uid, body))
            if p.startswith("/api/register") or p.startswith("/api/image-tasks"):
                return self._passthru_cgt("POST", body)
            return self._send(404, {"detail": "not found: " + p})
        except Exception as e:
            return self._send(502, {"detail": "shim error: %s" % e})

    def do_DELETE(self):
        u = urlparse(self.path)
        p = u.path
        if not self._authed():
            return self._send(401, {"detail": "unauthorized"})
        body = self._body()
        try:
            if p == "/api/accounts":
                return self._send(*ep_accounts_delete(body))
            if p.startswith("/api/admin/credit-codes/"):
                code = p[len("/api/admin/credit-codes/"):]
                return self._send(*ep_credit_delete(code))
            if p.startswith("/api/auth/users/"):
                uid = p[len("/api/auth/users/"):]
                return self._send(*ep_user_delete(uid))
            if p.startswith("/api/register"):
                return self._passthru_cgt("DELETE", body)
            return self._send(404, {"detail": "not found: " + p})
        except Exception as e:
            return self._send(502, {"detail": "shim error: %s" % e})


def main():
    srv = ThreadingHTTPServer(LISTEN, Handler)
    srv.daemon_threads = True
    print("console_shim listening on %s:%d" % LISTEN, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
