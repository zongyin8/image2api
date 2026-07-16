# -*- coding: utf-8 -*-
"""Pure-Python reimplementation of OpenAI sentinel `_n` collector VM (the `t` field).
Reproduces the register-machine that OpenAI's sentinel SDK runs in-browser.
"""
import json, base64, math, time, random

# ---------- JS primitives ----------
def js_btoa(s):
    # s is a "latin1" string (char codes 0..255). btoa -> base64 of those bytes.
    b = bytes(ord(c) & 0xFF for c in s)
    return base64.b64encode(b).decode("ascii")

def js_atob(s):
    # returns a latin1 string
    s = s.strip()
    pad = (-len(s)) % 4
    raw = base64.b64decode(s + "=" * pad)
    return "".join(chr(b) for b in raw)

def js_xor(t, n):
    # Tn: for i in t: fromCharCode(t.charCodeAt(i) ^ n.charCodeAt(i % n.length))
    if not n:
        return t
    return "".join(chr(ord(t[i]) ^ ord(n[i % len(n)])) for i in range(len(t)))

def js_number(v):
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if v is None:
        return float("nan")
    if isinstance(v, (int, float)):
        return float(v)
    try:
        s = str(v).strip()
        if s == "":
            return 0.0
        return float(s)
    except Exception:
        return float("nan")

def _fmt_num(x):
    # JS Number -> string
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if x != x:
            return "NaN"
        if x == math.inf:
            return "Infinity"
        if x == -math.inf:
            return "-Infinity"
        if x == int(x) and abs(x) < 1e21:
            return str(int(x))
        r = repr(x)
        return r
    return str(x)

def js_str(v):
    if v is None:
        return "null"          # ""+null (undefined would be "undefined")
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return _fmt_num(v)
    if isinstance(v, str):
        return v
    if isinstance(v, JSUndefined):
        return "undefined"
    if isinstance(v, list):
        return ",".join("" if (e is None or isinstance(e, JSUndefined)) else js_str(e) for e in v)
    if isinstance(v, JSObject):
        return "[object Object]"
    return str(v)

class JSUndefined:
    _inst = None
    def __repr__(self): return "undefined"
    def __bool__(self): return False
UNDEF = JSUndefined()

def js_json_stringify(v):
    # Compact, JS-compatible.
    out = []
    _stringify(v, out)
    res = "".join(out)
    return res if res != "\x00UNDEF\x00" else None

def _stringify(v, out):
    if isinstance(v, JSUndefined):
        out.append("\x00UNDEF\x00"); return
    if v is None:
        out.append("null"); return
    if isinstance(v, bool):
        out.append("true" if v else "false"); return
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (v != v or v in (math.inf, -math.inf)):
            out.append("null")
        else:
            out.append(_fmt_num(v))
        return
    if isinstance(v, str):
        out.append(_json_str(v)); return
    if isinstance(v, list):
        out.append("[")
        for i, e in enumerate(v):
            if i: out.append(",")
            if isinstance(e, JSUndefined) or callable(e):
                out.append("null")
            else:
                _stringify(e, out)
        out.append("]"); return
    if isinstance(v, JSObject):
        out.append("{")
        first = True
        for k, val in v.entries():
            if isinstance(val, JSUndefined) or callable(val):
                continue
            if not first: out.append(",")
            first = False
            out.append(_json_str(str(k))); out.append(":")
            _stringify(val, out)
        out.append("}"); return
    if callable(v):
        out.append("\x00UNDEF\x00"); return
    out.append("null")

_ESC = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'}
def _json_str(s):
    r = ['"']
    for c in s:
        if c in _ESC: r.append(_ESC[c])
        elif ord(c) < 0x20: r.append("\\u%04x" % ord(c))
        else: r.append(c)
    r.append('"')
    return "".join(r)

# ---------- JS object model ----------
class JSObject:
    """Ordered dict-like with JS get/set semantics; missing -> UNDEF."""
    def __init__(self, d=None):
        self._d = {}
        if d:
            for k, v in d.items():
                self._d[str(k)] = v
    def get(self, k):
        return self._d.get(str(k), UNDEF)
    def set(self, k, v):
        self._d[str(k)] = v
    def has(self, k):
        return str(k) in self._d
    def entries(self):
        return list(self._d.items())
    def keys(self):
        return list(self._d.keys())

class Done(Exception):
    def __init__(self, value, ok=True):
        self.value = value; self.ok = ok

