from __future__ import annotations

import argparse
import secrets

from .auth import hash_password, invalidate_sessions
from .db import create_db_and_tables, new_session
from .models import AdminCredential


def main() -> None:
    parser = argparse.ArgumentParser(description="TSBot 管理员账号本地恢复工具")
    subparsers = parser.add_subparsers(dest="command", required=True)
    reset = subparsers.add_parser("reset-password", help="重置管理员密码并强制下次登录改密")
    reset.add_argument("--password", help="指定临时密码；省略时自动生成")
    args = parser.parse_args()

    create_db_and_tables()
    session = new_session()
    try:
        credential = session.get(AdminCredential, 1)
        if credential is None:
            raise SystemExit("管理员账号尚未初始化，请先启动一次后端")
        temporary_password = (args.password or "").strip() or secrets.token_urlsafe(18)
        credential.password_hash = hash_password(temporary_password)
        credential.must_change_password = True
        credential.password_version += 1
        session.commit()
        invalidate_sessions(session)
    finally:
        session.close()
    print(f"管理员临时密码：{temporary_password}")
    print("所有旧会话已失效，下次登录必须修改密码。")


if __name__ == "__main__":
    main()
