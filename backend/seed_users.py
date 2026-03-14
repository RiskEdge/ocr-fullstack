"""
Seed the Supabase `users` table from the MOCK_USERS env variable.
Companies must already exist in the `companies` table.

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

    # Fetch company name → id map from existing companies
    result = db.table("companies").select("id, name").execute()
    company_id_map = {row["name"]: row["id"] for row in result.data}

    for u in users:
        company_id = company_id_map.get(u["company"])
        if not company_id:
            print(f"  SKIP: company '{u['company']}' not found in companies table")
            continue

        db.table("users").upsert(
            {
                "username": u["username"],
                "password": hash_password(u["password"]),
                "company_id": company_id,
            },
            on_conflict="username",
        ).execute()
        print(f"  seeded: {u['username']} ({u['company']})")

    print(f"\nDone.")


if __name__ == "__main__":
    seed()
