"""Outlook / Hotmail 收件模块（OAuth2 refresh_token + IMAP XOAUTH2）。

导入的「卡密」邮箱通常是 Microsoft 个人账号，格式为::

    邮箱----密码----client_id----refresh_token

收件流程：用 ``refresh_token`` + ``client_id`` 向微软换取短期 ``access_token``
（scope 含 IMAP），再用 XOAUTH2 登录 ``outlook.office365.com`` 拉邮件。

plus 别名（``main+tag@domain``）登录时自动剥成主箱，因此别名共享主箱凭据即可收码。
仅依赖标准库（urllib / imaplib / email）；走 socks5 代理时用自包含隧道。

移植自 GPT_PLUS/mailfetch.py，适配注册引擎的消息结构。
"""

from __future__ import annotations

import email
import html as _html
import imaplib
import json
import re
import socket
import ssl as _ssl
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime

TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
IMAP_HOST = "outlook.office365.com"
IMAP_PORT = 993
SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"
DEFAULT_FOLDERS = ("INBOX", "Junk")


class MailError(Exception):
    """收件过程中可向用户展示的错误。"""


def _socks5_tunnel(proxy_url: str, dst_host: str, dst_port: int, timeout: float = 30.0):
    """经 socks5 代理建立到 dst 的原始 TCP 连接（自包含，无第三方依赖）。"""
    u = urllib.parse.urlparse(proxy_url)
    ph, pp = u.hostname, u.port or 1080
    user = urllib.parse.unquote(u.username) if u.username else None
    pwd = urllib.parse.unquote(u.password) if u.password else None
    if not ph:
        raise MailError("代理地址不合法")
    s = socket.create_connection((ph, pp), timeout=timeout)
    try:
        s.sendall(b"\x05\x02\x00\x02" if user is not None else b"\x05\x01\x00")
        r = s.recv(2)
        if len(r) < 2 or r[0] != 0x05:
            raise MailError("SOCKS5 握手失败")
        if r[1] == 0x02:
            if user is None:
                raise MailError("SOCKS5 代理要求认证，但URL未带账号密码")
            ub, pb = user.encode(), (pwd or "").encode()
            s.sendall(b"\x01" + bytes([len(ub)]) + ub + bytes([len(pb)]) + pb)
            ar = s.recv(2)
            if len(ar) < 2 or ar[1] != 0x00:
                raise MailError("SOCKS5 认证失败（账号/密码错误）")
        elif r[1] != 0x00:
            raise MailError(f"SOCKS5 无可用认证方式（{r[1]}）")
        hb = dst_host.encode()
        s.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + struct.pack(">H", dst_port))
        rep = s.recv(4)
        if len(rep) < 4 or rep[1] != 0x00:
            raise MailError(f"SOCKS5 连接目标失败（rep={rep[1] if len(rep) > 1 else '?'}）")
        atyp = rep[3]
        if atyp == 0x01:
            s.recv(4)
        elif atyp == 0x03:
            s.recv(s.recv(1)[0])
        elif atyp == 0x04:
            s.recv(16)
        s.recv(2)
        return s
    except Exception:
        s.close()
        raise


def _dechunk(data: bytes) -> bytes:
    out = b""
    while data:
        nl = data.find(b"\r\n")
        if nl < 0:
            break
        try:
            size = int(data[:nl], 16)
        except ValueError:
            break
        if size == 0:
            break
        start = nl + 2
        out += data[start:start + size]
        data = data[start + size + 2:]
    return out