# ---------- The VM ----------
class SentinelVM:
    # opcode register keys
    On_,Ft,Lt,Jt,Gt,Wt,zt,Vt,Bt,Zt,Kt,Qt,Yt,Xt,tn,nn,en,rn,on,cn = \
        0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19
    un,an,fn,sn,Ht,ln,dn,hn,pn,mn,gn = 20,21,22,23,24,25,26,27,28,29,30
    wn,yn,vn = 33,34,35

    def __init__(self, window, key, debug=False):
        self.reg = {}
        self.window = window
        self.key = key
        self.debug = debug
        self.output = None
        self.kn = 0
        self.accesses = []
        self._install_opcodes()

    def g(self, k):
        return self.reg.get(k, UNDEF)
    def s(self, k, v):
        self.reg[k] = v

    def _resolve(self, t):
        raise Done(js_btoa(js_str(t)), True)
    def _reject(self, t):
        raise Done(js_btoa(js_str(t)), False)

    def _install_opcodes(self):
        R = self.reg
        g = self.g; s = self.s
        def OP_Ft(n, e): s(n, js_xor(js_str(g(n)), js_str(g(e))))
        def OP_Lt(n, e): s(n, e)
        def OP_Wt(n, e):
            o = g(n)
            if isinstance(o, list): o.append(g(e))
            else: s(n, js_str(o) + js_str(g(e)) if isinstance(o, str) else js_number(o) + js_number(g(e)))
        def OP_zt(n, e, r):
            base = g(e); prop = g(r)
            val = self._prop(base, prop)
            s(n, val)
        def OP_Vt(n, *e):
            fn = g(n)
            args = [g(x) for x in e]
            return self._call(fn, args)
        def OP_Bt(n, e): s(n, g(e))
        def OP_Qt(n, e):
            # find first script src containing g(e)
            s(n, None)
        def OP_Yt(n): s(n, R)
        def OP_Xt(n, e, *r):
            try:
                fn = g(e); self._call(fn, list(r))
            except Exception as ex:
                s(n, str(ex))
        def OP_tn(n, e): s(n, json.loads(js_str(g(e))))
        def OP_nn(n, e): s(n, js_json_stringify(g(e)))
        def OP_on(n): s(n, js_atob(js_str(g(n))))
        def OP_cn(n): s(n, js_btoa(js_str(g(n))))
        def OP_un(n, e, r, *o):
            if g(n) == g(e):
                return self._call(g(r), list(o))
        def OP_an(n, e, r, o, *i):
            if abs(js_number(g(n)) - js_number(g(e))) > js_number(g(r)):
                return self._call(g(o), list(i))
        def OP_sn(n, e, *r):
            if not isinstance(g(n), JSUndefined):
                return self._call(g(e), list(r))
        def OP_Ht(n, e, r):
            base = g(e); meth = self._prop(base, g(r))
            s(n, BoundMethod(meth, base))
        def OP_hn(n, e):
            o = g(n)
            if isinstance(o, list):
                try: o.pop(o.index(g(e)))
                except ValueError: pass
            else: s(n, js_number(o) - js_number(g(e)))
        def OP_mn(n, e, r): s(n, js_number(g(e)) < js_number(g(r)))
        def OP_wn(n, e, r): s(n, js_number(g(e)) * js_number(g(r)))
        def OP_vn(n, e, r):
            c = js_number(g(r)); s(n, 0 if c == 0 else js_number(g(e)) / c)
        def OP_yn(n, e): s(n, g(e))
        def OP_noop(*a): pass
        def OP_gn(t, n, e, r):
            is_list = isinstance(r, list)
            u = e if is_list else []
            a = (r if is_list else e) or []
            def cb(*args):
                saved = list(g(self.Zt))
                if is_list:
                    for i2 in range(len(u)):
                        s(u[i2], args[i2] if i2 < len(args) else UNDEF)
                s(self.Zt, list(a))
                try:
                    self._run()
                    return g(n)
                finally:
                    s(self.Zt, saved)
            s(t, cb)
        def OP_On(t):
            # nested program executor: t is encoded sub-program
            saved = list(g(self.Zt))
            try:
                prog = json.loads(js_xor(js_atob(js_str(t)), js_str(g(self.en))))
                s(self.Zt, prog)
                self._run()
            finally:
                s(self.Zt, saved)
        def OP_fn(n, e):
            saved = list(g(self.Zt))
            try:
                s(self.Zt, list(e) if isinstance(e, list) else [])
                self._run()
            except Exception as ex:
                s(n, str(ex))
            finally:
                s(self.Zt, saved)

        R[self.On_] = OP_On
        R[self.Ft] = OP_Ft
        R[self.Lt] = OP_Lt
        R[self.Jt] = self._resolve
        R[self.Gt] = self._reject
        R[self.Wt] = OP_Wt
        R[self.zt] = OP_zt
        R[self.Vt] = OP_Vt
        R[self.Bt] = OP_Bt
        R[self.Kt] = self.window
        R[self.Qt] = OP_Qt
        R[self.Yt] = OP_Yt
        R[self.Xt] = OP_Xt
        R[self.tn] = OP_tn
        R[self.nn] = OP_nn
        R[self.en] = self.key
        R[self.rn] = None  # set below (needs _call)
        R[self.on] = OP_on
        R[self.cn] = OP_cn
        R[self.un] = OP_un
        R[self.an] = OP_an
        R[self.fn] = OP_fn
        R[self.sn] = OP_sn
        R[self.Ht] = OP_Ht
        R[self.ln] = OP_noop
        R[self.dn] = OP_noop
        R[self.hn] = OP_hn
        R[self.pn] = OP_noop
        R[self.mn] = OP_mn
        R[self.gn] = OP_gn
        R[self.wn] = OP_wn
        R[self.yn] = OP_yn
        R[self.vn] = OP_vn
        def OP_rn(n, e, *r):
            try:
                fn = g(e); res = self._call(fn, [g(x) for x in r])
                s(n, res)
            except Exception as ex:
                s(n, str(ex))
        R[self.rn] = OP_rn

    def _prop(self, base, prop):
        key = prop
        if isinstance(base, JSObject):
            return base.get(key)
        if isinstance(base, dict):
            return base.get(str(key), UNDEF)
        if isinstance(base, list):
            if key == "length": return len(base)
            try:
                return base[int(key)]
            except Exception:
                # array method
                return getattr(_ArrProxy(base), str(key), UNDEF)
        if isinstance(base, str):
            if key == "length": return len(base)
            return UNDEF
        if base is None or isinstance(base, JSUndefined):
            raise TypeError("Cannot read properties of undefined/null (reading '%s')" % key)
        # python object with attributes
        v = getattr(base, str(key), UNDEF)
        return v

    def _call(self, fn, args):
        if isinstance(fn, BoundMethod):
            return fn(*args)
        if callable(fn):
            return fn(*args)
        raise TypeError("not a function: %r" % (fn,))

    def _run(self):
        while True:
            q = self.g(self.Zt)
            if not isinstance(q, list) or len(q) == 0:
                break
            ins = q.pop(0)
            op = ins[0]; args = ins[1:]
            fn = self.reg.get(op)
            if self.debug:
                self.accesses.append((self.kn, op, args[:4]))
            if fn is None:
                raise RuntimeError("unknown opcode %r at %d" % (op, self.kn))
            self._call(fn, args)
            self.kn += 1

    def run(self, program):
        self.s(self.Zt, list(program))
        try:
            self._run()
        except Done as d:
            self.output = d.value
            return d.value
        # no explicit resolve -> btoa(kn+": "+result)? fallback
        return self.output


