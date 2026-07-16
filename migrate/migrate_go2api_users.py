# -*- coding: utf-8 -*-
"""ChatGPT2API(go2api) 用户 → image2api 用户数据迁移。

读 go2api 的 sqlite `auth_keys`(id, data(JSON), updated_at;data 内含
username/password_hash/quota/used/unlimited/key_hash/raw_key/created_at/…),
生成 image2api Postgres 的 users + api_keys INSERT SQL。

无损要点(见分析):
- 密码:老 `hashlib.sha256(pwd).hexdigest()` → 存 `sha256$$<hex>`(空盐),
  image2api 的 VerifyPassword 现有 `sha256$salt$hash` 分支直接可验(sha256(""+pwd)==sha256(pwd))。
- API key:老 key_hash=hex(sha256(raw)) → 存 `sha256:<hex>`,image2api 查库即命中,用户原 key 不断连。
- 额度:一次性 quota/used/unlimited → float credits;剩余=max(0,quota-used)*K;unlimited→极大值。

用法:python migrate_go2api_users.py <app.db路径> [--domain go2api.local] [--k 1.0] [--out migration.sql]
再:docker exec -i image2api-postgres-1 psql -U postgres -d <db> < migration.sql
"""
import sqlite3, json, sys, argparse, random, string, hashlib

ap = argparse.ArgumentParser()
ap.add_argument("db")
ap.add_argument("--domain", default="go2api.local", help="合成邮箱占位域名")
ap.add_argument("--k", type=float, default=1.0, help="额度倍率(剩余额度→credits)")
ap.add_argument("--unlimited-credits", type=float, default=1e9)
ap.add_argument("--out", default="migration.sql")
args = ap.parse_args()


def sqlstr(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def ts(v):
    v = (v or "").strip()
    return sqlstr(v) if v else "NOW()"


def ts_null(v):
    v = (v or "").strip()
    return sqlstr(v) if v else "NULL"


# 稳定的 invite_code:由 user id 派生,保证幂等且唯一(不依赖随机数)
def invite_code(uid, seen):
    base = hashlib.sha256(("inv:" + str(uid)).encode()).hexdigest().upper()
    alphabet = string.ascii_uppercase + string.digits
    code = "".join(alphabet[int(base[i:i + 2], 16) % len(alphabet)] for i in range(0, 16, 2))
    n = 0
    orig = code
    while code in seen:
        n += 1
        code = (orig[:6] + format(n, "02d"))[:8]
    seen.add(code)
    return code


db = sqlite3.connect(args.db)
db.row_factory = sqlite3.Row
rows = list(db.execute("SELECT id, data FROM auth_keys"))
db.close()

users_sql, keys_sql = [], []
seen_names, seen_emails, seen_codes = set(), set(), set()
stats = {"total": len(rows), "migrated": 0, "skip_admin": 0, "skip_dupname": 0, "with_key": 0, "no_pwd": 0}

for r in rows:
    try:
        d = json.loads(r["data"]) if r["data"] else {}
    except Exception:
        continue
    role = (d.get("role") or "user").lower()
    if role == "admin":
        stats["skip_admin"] += 1
        continue
    src_id = str(d.get("id") or r["id"])
    uid = ("u-" + src_id)[:32]
    username = (d.get("username") or "").strip()
    name_l = username.lower()
    if username and name_l in seen_names:
        stats["skip_dupname"] += 1
        continue
    if username:
        seen_names.add(name_l)

    email = (username + "@" + args.domain) if username else ("user-" + src_id + "@" + args.domain)
    if email.lower() in seen_emails:
        email = "user-" + src_id + "@" + args.domain
    seen_emails.add(email.lower())

    pwh = (d.get("password_hash") or "").strip()
    password_hash = ("sha256$$" + pwh) if pwh else ""
    if not pwh:
        stats["no_pwd"] += 1

    unlimited = bool(d.get("unlimited"))
    quota = int(d.get("quota") or 0)
    used = int(d.get("used") or 0)
    credits = args.unlimited_credits if unlimited else max(0, quota - used) * args.k
    status = "active" if d.get("enabled", True) else "disabled"
    code = invite_code(src_id, seen_codes)
    created = d.get("created_at")

    users_sql.append(
        "INSERT INTO users (id,email,name,password_hash,role,status,credits,"
        "concurrency_group_id,recharge_total,invite_code,invite_reward_done,"
        "checkin_streak,generation_count,banned_word_hits,created_at,updated_at) VALUES ("
        f"{sqlstr(uid)},{sqlstr(email)},{sqlstr(username)},{sqlstr(password_hash)},"
        f"'user','{status}',{credits},'cg-default',0,{sqlstr(code)},false,0,0,0,"
        f"{ts(created)},NOW()) ON CONFLICT DO NOTHING;"
    )
    stats["migrated"] += 1

    kh = (d.get("key_hash") or "").strip()
    if kh:
        raw = (d.get("raw_key") or "").strip()
        # 掩码:前8 + 12圆点 + 后6,如 sk-atp3t••••••••••••-XCDpT(前端直接展示 key_preview)
        preview = (raw[:8] + "•" * 12 + raw[-6:]) if len(raw) >= 14 else raw
        keys_sql.append(
            "INSERT INTO api_keys (id,user_id,name,key_preview,key_hash,created_at,last_used_at) VALUES ("
            f"{sqlstr('k-' + src_id)},{sqlstr(uid)},'default',{sqlstr(preview)},"
            f"{sqlstr('sha256:' + kh)},{ts(created)},{ts_null(d.get('last_used_at'))}) ON CONFLICT DO NOTHING;"
        )
        stats["with_key"] += 1

with open(args.out, "w", encoding="utf-8", newline="\n") as f:
    f.write("-- go2api → image2api 用户迁移\n")
    f.write(f"-- domain={args.domain} k={args.k} unlimited_credits={args.unlimited_credits}\n")
    f.write("BEGIN;\n\n")
    f.write("\n".join(users_sql))
    f.write("\n\n")
    f.write("\n".join(keys_sql))
    f.write("\n\nCOMMIT;\n")

print("统计:", stats)
print("已写:", args.out, f"({len(users_sql)} 用户, {len(keys_sql)} api_key)")