def _post_form_via_socks(proxy_url: str, url: str, form: dict, timeout: float = 20.0) -> tuple[int, bytes]:
    """经 socks5 隧道 + 标准库 ssl 发 HTTPS POST（表单编码），避免 curl_cffi 的
    SOCKS+BoringSSL 偶发 ``invalid library`` TLS 错误。返回 (status, body_bytes)。"""
    u = urllib.parse.urlparse(url)
    host = u.hostname or ""
    path = u.path or "/"
    body = urllib.parse.urlencode(form).encode()
    raw = _socks5_tunnel(proxy_url, host, 443, timeout=timeout)
    ctx = _ssl.create_default_context()
    s = ctx.wrap_socket(raw, server_hostname=host)
    s.settimeout(timeout)
    try:
        req = (
            f"POST {path} HTTP/1.1\r\nHost: {host}\r\n"
            "Content-Type: application/x-www-form-urlencoded\r\n"
            "Accept: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        ).encode() + body
        s.sendall(req)
        buf = b""
        while True:
            try:
                chunk = s.recv(8192)
            except Exception:
                break
            if not chunk:
                break
            buf += chunk
    finally:
        try:
            s.close()
        except Exception:
            pass
    head, _, payload = buf.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    try:
        status = int(lines[0].split(b" ")[1])
    except (IndexError, ValueError):
        status = 0
    hdrs = {}
    for ln in lines[1:]:
        if b":" in ln:
            k, v = ln.split(b":", 1)
            hdrs[k.strip().lower()] = v.strip().lower()
    if hdrs.get(b"transfer-encoding") == b"chunked":
        payload = _dechunk(payload)
    return status, payload


class _ProxyIMAP4SSL(imaplib.IMAP4_SSL):
    """经 socks5 代理连接的 IMAP4_SSL（覆盖底层 socket 创建）。"""

    def __init__(self, host: str, port: int, proxy_url: str, timeout: float = 30.0):
        self._proxy_url = proxy_url
        self._proxy_timeout = timeout
        super().__init__(host, port, timeout=timeout)

    def _create_socket(self, timeout=None):
        raw = _socks5_tunnel(self._proxy_url, self.host, self.port, timeout=self._proxy_timeout)
        ctx = _ssl.create_default_context()
        return ctx.wrap_socket(raw, server_hostname=self.host)


def _open_direct_imap(attempts: int = 3):
    """Open Outlook IMAP directly, retrying transient DNS/TLS edge failures."""
    last_error: Exception | None = None
    for attempt in range(max(1, attempts)):
        try:
            try:
                return imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, timeout=30)
            except TypeError:
                socket.setdefaulttimeout(30)
                return imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.5 * (attempt + 1))
    assert last_error is not None
    raise last_error


def _open_imap(proxy: str | None = None):
    """Use the configured proxy when possible, then fall back to direct IMAP.

    Registration proxies commonly support HTTPS only and may accept the SOCKS
    tunnel for port 993 before closing during TLS negotiation. Microsoft token
    exchange and the OpenAI registration flow still use the configured proxy;
    only mailbox retrieval falls back to the node's direct connection.
    """
    proxy_error: Exception | None = None
    if proxy:
        try:
            return _ProxyIMAP4SSL(IMAP_HOST, IMAP_PORT, proxy, timeout=30)
        except Exception as exc:
            proxy_error = exc
    try:
        return _open_direct_imap()
    except Exception as direct_error:
        if proxy_error is not None:
            raise MailError(
                f"代理 IMAP 失败且直连回退失败：{direct_error}"
            ) from direct_error
        raise


def imap_login_account(account: str) -> str:
    """plus 别名 ``main+tag@domain`` -> 主箱 ``main@domain`` 用于 IMAP 登录。"""
    account = (account or "").strip()
    local, sep, domain = account.partition("@")
    if sep and "+" in local:
        return f"{local.split('+', 1)[0]}@{domain}"
    return account


def get_access_token(client_id: str, refresh_token: str, timeout: int = 20,
                     proxy: str | None = None) -> str:
    if not client_id or not refresh_token:
        raise MailError("该邮箱缺少 client_id 或 refresh_token，无法收件")
    form = {
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": SCOPE,
    }
    if proxy:
        # 走代理换令牌：自包含 socks5 隧道 + 标准库 ssl（避开 curl_cffi 的 SOCKS+TLS 偶发错误）
        try:
            status, raw = _post_form_via_socks(proxy, TOKEN_ENDPOINT, form, timeout=timeout)
        except MailError:
            raise
        except Exception as exc:
            raise MailError(f"连接微软服务器失败（代理）：{exc}")
        text = raw.decode("utf-8", "replace")
        if status != 200:
            detail = ""
            try:
                payload = json.loads(text)
                detail = payload.get("error_description") or payload.get("error") or ""
            except Exception:
                pass
            raise MailError(f"获取访问令牌失败（{status}）：{detail[:200] or '令牌可能已失效'}")
        try:
            token = (json.loads(text) or {}).get("access_token")
        except Exception:
            token = None
        if not token:
            raise MailError("微软未返回 access_token，refresh_token 可能已过期")
        return token
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_ENDPOINT, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("error_description") or payload.get("error") or ""
        except Exception:
            pass
        raise MailError(f"获取访问令牌失败（{exc.code}）：{detail[:200] or '令牌可能已失效'}")
    except urllib.error.URLError as exc:
        raise MailError(f"连接微软服务器失败：{exc.reason}")
    token = body.get("access_token")
    if not token:
        raise MailError("微软未返回 access_token，refresh_token 可能已过期")
    return token


