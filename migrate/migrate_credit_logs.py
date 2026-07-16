# -*- coding: utf-8 -*-
"""go2api credit_history 的「入账」记录 → image2api credit_logs。
只迁入账(积分增加):admin_recharge/redeem/register_gift/admin_adjust,change_amount>0。
出图扣费(generate)/退款(refund) 不迁(扣费在生成日志里)。

用法:python migrate_credit_logs.py <app.db> [--out credit_logs.sql]
再:docker exec -i image2api-postgres-1 psql -U postgres -d vivid_ai < credit_logs.sql
"""
import sqlite3, json, sys, argparse

ap = argparse.ArgumentParser()
ap.add_argument("db")
ap.add_argument("--out", default="credit_logs.sql")
args = ap.parse_args()

TYPE_MAP = {
    "admin_recharge": "recharge",
    "redeem": "redeem",
    "register_gift": "gift",
    "admin_adjust": "admin",
}
TITLE_DEFAULT = {
    "recharge": "后台充值",
    "redeem": "兑换码到账",
    "gift": "注册赠送",
    "admin": "管理员调整",
}


def sqlstr(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


db = sqlite3.connect(args.db)
rows = db.execute(
    "SELECT id, user_id, created_at, type, change_amount, data FROM credit_history "
    "WHERE type IN ('admin_recharge','redeem','register_gift','admin_adjust') AND change_amount>0 "
    "ORDER BY created_at"
).fetchall()
db.close()

out = open(args.out, "w", encoding="utf-8", newline="\n")
out.write("BEGIN;\n")
n = 0
stats = {}
for src_id, user_id, created_at, typ, amount, data in rows:
    try:
        d = json.loads(data) if data else {}
    except Exception:
        d = {}
    t = TYPE_MAP.get(typ, "admin")
    uid = ("u-" + str(user_id))[:32]
    bal = d.get("balance_after")
    bal = float(bal) if bal is not None else 0
    title = (d.get("title") or TITLE_DEFAULT.get(t, "")).strip()
    ts = created_at or d.get("created_at")
    cid = "clm%09d" % n  # 全表唯一、≤32 字符即可
    out.write(
        "INSERT INTO credit_logs (id,user_id,type,amount,balance_after,title,created_at) VALUES ("
        f"{sqlstr(cid)},{sqlstr(uid)},{sqlstr(t)},{float(amount)},{bal},{sqlstr(title)},{sqlstr(ts)}) "
        "ON CONFLICT DO NOTHING;\n"
    )
    n += 1
    stats[t] = stats.get(t, 0) + 1
out.write("COMMIT;\n")
out.close()
print("入账记录迁移:", stats, "共", n, "条 →", args.out)