class BoundMethod:
    def __init__(self, meth, this):
        self.meth = meth; self.this = this
    def __call__(self, *args):
        m = self.meth
        if isinstance(m, JSUndefined):
            raise TypeError("bound method undefined")
        return m(*args)

class _ArrProxy:
    def __init__(self, arr): self._a = arr


# ---------- entry ----------
def compute_t(response, reqtok, window):
    """response: sentinel/req json; reqtok: requirements token (xor key); window: JSObject env."""
    dx = response["turnstile"]["dx"]
    program = json.loads(js_xor(js_atob(dx), reqtok))
    vm = SentinelVM(window, reqtok)
    return vm.run(program)


# ============ Browser environment ============


def make_window(cf=None, ua=None, profile=None):
    cf = cf or {}
    ua = ua or ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")
    p = profile or {}

    # ---- element / font-measurement model ----
    def make_element(tag):
        el = JSObject()
        style = JSObject()
        el.set("style", style)
        el.set("tagName", str(tag).upper())
        el.set("innerText", "")
        el.set("textContent", "")
        el.set("children", [])
        def getBoundingClientRect(*a):
            # width/height of rendered text (Helvetica 14px, the special combining string)
            txt = js_str(el.get("innerText")) or js_str(el.get("textContent"))
            fs = 14.0
            try: fs = float(str(style.get("fontSize")).replace("px", "")) if not isinstance(style.get("fontSize"), type(UNDEF)) else 14.0
            except Exception: fs = 14.0
            w = round(len(txt) * fs * 0.5219 + 0.4, 4) if txt else 0.0
            h = round(fs * 1.1499, 4)
            r = JSObject({"x": 0, "y": 0, "left": 0, "top": 0,
                          "right": w, "bottom": h, "width": w, "height": h})
            return r
        el.set("getBoundingClientRect", getBoundingClientRect)
        def appendChild(c):
            el.get("children").append(c); return c
        def removeChild(c):
            try: el.get("children").remove(c)
            except Exception: pass
            return c
        el.set("appendChild", appendChild)
        el.set("removeChild", removeChild)
        el.set("setAttribute", lambda *a: UNDEF)
        return el

    body = make_element("body")

    document = JSObject()
    document.set("createElement", lambda tag: make_element(tag))
    document.set("body", body)
    document.set("documentElement", make_element("html"))
    document.set("scripts", [])
    document.set("title", "Log in | OpenAI")
    document.set("referrer", "")
    document.set("cookie", "")
    document.set("visibilityState", "visible")
    document.set("hidden", False)
    document.set("location", None)  # set to window.location below

    # ---- navigator ----
    navigator = JSObject({
        "userAgent": ua,
        "vendor": "Google Inc.",
        "platform": p.get("platform", "Win32"),
        "language": "en-US",
        "languages": ["en-US", "en"],
        "deviceMemory": p.get("deviceMemory", 8),
        "hardwareConcurrency": p.get("hardwareConcurrency", 8),
        "maxTouchPoints": p.get("maxTouchPoints", 0),
        "onLine": True,
        "cookieEnabled": True,
        "webdriver": False,
        "pdfViewerEnabled": True,
        "doNotTrack": None,
    })

    # ---- screen ----
    sw = p.get("screenWidth", 1920); sh = p.get("screenHeight", 1080)
    screen = JSObject({
        "width": sw, "height": sh,
        "availWidth": sw, "availHeight": p.get("availHeight", sh - 40),
        "availLeft": 0, "availTop": 0,
        "colorDepth": 24, "pixelDepth": 24,
        "orientation": JSObject({"type": "landscape-primary", "angle": 0}),
    })

    # ---- performance ----
    t0 = time.time() * 1000.0
    origin = t0 - random.uniform(20000, 45000)
    class Perf:
        def now(self):
            return round(time.time() * 1000.0 - origin, 1)
    perf_now_holder = {"v": None}
    performance = JSObject({
        "timeOrigin": origin,
        "memory": JSObject({
            "jsHeapSizeLimit": 4294705152,
            "totalJSHeapSize": p.get("totalJSHeapSize", 35000000),
            "usedJSHeapSize": p.get("usedJSHeapSize", 21000000),
        }),
    })
    def _now(*a):
        return round(time.time() * 1000.0 - origin, 1)
    performance.set("now", _now)

    # ---- storage ----
    class Storage(JSObject):
        def __init__(self):
            super().__init__()
            self._store = dict(cf.get("localStorage", {}))
        def get(self, k):
            k = str(k)
            if k == "length": return len(self._store)
            if k == "getItem": return lambda key: self._store.get(str(key), None)
            if k == "setItem":
                def si(key, val): self._store[str(key)] = js_str(val)
                return si
            if k == "removeItem":
                def ri(key): self._store.pop(str(key), None)
                return ri
            if k == "key":
                keys = list(self._store.keys())
                return lambda i: keys[int(i)] if 0 <= int(i) < len(keys) else None
            if k == "clear": return lambda: self._store.clear()
            return super().get(k)
    localStorage = Storage()

    # ---- Reflect / Object / Math / JSON built-ins ----
    def reflect_set(target, key, value):
        if isinstance(target, JSObject): target.set(key, value); return True
        return False
    Reflect = JSObject({"set": reflect_set,
                        "get": lambda t, k: (t.get(k) if isinstance(t, JSObject) else UNDEF),
                        "has": lambda t, k: (t.has(k) if isinstance(t, JSObject) else False),
                        "ownKeys": lambda t: (t.keys() if isinstance(t, JSObject) else [])})
    def obj_create(proto=None):
        return JSObject()
    def obj_keys(o):
        if isinstance(o, JSObject): return o.keys()
        if isinstance(o, dict): return list(o.keys())
        if isinstance(o, list): return [str(i) for i in range(len(o))]
        return []
    def obj_values(o):
        if isinstance(o, JSObject): return [v for _, v in o.entries()]
        return []
    def obj_entries(o):
        if isinstance(o, JSObject): return [[k, v] for k, v in o.entries()]
        return []
    def obj_assign(t, *srcs):
        for sc in srcs:
            if isinstance(sc, JSObject):
                for k, v in sc.entries(): t.set(k, v)
        return t
    Object = JSObject({"create": obj_create, "keys": obj_keys, "values": obj_values,
                       "entries": obj_entries, "assign": obj_assign,
                       "getPrototypeOf": lambda o: None,
                       "getOwnPropertyNames": obj_keys})
    Math = JSObject({
        "random": lambda: random.random(),
        "floor": lambda x: math.floor(js_number(x)),
        "ceil": lambda x: math.ceil(js_number(x)),
        "round": lambda x: math.floor(js_number(x) + 0.5),
        "abs": lambda x: abs(js_number(x)),
        "max": lambda *a: max(js_number(x) for x in a) if a else float("-inf"),
        "min": lambda *a: min(js_number(x) for x in a) if a else float("inf"),
        "pow": lambda a, b: js_number(a) ** js_number(b),
        "sqrt": lambda x: math.sqrt(js_number(x)),
        "PI": math.pi, "E": math.e,
    })

    # ---- __reactRouterContext (Cloudflare geo from SSR) ----
    clientBootstrap = JSObject({
        "cfConnectingIp": cf.get("cfConnectingIp", ""),
        "cfIpCity": cf.get("cfIpCity", ""),
        "userRegion": cf.get("userRegion", ""),
        "cfIpLatitude": cf.get("cfIpLatitude", ""),
        "cfIpLongitude": cf.get("cfIpLongitude", ""),
        "cfIpCountry": cf.get("cfIpCountry", ""),
        "cfRay": cf.get("cfRay", ""),
    })
    reactRouterContext = JSObject({
        "state": JSObject({
            "loaderData": JSObject({
                "root": JSObject({"clientBootstrap": clientBootstrap})
            })
        })
    })

    location = JSObject({
        "href": cf.get("href", "https://auth.openai.com/log-in-or-create-account"),
        "origin": "https://auth.openai.com",
        "protocol": "https:",
        "host": "auth.openai.com",
        "hostname": "auth.openai.com",
        "pathname": "/log-in-or-create-account",
        "search": "", "hash": "",
    })

    window = JSObject()
    window.set("navigator", navigator)
    window.set("screen", screen)
    window.set("performance", performance)
    window.set("document", document)
    window.set("localStorage", localStorage)
    window.set("sessionStorage", Storage())
    window.set("history", JSObject({"length": 2, "scrollRestoration": "auto", "state": None}))
    window.set("location", location)
    window.set("Reflect", Reflect)
    window.set("Object", Object)
    window.set("Math", Math)
    window.set("__reactRouterContext", reactRouterContext)
    window.set("innerWidth", p.get("innerWidth", 1280))
    window.set("innerHeight", p.get("innerHeight", 720))
    window.set("outerWidth", sw)
    window.set("outerHeight", sh)
    window.set("devicePixelRatio", 1)
    window.set("name", "")
    window.set("closed", False)
    window.set("self", window)
    window.set("top", window)
    window.set("window", window)
    window.set("origin", "https://auth.openai.com")
    document.set("location", location)
    return window


