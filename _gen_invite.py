"""生成邀请码 CLI 工具
用法:
  python _gen_invite.py              # 生成 1 个邀请码
  python _gen_invite.py 5            # 生成 5 个
  python _gen_invite.py 1 ADMIN      # 带前缀 ADMIN
  python _gen_invite.py 3 '' 7       # 生成 3 个，7 天后过期
"""
import sqlite3, secrets, sys
from datetime import datetime, timedelta

DB = 'pipeline.db'

def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    prefix = sys.argv[2] if len(sys.argv) > 2 else ''
    expire_days = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    db = sqlite3.connect(DB)
    cur = db.cursor()

    codes = []
    for _ in range(count):
        token = secrets.token_hex(8)
        code = f"{prefix}_{token}" if prefix else token
        expires = (datetime.now() + timedelta(days=expire_days)).strftime('%Y-%m-%d %H:%M:%S') if expire_days > 0 else None
        cur.execute(
            "INSERT INTO invite_codes(code, expires_at) VALUES(?, ?)",
            (code, expires)
        )
        codes.append(code)

    db.commit()
    db.close()

    print(f"[OK] Generated {len(codes)} invite code(s):")
    for c in codes:
        print(f"  {c}")
    if expire_days:
        print(f"  Valid for: {expire_days} day(s)")

if __name__ == '__main__':
    main()
