"""
Seed the Supabase `users` table from the MOCK_USERS env variable.
Companies and partners must already exist in their respective tables.

Supported fields per user:
  username     — required
  password     — required
  role         — 'superadmin' | 'partner_admin' | 'client_admin' | 'user' (default: 'user')
  company      — required for client_admin / user
  partner      — required for partner_admin (name of the partner)

Run once (or whenever credentials change):
    python seed_users.py
"""

import os
import json
import dotenv
from passlib.context import CryptContext

dotenv.load_dotenv()

from app.db import get_supabase

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__truncate_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password[:72])


def seed():
    raw = os.environ.get("MOCK_USERS", "[]")
    users = json.loads(raw)

    if not users:
        print("MOCK_USERS is empty — nothing to seed.")
        return

    db = get_supabase()

    company_map = {row["name"]: row["id"] for row in db.table("companies").select("id, name").execute().data}
    partner_map = {row["name"]: row["id"] for row in db.table("partners").select("id, name").execute().data}

    for u in users:
        role = u.get("role", "user")
        is_superadmin = role == "superadmin"

        record: dict = {
            "username":     u["username"],
            "password":     hash_password(u["password"]),
            "role":         role,
            "is_superadmin": is_superadmin,
        }

        if role in ("client_admin", "user"):
            company_id = company_map.get(u.get("company", ""))
            if not company_id:
                print(f"  SKIP: company '{u.get('company')}' not found")
                continue
            record["company_id"] = company_id

        elif role == "partner_admin":
            partner_id = partner_map.get(u.get("partner", ""))
            if not partner_id:
                print(f"  SKIP: partner '{u.get('partner')}' not found")
                continue
            record["partner_id"] = partner_id

        db.table("users").upsert(record, on_conflict="username").execute()
        print(f"  seeded: {u['username']} [{role}]")

    print("\nDone.")


if __name__ == "__main__":
    seed()