def _decode(value) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return str(value)


def _extract_parts(msg: email.message.Message) -> tuple[str, str]:
    """返回 (text, html)。"""
    text_part = ""
    html_part = ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp:
                continue
            try:
                payload = part.get_payload(decode=True)
            except Exception:
                continue
            if payload is None:
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                chunk = payload.decode(charset, errors="replace")
            except (LookupError, TypeError):
                chunk = payload.decode("utf-8", errors="replace")
            if ctype == "text/plain" and not text_part:
                text_part = chunk
            elif ctype == "text/html" and not html_part:
                html_part = chunk
    else:
        payload = msg.get_payload(decode=True)
        if payload is not None:
            charset = msg.get_content_charset() or "utf-8"
            try:
                chunk = payload.decode(charset, errors="replace")
            except (LookupError, TypeError):
                chunk = payload.decode("utf-8", errors="replace")
            if msg.get_content_type() == "text/html":
                html_part = chunk
            else:
                text_part = chunk
    return text_part.strip(), html_part.strip()


def _parse_message(raw: bytes) -> dict:
    msg = email.message_from_bytes(raw)
    date_raw = msg.get("Date", "")
    ts = 0.0
    iso = date_raw
    if date_raw:
        try:
            dt = parsedate_to_datetime(date_raw)
            ts = dt.timestamp()
            iso = dt.isoformat()
        except Exception:
            pass
    text, html = _extract_parts(msg)
    return {
        "message_id": _decode(msg.get("Message-ID", "")),
        "subject": _decode(msg.get("Subject", "")),
        "from": _decode(msg.get("From", "")),
        "to": _decode(msg.get("To", "")),
        "date": iso,
        "timestamp": ts,
        "text": text,
        "html": html,
    }


def fetch_inbox(account: str, client_id: str, refresh_token: str, limit: int = 10,
                folders: tuple[str, ...] = DEFAULT_FOLDERS,
                proxy: str | None = None) -> list[dict]:
    """登录邮箱并返回最近 ``limit`` 封邮件（按时间倒序）。"""
    token = get_access_token(client_id, refresh_token, proxy=proxy)
    login_account = imap_login_account(account)
    auth_string = f"user={login_account}\x01auth=Bearer {token}\x01\x01"

    try:
        imap = _open_imap(proxy)
    except MailError:
        raise
    except Exception as exc:
        raise MailError(f"连接 IMAP 服务器失败：{exc}")

    try:
        try:
            imap.authenticate("XOAUTH2", lambda _: auth_string.encode("utf-8"))
        except imaplib.IMAP4.error as exc:
            raise MailError(f"IMAP 登录失败：{str(exc)[:200] or '令牌无效或未开启 IMAP'}")

        collected: list[tuple[float, dict]] = []
        for folder in folders:
            typ, _ = imap.select(f'"{folder}"', readonly=True)
            if typ != "OK":
                continue
            typ, data = imap.search(None, "ALL")
            if typ != "OK" or not data or not data[0]:
                continue
            ids = data[0].split()
            recent = ids[-limit:]
            if not recent:
                continue
            typ, msg_data = imap.fetch(b",".join(recent), "(RFC822)")
            if typ != "OK" or not msg_data:
                continue
            for part in msg_data:
                if not (isinstance(part, tuple) and len(part) >= 2 and part[1]):
                    continue
                parsed = _parse_message(part[1])
                parsed["folder"] = folder
                collected.append((parsed.get("timestamp") or 0.0, parsed))
        collected.sort(key=lambda x: x[0], reverse=True)
        return [m for _, m in collected[:limit]]
    finally:
        try:
            imap.logout()
        except Exception:
            pass
