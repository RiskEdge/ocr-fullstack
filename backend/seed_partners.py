"""
Seed partners, link existing companies to partners, and create admin users.

Reads from seed_data.json (or a path passed as a CLI argument).

JSON structure:
  {
    "partners": [
      { "name": "...", "contact_email": "...", "clients": ["CompanyName", ...] }
    ],
    "users": [
      { "username": "...", "password": "...", "role": "superadmin" },
      { "username": "...", "password": "...", "role": "partner_admin", "partner": "PartnerName" },
      { "username": "...", "password": "...", "role": "client_admin",  "company": "CompanyName" }
    ]
  }

Run:
    python seed_partners.py               # uses seed_data.json in the same dir
    python seed_partners.py path/to/data.json
"""

import json
import sys
import os
import dotenv
from passlib.context import CryptContext

dotenv.load_dotenv()

from app.db import get_supabase

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__truncate_error=False)


def seed(path: str = "seed_data.json") -> None:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    db = get_supabase()

    # --- Build lookup maps for existing companies and partners ---
    company_map: dict[str, str] = {
        r["name"]: r["id"]
        for r in db.table("companies").select("id, name").execute().data
    }

    # --- Seed / upsert partners ---
    partner_map: dict[str, str] = {}
    for p in data.get("partners", []):
        result = db.table("partners").upsert(
            {"name": p["name"], "contact_email": p.get("contact_email")},
            on_conflict="name",
        ).execute()
        partner_id: str = result.data[0]["id"]
        partner_map[p["name"]] = partner_id
        print(f"  partner: {p['name']}")

        # Link client companies to this partner
        for client_name in p.get("clients", []):
            cid = company_map.get(client_name)
            if not cid:
                print(f"    SKIP client '{client_name}': company not found in companies table")
                continue
            db.table("companies").update({"partner_id": partner_id}).eq("id", cid).execute()
            print(f"    → linked: {client_name}")

    # --- Seed users ---
    for u in data.get("users", []):
        role = u.get("role", "user")
        record: dict = {
            "username":     u["username"],
            "password":     _pwd.hash(u["password"][:72]),
            "role":         role,
            "is_superadmin": role == "superadmin",
        }

        if role in ("client_admin", "user"):
            cid = company_map.get(u.get("company", ""))
            if not cid:
                print(f"  SKIP user '{u['username']}': company '{u.get('company')}' not found")
                continue
            record["company_id"] = cid

        elif role == "partner_admin":
            pid = partner_map.get(u.get("partner", ""))
            if not pid:
                # Partner might already exist in DB but not in this run's partner_map
                existing = (
                    db.table("partners")
                    .select("id")
                    .eq("name", u.get("partner", ""))
                    .execute()
                )
                if existing.data:
                    pid = existing.data[0]["id"]
                    partner_map[u["partner"]] = pid
                else:
                    print(f"  SKIP user '{u['username']}': partner '{u.get('partner')}' not found")
                    continue
            record["partner_id"] = pid

        db.table("users").upsert(record, on_conflict="username").execute()
        print(f"  user: {u['username']} [{role}]")

    print("\nDone.")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "seed_data.json"
    seed(path)
