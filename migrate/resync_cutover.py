# -*- coding: utf-8 -*-
"""Cutover 最终增量重跑:老 auth_keys → image2api users。
- 新用户:INSERT 全行
- 已有用户:UPDATE 余额/密码/状态(老库为准,覆盖快照后漂移)
邮箱/用户名/邀请码等不动,只按 id 冲突更新会变的字段。
用法:python resync_cutover.py <app.db> [--domain go2api.local] [--out resync.sql]
"""
import sqlite3, json, argparse, hashlib, string

ap = argparse.ArgumentParser()
ap.add_argument("db")
ap.add_argument("--domain", default="go2api.local")
ap.add_argument("--out", default="resync.sql")
args = ap.parse_args()


def sqlstr(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def ts(v):
    v = (v or "").strip()
    return sqlstr(v) if v else "NOW()"


def invite_code(uid, seen):
    base = hashlib.sha256(("inv:" + str(uid)).encode()).hexdigest().upper()
    ab = string.ascii_uppercase + string.digits
    code = "".join(ab[int(base[i:i + 2], 16) % len(ab)] for i in range(0, 16, 2))
    n, orig = 0, code
    while code in seen:
        n += 1
        code = (orig[:6] + format(n, "02d"))[:8]
    seen.add(code)
    return code


db = sqlite3.connect(args.db)
db.row_factory = sqlite3.Row
rows = list(db.execute("SELECT id, data FROM auth_keys"))
db.close()

users, keys = [], []
seen_names, seen_emails, seen_codes = set(), set(), set()
n_user = n_key = 0
for r in rows:
    try:
        d = json.loads(r["data"]) if r["data"] else {}
    except Exception:
        continue
    if (d.get("role") or "user").lower() == "admin":
        continue
    src_id = str(d.get("id") or r["id"])
    uid = ("u-" + src_id)[:32]
    username = (d.get("username") or "").strip()
    name_l = username.lower()
    if username and name_l in seen_names:
        continue
    if username:
        seen_names.add(name_l)
    email = (username + "@" + args.domain) if username else ("user-" + src_id + "@" + args.domain)
    if email.lower() in seen_emails:
        email = "user-" + src_id + "@" + args.domain
    seen_emails.add(email.lower())
    pwh = (d.get("password_hash") or "").strip()
    password_hash = ("sha256$$" + pwh) if pwh else ""
    unlimited = bool(d.get("unlimited"))
    quota = int(d.get("quota") or 0)
    used = int(d.get("used") or 0)
    credits = 1e9 if unlimited else max(0, quota - used)
    status = "active" if d.get("enabled", True) else "disabled"
    code = invite_code(src_id, seen_codes)
    created = d.get("created_at")
    # INSERT 全行;冲突(已有用户)只更新会漂移的字段:余额/密码/状态
    users.append(
        "INSERT INTO users (id,email,name,password_hash,role,status,credits,"
        "concurrency_group_id,recharge_total,invite_code,invite_reward_done,"
        "checkin_streak,generation_count,banned_word_hits,created_at,updated_at) VALUES ("
        f"{sqlstr(uid)},{sqlstr(email)},{sqlstr(username)},{sqlstr(password_hash)},"
        f"'user','{status}',{credits},'cg-default',0,{sqlstr(code)},false,0,0,0,{ts(created)},NOW()) "
        "ON CONFLICT (id) DO UPDATE SET credits=EXCLUDED.credits, "
        "password_hash=EXCLUDED.password_hash, status=EXCLUDED.status, updated_at=NOW();"
    )
    n_user += 1
    kh = (d.get("key_hash") or "").strip()
    if kh:
        raw = (d.get("raw_key") or "").strip()
        preview = (raw[:8] + "•" * 12 + raw[-6:]) if len(raw) >= 14 else raw
        keys.append(
            "INSERT INTO api_keys (id,user_id,name,key_preview,key_hash,created_at) VALUES ("
            f"{sqlstr('k-' + src_id)},{sqlstr(uid)},'default',{sqlstr(preview)},"
            f"{sqlstr('sha256:' + kh)},{ts(created)}) ON CONFLICT DO NOTHING;"
        )
        n_key += 1

with open(args.out, "w", encoding="utf-8", newline="\n") as f:
    f.write("BEGIN;\n")
    f.write("\n".join(users))
    f.write("\n")
    f.write("\n".join(keys))
    f.write("\nCOMMIT;\n")
print(f"重跑:{n_user} 用户(UPSERT余额), {n_key} api_key -> {args.out}")