# ============ High-level entry ============
def _profile_env(profile):
    """Derive VM browser params from a BrowserProfile-like object."""
    ua = getattr(profile, "user_agent", "") or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")
    plat_ch = str(getattr(profile, "sec_ch_ua_platform", '"Windows"') or "").strip('"').lower()
    if "mac" in plat_ch:
        p = {"platform": "MacIntel", "screenWidth": 1728, "screenHeight": 1117,
             "availHeight": 1080, "deviceMemory": 8, "hardwareConcurrency": 8, "innerWidth": 1280, "innerHeight": 720}
    else:
        p = {"platform": "Win32", "screenWidth": 1920, "screenHeight": 1080,
             "availHeight": 1040, "deviceMemory": 8, "hardwareConcurrency": 8, "innerWidth": 1280, "innerHeight": 720}
    return ua, p


def generate_t(response, reqtok, cf=None, profile=None):
    """Compute the sentinel `t` field. Returns "" on any failure (never raises)."""
    try:
        turnstile = (response or {}).get("turnstile") or {}
        dx = turnstile.get("dx")
        if not turnstile.get("required") or not dx:
            return ""
        ua, p = _profile_env(profile)
        window = make_window(cf=cf or {}, ua=ua, profile=p)
        program = json.loads(js_xor(js_atob(dx), reqtok))
        vm = SentinelVM(window, reqtok)
        return vm.run(program) or ""
    except Exception:
        return ""
