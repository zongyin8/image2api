# -*- coding: utf-8 -*-
"""go2api credit_codes(旧兑换码) -> image2api cdk_codes。
未用码 status=active(可继续兑),已用码 status=redeemed(仅存档,不会被再兑)。
Code 存 code_norm(大写无横杠);image2api 兑换时 TrimSpace+ToUpper,老码大小写皆可兑。
Amount = points(1:1,image2api Redeem 直接 AdjustCredits(amount),无倍率)。

用法:python migrate_cdk_codes.py <app.db> [--out cdk_codes.sql]
再:docker exec -i image2api-postgres-1 psql -U postgres -d vivid_ai < cdk_codes.sql
"""
import sqlite3, json, sys, argparse

ap = argparse.ArgumentParser()
ap.add_argument("db")
ap.add_argument("--out", default="cdk_codes.sql")
args = ap.parse_args()


def sqlstr(v):
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


db = sqlite3.connect(args.db)
rows = db.execute("SELECT code_norm, data, updated_at FROM credit_codes").fetchall()
db.close()

out = open(args.out, "w", encoding="utf-8", newline="\n")
out.write("BEGIN;\n")
n = active = redeemed = 0
for code_norm, data, up in rows:
    try:
        d = json.loads(data) if data else {}
    except Exception:
        d = {}
    code = (code_norm or d.get("code") or "").strip().upper()
    if not code:
        continue
    code = code[:32]
    amount = int(d.get("points") or 0)
    used = bool(d.get("used"))
    status = "redeemed" if used else "active"
    batch = (str(d.get("batch") or ""))[:32]
    rb = None
    if used and d.get("used_by"):
        rb = ("u-" + str(d.get("used_by")))[:32]
    ra = d.get("used_at") if used else None
    created = d.get("created_at") or up
    updated = up or created
    out.write(
        "INSERT INTO cdk_codes (code,amount,status,type,batch_id,note,redeemed_by,redeemed_at,created_at,updated_at) VALUES ("
        f"{sqlstr(code)},{amount},{sqlstr(status)},'normal',{sqlstr(batch)},'迁移自go2api',"
        f"{sqlstr(rb)},{sqlstr(ra)},{sqlstr(created)},{sqlstr(updated)}) "
        "ON CONFLICT (code) DO NOTHING;\n"
    )
    n += 1
    if used:
        redeemed += 1
    else:
        active += 1
out.write("COMMIT;\n")
out.close()
print(f"兑换码迁移:共{n} 可兑(active){active} 已用(redeemed){redeemed} -> {args.out}")
