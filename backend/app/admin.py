"""
admin.py — Multi-level admin dashboard endpoints.

Three admin roles:
  superadmin    — Risk Edge global admin, sees everything
  partner_admin — partner org admin, sees only their client companies
  client_admin  — client company admin, sees only their own company
"""

import asyncio
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from passlib.context import CryptContext
from pydantic import BaseModel

from app.auth_utils import get_current_user, TokenData
from app.db import get_supabase

router = APIRouter()
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ---------------------------------------------------------------------------
# Role guards
# ---------------------------------------------------------------------------

def require_superadmin(current_user: TokenData = Depends(get_current_user)) -> TokenData:
    if current_user.role != "superadmin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Superadmin access required.")
    return current_user


def require_partner_or_above(current_user: TokenData = Depends(get_current_user)) -> TokenData:
    if current_user.role not in ("superadmin", "partner_admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Partner admin or above required.")
    return current_user


def require_partner_admin(current_user: TokenData = Depends(get_current_user)) -> TokenData:
    if current_user.role != "partner_admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Partner admin access required.")
    return current_user


def require_admin(current_user: TokenData = Depends(get_current_user)) -> TokenData:
    if current_user.role == "user":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required.")
    return current_user


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sum_ocr(rows: list) -> dict:
    return {
        "runs":     len(rows),
        "files":    sum(r.get("total_files", 0) for r in rows),
        "pages":    sum(r.get("total_pages", 0) for r in rows),
        "credits":  sum(r.get("credits_used", 0) for r in rows),
        "cost_usd": round(sum(r.get("total_cost_usd") or 0 for r in rows), 4),
        "last_at":  max((r["started_at"] for r in rows if r.get("started_at")), default=None),
    }


def _sum_val(rows: list) -> dict:
    return {
        "runs":         len(rows),
        "items":        sum(r.get("total_items", 0) for r in rows),
        "credits":      sum(r.get("credits_used", 0) for r in rows),
        "gemini_calls": sum(r.get("gemini_calls", 0) for r in rows),
        "last_at":      max((r["started_at"] for r in rows if r.get("started_at")), default=None),
    }


def _company_ids_for_user(db, current_user: TokenData) -> Optional[list]:
    """Returns list of company_ids in scope. None means all (superadmin)."""
    if current_user.role == "superadmin":
        return None
    if current_user.role == "partner_admin":
        res = db.table("companies").select("id").eq("partner_id", current_user.partner_id).execute()
        return [r["id"] for r in res.data] if res.data else []
    return [current_user.company_id]


# ---------------------------------------------------------------------------
# GET /v1/admin/overview  —  any admin role, scoped by role
# ---------------------------------------------------------------------------

@router.get("/v1/admin/overview")
async def admin_overview(current_user: TokenData = Depends(require_admin)):
    """Company stats scoped to the caller's role (single company, partner, or global)."""

    def _fetch():
        db = get_supabase()
        since_30d = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        company_ids = _company_ids_for_user(db, current_user)

        if company_ids is not None and not company_ids:
            empty = _sum_ocr([])
            return {
                "company_name": "No companies", "credits_remaining": 0,
                "total_users": 0, "total_credits_consumed": 0, "total_cost_usd": 0,
                "ocr": {"all_time": empty, "last_30d": empty},
                "validation": {"all_time": _sum_val([]), "last_30d": _sum_val([])},
            }

        if company_ids is not None and len(company_ids) == 1:
            c = db.table("companies").select("name, credits").eq("id", company_ids[0]).single().execute().data
            company_name = c["name"]
            credits_remaining = c["credits"]
        elif company_ids is not None:
            cs = db.table("companies").select("name, credits").in_("id", company_ids).execute().data or []
            company_name = f"{len(cs)} companies"
            credits_remaining = sum(c["credits"] for c in cs)
        else:
            cs = db.table("companies").select("credits").execute().data or []
            company_name = "All Companies"
            credits_remaining = sum(c["credits"] for c in cs)

        user_q = db.table("users").select("id", count="exact").eq("role", "user")
        if company_ids is not None:
            user_q = user_q.in_("company_id", company_ids)
        user_count = user_q.execute().count or 0

        ocr_q = db.table("processing_runs").select("total_files, total_pages, credits_used, total_cost_usd, started_at")
        val_q = db.table("validation_runs").select("total_items, credits_used, gemini_calls, started_at")
        if company_ids is not None:
            ocr_q = ocr_q.in_("company_id", company_ids)
            val_q = val_q.in_("company_id", company_ids)
        ocr_rows = ocr_q.execute().data or []
        val_rows = val_q.execute().data or []

        result = {
            "company_name":           company_name,
            "credits_remaining":      credits_remaining,
            "total_users":            user_count,
            "total_credits_consumed": _sum_ocr(ocr_rows)["credits"] + _sum_val(val_rows)["credits"],
            "total_cost_usd":         _sum_ocr(ocr_rows)["cost_usd"],
            "ocr": {
                "all_time": _sum_ocr(ocr_rows),
                "last_30d": _sum_ocr([r for r in ocr_rows if (r.get("started_at") or "") >= since_30d]),
            },
            "validation": {
                "all_time": _sum_val(val_rows),
                "last_30d": _sum_val([r for r in val_rows if (r.get("started_at") or "") >= since_30d]),
            },
        }

        # Per-user cost breakdown — only when scoped to a single company
        if company_ids is not None and len(company_ids) == 1:
            cid = company_ids[0]
            c_data = db.table("companies").select("price_per_page").eq("id", cid).single().execute().data or {}
            price = float(c_data.get("price_per_page") or _DEFAULT_PRICE_PER_INVOICE)

            user_ocr = (
                db.table("processing_runs")
                .select("user_id, credits_used, users!user_id(username)")
                .eq("company_id", cid)
                .execute().data or []
            )
            u_stats: dict = {}
            for r in user_ocr:
                uid = r.get("user_id")
                if not uid:
                    continue
                if uid not in u_stats:
                    u_stats[uid] = {
                        "user_id":      uid,
                        "username":     (r.get("users") or {}).get("username", "—"),
                        "ocr_invoices": 0,
                    }
                u_stats[uid]["ocr_invoices"] += r.get("credits_used") or 0

            by_user = sorted(u_stats.values(), key=lambda x: x["username"])
            for u in by_user:
                u["price_per_invoice"] = price
                u["total_cost"] = round(u["ocr_invoices"] * price, 2)

            result["by_user"] = by_user
            result["total_billing_cost"] = round(sum(u["total_cost"] for u in by_user), 2)

        return result

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# GET /v1/admin/global-overview  —  superadmin only
# ---------------------------------------------------------------------------

@router.get("/v1/admin/global-overview")
async def global_overview(current_user: TokenData = Depends(require_superadmin)):
    """Platform-wide aggregate stats across all partners, companies and users."""

    def _fetch():
        db = get_supabase()
        since_30d = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

        n_partners  = db.table("partners").select("id", count="exact").execute().count or 0
        n_companies = db.table("companies").select("id", count="exact").execute().count or 0
        n_users     = db.table("users").select("id", count="exact").eq("role", "user").execute().count or 0
        total_credits = sum(
            c["credits"] for c in (db.table("companies").select("credits").execute().data or [])
        )

        ocr_rows = db.table("processing_runs").select(
            "total_files, total_pages, credits_used, total_cost_usd, started_at"
        ).execute().data or []
        val_rows = db.table("validation_runs").select(
            "total_items, credits_used, gemini_calls, started_at"
        ).execute().data or []

        return {
            "total_partners":          n_partners,
            "total_companies":         n_companies,
            "total_users":             n_users,
            "total_credits_in_system": total_credits,
            "ocr": {
                "all_time": _sum_ocr(ocr_rows),
                "last_30d": _sum_ocr([r for r in ocr_rows if (r.get("started_at") or "") >= since_30d]),
            },
            "validation": {
                "all_time": _sum_val(val_rows),
                "last_30d": _sum_val([r for r in val_rows if (r.get("started_at") or "") >= since_30d]),
            },
        }

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# GET /v1/admin/my-clients  —  partner_admin+
# ---------------------------------------------------------------------------

@router.get("/v1/admin/my-clients")
async def my_clients(current_user: TokenData = Depends(require_partner_or_above)):
    """Client companies under this partner with all-time and 30-day usage summary."""

    def _fetch():
        db = get_supabase()
        since_30d = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

        if current_user.role == "partner_admin":
            companies = (
                db.table("companies")
                .select("id, name, credits, client_code, sync_api_key, is_active")
                .eq("partner_id", current_user.partner_id)
                .order("name")
                .execute().data or []
            )
            show_partner = False
        else:
            companies = (
                db.table("companies")
                .select("id, name, credits, client_code, sync_api_key, is_active, partners(name)")
                .order("name")
                .execute().data or []
            )
            show_partner = True

        result = []
        for c in companies:
            cid = c["id"]
            user_count = (
                db.table("users").select("id", count="exact")
                .eq("company_id", cid).eq("role", "user").execute().count or 0
            )
            ocr_rows = (
                db.table("processing_runs").select("credits_used, started_at")
                .eq("company_id", cid).execute().data or []
            )
            val_rows = (
                db.table("validation_runs").select("credits_used, started_at")
                .eq("company_id", cid).execute().data or []
            )
            ocr_30d = [r for r in ocr_rows if (r.get("started_at") or "") >= since_30d]
            val_30d = [r for r in val_rows if (r.get("started_at") or "") >= since_30d]

            catalog_count = (
                db.table("product_catalog").select("id", count="exact")
                .eq("company_id", cid).execute().count or 0
            )
            sync_log = (
                db.table("master_sync_logs")
                .select("triggered_at")
                .eq("company_id", cid)
                .eq("status", "success")
                .order("triggered_at", desc=True)
                .limit(1)
                .execute().data
            )

            entry = {
                "id":                 cid,
                "name":               c["name"],
                "credits":            c["credits"],
                "client_code":        c.get("client_code"),
                "is_active":          c.get("is_active", True),
                "sync_enabled":       bool(c.get("sync_api_key")),
                "catalog_item_count": catalog_count,
                "last_synced_at":     sync_log[0]["triggered_at"] if sync_log else None,
                "user_count":         user_count,
                # All-time
                "ocr_runs":           len(ocr_rows),
                "ocr_credits":        sum(r.get("credits_used", 0) for r in ocr_rows),
                "val_runs":           len(val_rows),
                "val_credits":        sum(r.get("credits_used", 0) for r in val_rows),
                # 30-day
                "ocr_runs_30d":       len(ocr_30d),
                "ocr_credits_30d":    sum(r.get("credits_used", 0) for r in ocr_30d),
                "val_runs_30d":       len(val_30d),
                "val_credits_30d":    sum(r.get("credits_used", 0) for r in val_30d),
            }
            if show_partner:
                entry["partner_name"] = (c.get("partners") or {}).get("name")
            result.append(entry)

        return result

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# GET /v1/admin/usage-overview  —  partner_admin+
# ---------------------------------------------------------------------------

@router.get("/v1/admin/usage-overview")
async def usage_overview(
    from_date: str | None = Query(None),
    to_date:   str | None = Query(None),
    current_user: TokenData = Depends(require_partner_or_above),
):
    """Aggregated usage per partner, company and user, optionally filtered by date range."""

    def _fetch():
        db = get_supabase()
        company_ids = _company_ids_for_user(db, current_user)

        if company_ids is not None and not company_ids:
            return {"by_company": [], "by_user": [], "by_partner": []}

        # Build company→partner name mapping
        if company_ids is not None:
            cos_meta = (db.table("companies").select("id, partners(name)")
                          .in_("id", company_ids).execute().data or [])
        else:
            cos_meta = db.table("companies").select("id, partners(name)").execute().data or []
        co_to_partner: dict[str, str] = {
            c["id"]: (c.get("partners") or {}).get("name") or "No Partner"
            for c in cos_meta
        }

        def _query(table: str, extra_fields: str):
            q = (
                db.table(table)
                .select(
                    f"company_id, user_id, {extra_fields}, "
                    "users!user_id(username), companies!company_id(name)"
                )
                .limit(10000)
            )
            if company_ids is not None:
                q = q.in_("company_id", company_ids)
            if from_date:
                q = q.gte("started_at", from_date)
            if to_date:
                q = q.lte("started_at", to_date)
            return q.execute().data or []

        ocr_rows = _query("processing_runs", "total_pages, credits_used")
        val_rows = _query("validation_runs", "total_items, credits_used")

        # All companies in scope, seeded with zeros (shows inactive companies too)
        if company_ids is not None:
            scope_cos = (
                db.table("companies").select("id, name, price_per_page")
                .in_("id", company_ids).order("name").execute().data or []
            )
        else:
            scope_cos = db.table("companies").select("id, name, price_per_page").order("name").execute().data or []

        price_map: dict = {
            c["id"]: float(c.get("price_per_page") or _DEFAULT_PRICE_PER_INVOICE)
            for c in scope_cos
        }

        co_stats: dict = {
            c["id"]: {
                "company_id":   c["id"],
                "company_name": c["name"],
                "partner_name": co_to_partner.get(c["id"], "No Partner"),
                "ocr_runs": 0, "ocr_pages": 0, "ocr_credits": 0,
                "val_runs": 0, "val_items": 0, "val_credits": 0,
            }
            for c in scope_cos
        }
        for r in ocr_rows:
            cid = r.get("company_id")
            if cid and cid in co_stats:
                co_stats[cid]["ocr_runs"]    += 1
                co_stats[cid]["ocr_pages"]   += r.get("total_pages") or 0
                co_stats[cid]["ocr_credits"] += r.get("credits_used") or 0
        for r in val_rows:
            cid = r.get("company_id")
            if cid and cid in co_stats:
                co_stats[cid]["val_runs"]    += 1
                co_stats[cid]["val_items"]   += r.get("total_items") or 0
                co_stats[cid]["val_credits"] += r.get("credits_used") or 0

        by_company = sorted(co_stats.values(), key=lambda x: x["company_name"])
        for entry in by_company:
            entry["total_credits"] = entry["ocr_credits"] + entry["val_credits"]
            ppi = price_map.get(entry["company_id"], _DEFAULT_PRICE_PER_INVOICE)
            entry["price_per_invoice"] = ppi
            entry["total_cost"] = round(entry["ocr_credits"] * ppi, 2)

        # Per-user stats (only users with activity)
        user_stats: dict = {}
        for r in ocr_rows:
            uid = r.get("user_id")
            if not uid:
                continue
            cid = r.get("company_id") or ""
            if uid not in user_stats:
                user_stats[uid] = {
                    "user_id":      uid,
                    "username":     (r.get("users")     or {}).get("username", "—"),
                    "company_name": (r.get("companies") or {}).get("name", "—"),
                    "_company_id":  cid,
                    "partner_name": co_to_partner.get(cid, "No Partner"),
                    "ocr_runs": 0, "ocr_pages": 0, "ocr_credits": 0,
                    "val_runs": 0, "val_items": 0, "val_credits": 0,
                }
            user_stats[uid]["ocr_runs"]    += 1
            user_stats[uid]["ocr_pages"]   += r.get("total_pages") or 0
            user_stats[uid]["ocr_credits"] += r.get("credits_used") or 0
        for r in val_rows:
            uid = r.get("user_id")
            if not uid:
                continue
            cid = r.get("company_id") or ""
            if uid not in user_stats:
                user_stats[uid] = {
                    "user_id":      uid,
                    "username":     (r.get("users")     or {}).get("username", "—"),
                    "company_name": (r.get("companies") or {}).get("name", "—"),
                    "_company_id":  cid,
                    "partner_name": co_to_partner.get(cid, "No Partner"),
                    "ocr_runs": 0, "ocr_pages": 0, "ocr_credits": 0,
                    "val_runs": 0, "val_items": 0, "val_credits": 0,
                }
            user_stats[uid]["val_runs"]    += 1
            user_stats[uid]["val_items"]   += r.get("total_items") or 0
            user_stats[uid]["val_credits"] += r.get("credits_used") or 0

        by_user = sorted(user_stats.values(), key=lambda x: x["username"])
        for entry in by_user:
            entry["total_credits"] = entry["ocr_credits"] + entry["val_credits"]
            cid = entry.pop("_company_id", "")
            ppi = price_map.get(cid, _DEFAULT_PRICE_PER_INVOICE)
            entry["price_per_invoice"] = ppi
            entry["total_cost"] = round(entry["ocr_credits"] * ppi, 2)

        # Per-partner aggregation (rolled up from by_company)
        p_stats: dict = {}
        for co in by_company:
            pn = co.get("partner_name") or "No Partner"
            if pn not in p_stats:
                p_stats[pn] = {
                    "partner_name":  pn,
                    "company_count": 0,
                    "ocr_runs":  0, "ocr_pages":  0, "ocr_credits":  0,
                    "val_runs":  0, "val_items":  0, "val_credits":  0,
                    "total_credits": 0,
                    "total_cost": 0.0,
                }
            s = p_stats[pn]
            s["company_count"] += 1
            s["ocr_runs"]      += co["ocr_runs"]
            s["ocr_pages"]     += co["ocr_pages"]
            s["ocr_credits"]   += co["ocr_credits"]
            s["val_runs"]      += co["val_runs"]
            s["val_items"]     += co["val_items"]
            s["val_credits"]   += co["val_credits"]
            s["total_credits"] += co["total_credits"]
            s["total_cost"]    += co["total_cost"]

        by_partner = sorted(p_stats.values(), key=lambda x: x["partner_name"])
        for entry in by_partner:
            entry["total_cost"] = round(entry["total_cost"], 2)

        return {"by_company": by_company, "by_user": by_user, "by_partner": by_partner}

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# GET /v1/admin/users  —  any admin, scoped by role
# ---------------------------------------------------------------------------

@router.get("/v1/admin/users")
async def admin_users(current_user: TokenData = Depends(require_admin)):
    """Users in scope: role-based — client_admin sees their company, partner sees their clients, superadmin sees all."""

    def _fetch():
        db = get_supabase()
        company_ids = _company_ids_for_user(db, current_user)

        q = db.table("users").select("id, username, role, company_id, is_active, companies!users_company_id_fkey(name)")

        if company_ids is None:
            q = q.neq("role", "superadmin")
        elif not company_ids:
            return []
        else:
            q = q.in_("company_id", company_ids)
            if current_user.role == "client_admin":
                q = q.eq("role", "user")

        rows = q.execute().data or []
        for row in rows:
            row["company_name"] = (row.pop("companies", None) or {}).get("name", "—")
        return rows

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# POST /v1/admin/company-users  —  client_admin+ creates a user
# ---------------------------------------------------------------------------

class CreateUserRequest(BaseModel):
    username: str
    password: str
    company_id: Optional[str] = None
    role: str = "user"


@router.post("/v1/admin/company-users", status_code=201)
async def create_company_user(req: CreateUserRequest, current_user: TokenData = Depends(require_admin)):
    if req.role not in ("user", "client_admin"):
        raise HTTPException(400, "role must be 'user' or 'client_admin'.")

    target_cid = req.company_id if current_user.role == "superadmin" else current_user.company_id
    if not target_cid:
        raise HTTPException(400, "company_id is required.")

    def _create():
        db = get_supabase()
        try:
            result = db.table("users").insert({
                "username":   req.username,
                "password":   _pwd.hash(req.password[:72]),
                "company_id": target_cid,
                "role":       req.role,
            }).execute()
            return result.data[0] if result.data else {"username": req.username}
        except Exception as e:
            if "duplicate" in str(e).lower() or "unique" in str(e).lower():
                raise HTTPException(409, f"Username '{req.username}' already exists in this company.")
            raise

    return await asyncio.to_thread(_create)


# ---------------------------------------------------------------------------
# DELETE /v1/admin/company-users/{user_id}  —  client_admin+
# ---------------------------------------------------------------------------

@router.delete("/v1/admin/company-users/{user_id}", status_code=204)
async def delete_company_user(user_id: str, current_user: TokenData = Depends(require_admin)):
    def _delete():
        db = get_supabase()
        res = db.table("users").select("id, role, company_id").eq("id", user_id).execute()
        if not res.data:
            raise HTTPException(404, "User not found.")
        target = res.data[0]

        if target["role"] in ("superadmin", "partner_admin"):
            raise HTTPException(403, "Cannot delete superadmin or partner_admin users via this endpoint.")
        if current_user.role == "client_admin" and target["company_id"] != current_user.company_id:
            raise HTTPException(403, "Cannot delete users from other companies.")

        db.table("users").delete().eq("id", user_id).execute()

    await asyncio.to_thread(_delete)


# ---------------------------------------------------------------------------
# GET /v1/admin/processing-runs  —  any admin, scoped by role
# ---------------------------------------------------------------------------

@router.get("/v1/admin/processing-runs")
async def admin_processing_runs(
    from_date: str | None = Query(None),
    to_date:   str | None = Query(None),
    username:  str | None = Query(None),
    limit:     int        = Query(100, le=500),
    current_user: TokenData = Depends(require_admin),
):
    def _fetch():
        db = get_supabase()
        company_ids = _company_ids_for_user(db, current_user)

        if company_ids is not None and not company_ids:
            return []

        user_ids = None
        if username:
            u_q = db.table("users").select("id").eq("username", username)
            if company_ids is not None:
                u_q = u_q.in_("company_id", company_ids)
            u_rows = u_q.execute().data or []
            if not u_rows:
                return []
            user_ids = [r["id"] for r in u_rows]

        q = (
            db.table("processing_runs")
            .select(
                "id, total_files, successful_files, failed_files, "
                "total_pages, total_fields_extracted, credits_used, "
                "total_duration_ms, status, started_at, completed_at, environment, "
                "users!user_id(username), companies!company_id(name)"
            )
            .order("started_at", desc=True)
            .limit(limit)
        )
        if company_ids is not None:
            q = q.in_("company_id", company_ids)
        if user_ids:
            q = q.in_("user_id", user_ids)
        if from_date:
            q = q.gte("started_at", from_date)
        if to_date:
            q = q.lte("started_at", to_date)

        rows = q.execute().data or []
        for row in rows:
            row["username"]     = (row.pop("users", None) or {}).get("username", "—")
            row["company_name"] = (row.pop("companies", None) or {}).get("name", "—")
        return rows

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# GET /v1/admin/validation-runs  —  any admin, scoped by role
# ---------------------------------------------------------------------------

@router.get("/v1/admin/validation-runs")
async def admin_validation_runs(
    from_date: str | None = Query(None),
    to_date:   str | None = Query(None),
    username:  str | None = Query(None),
    limit:     int        = Query(100, le=500),
    current_user: TokenData = Depends(require_admin),
):
    def _fetch():
        db = get_supabase()
        company_ids = _company_ids_for_user(db, current_user)

        if company_ids is not None and not company_ids:
            return []

        user_ids = None
        if username:
            u_q = db.table("users").select("id").eq("username", username)
            if company_ids is not None:
                u_q = u_q.in_("company_id", company_ids)
            u_rows = u_q.execute().data or []
            if not u_rows:
                return []
            user_ids = [r["id"] for r in u_rows]

        q = (
            db.table("validation_runs")
            .select(
                "id, source_filename, total_items, "
                "matched_exact, matched_fuzzy, matched_multi_plu, no_match, "
                "valid_items, items_with_issues, gemini_calls, credits_used, "
                "status, duration_ms, started_at, completed_at, environment, "
                "users!user_id(username), companies!company_id(name)"
            )
            .order("started_at", desc=True)
            .limit(limit)
        )
        if company_ids is not None:
            q = q.in_("company_id", company_ids)
        if user_ids:
            q = q.in_("user_id", user_ids)
        if from_date:
            q = q.gte("started_at", from_date)
        if to_date:
            q = q.lte("started_at", to_date)

        rows = q.execute().data or []
        for row in rows:
            row["username"]     = (row.pop("users", None) or {}).get("username", "—")
            row["company_name"] = (row.pop("companies", None) or {}).get("name", "—")
        return rows

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# Partners  —  superadmin only
# ---------------------------------------------------------------------------

@router.get("/v1/admin/partners")
async def list_partners(current_user: TokenData = Depends(require_superadmin)):
    def _fetch():
        db = get_supabase()
        partners = (
            db.table("partners")
            .select("id, name, contact_email, is_active, created_at")
            .order("name")
            .execute().data or []
        )
        for p in partners:
            p["company_count"] = (
                db.table("companies").select("id", count="exact").eq("partner_id", p["id"]).execute().count or 0
            )
        return partners

    return await asyncio.to_thread(_fetch)


class CreatePartnerRequest(BaseModel):
    name: str
    contact_email: Optional[str] = None


@router.post("/v1/admin/partners", status_code=201)
async def create_partner(req: CreatePartnerRequest, current_user: TokenData = Depends(require_superadmin)):
    def _create():
        db = get_supabase()
        try:
            result = db.table("partners").insert(
                {"name": req.name, "contact_email": req.contact_email}
            ).execute()
            return result.data[0]
        except Exception as e:
            if "duplicate" in str(e).lower() or "unique" in str(e).lower():
                raise HTTPException(409, f"Partner '{req.name}' already exists.")
            raise

    return await asyncio.to_thread(_create)


# ---------------------------------------------------------------------------
# All Companies  —  superadmin only
# ---------------------------------------------------------------------------

@router.get("/v1/admin/all-companies")
async def list_all_companies(current_user: TokenData = Depends(require_superadmin)):
    def _fetch():
        db = get_supabase()
        companies = (
            db.table("companies")
            .select("id, name, credits, partner_id, client_code, sync_api_key, is_active, partners(name)")
            .order("name")
            .execute().data or []
        )
        for c in companies:
            c["user_count"] = (
                db.table("users").select("id", count="exact")
                .eq("company_id", c["id"]).eq("role", "user").execute().count or 0
            )
            c["catalog_item_count"] = (
                db.table("product_catalog").select("id", count="exact")
                .eq("company_id", c["id"]).execute().count or 0
            )
            # Convert hash presence to a boolean — never expose the hash itself
            c["sync_enabled"] = bool(c.pop("sync_api_key", None))
            c["partner_name"] = (c.pop("partners", None) or {}).get("name")
        return companies

    return await asyncio.to_thread(_fetch)


class CreateCompanyRequest(BaseModel):
    name: str
    partner_id: Optional[str] = None
    initial_credits: int = 100
    client_code: Optional[str] = None


@router.post("/v1/admin/companies", status_code=201)
async def create_company(req: CreateCompanyRequest, current_user: TokenData = Depends(require_superadmin)):
    def _create():
        db = get_supabase()
        try:
            payload: dict = {
                "name":       req.name,
                "partner_id": req.partner_id,
                "credits":    req.initial_credits,
            }
            if req.client_code:
                payload["client_code"] = req.client_code.strip().upper()
            result = db.table("companies").insert(payload).execute()
            return result.data[0]
        except Exception as e:
            err = str(e).lower()
            if "duplicate" in err or "unique" in err:
                raise HTTPException(409, f"Company '{req.name}' or client_code already exists.")
            raise

    return await asyncio.to_thread(_create)


class UpdateCreditsRequest(BaseModel):
    credits: int


class UpdateClientCodeRequest(BaseModel):
    client_code: str


@router.patch("/v1/admin/companies/{company_id}/client-code")
async def update_client_code(
    company_id: str,
    req: UpdateClientCodeRequest,
    current_user: TokenData = Depends(require_superadmin),
):
    """Set or update the ERP client_code for a company."""
    def _update():
        db = get_supabase()
        res = db.table("companies").select("id").eq("id", company_id).execute()
        if not res.data:
            raise HTTPException(404, "Company not found.")
        try:
            db.table("companies").update(
                {"client_code": req.client_code.strip().upper()}
            ).eq("id", company_id).execute()
        except Exception as e:
            if "duplicate" in str(e).lower() or "unique" in str(e).lower():
                raise HTTPException(409, f"client_code '{req.client_code}' is already in use.")
            raise
        return {"id": company_id, "client_code": req.client_code.strip().upper()}

    return await asyncio.to_thread(_update)


@router.patch("/v1/admin/companies/{company_id}/credits")
async def update_company_credits(
    company_id: str,
    req: UpdateCreditsRequest,
    current_user: TokenData = Depends(require_superadmin),
):
    def _update():
        db = get_supabase()
        result = db.table("companies").update({"credits": req.credits}).eq("id", company_id).execute()
        if not result.data:
            raise HTTPException(404, "Company not found.")
        return {"id": company_id, "credits": req.credits}

    return await asyncio.to_thread(_update)


# ---------------------------------------------------------------------------
# Sync Key Management  —  superadmin only
# ---------------------------------------------------------------------------

@router.post("/v1/admin/companies/{company_id}/sync-key")
async def generate_sync_key(
    company_id: str,
    current_user: TokenData = Depends(require_superadmin),
):
    """
    Generate a cryptographically random sync secret for the company, store its
    bcrypt hash, and return the plaintext exactly once. The plaintext is not
    stored — after this call it is gone.
    """
    def _generate():
        db = get_supabase()
        res = db.table("companies").select("id").eq("id", company_id).execute()
        if not res.data:
            raise HTTPException(404, "Company not found.")

        plaintext = secrets.token_hex(32)   # 64-char hex string, 256 bits of entropy
        hashed = _pwd.hash(plaintext)
        db.table("companies").update({"sync_api_key": hashed}).eq("id", company_id).execute()

        return {
            "company_id":  company_id,
            "sync_secret": plaintext,
            "note":        "Store this secret immediately. It will not be shown again.",
        }

    return await asyncio.to_thread(_generate)


@router.delete("/v1/admin/companies/{company_id}/sync-key", status_code=204)
async def revoke_sync_key(
    company_id: str,
    current_user: TokenData = Depends(require_superadmin),
):
    """Revoke the sync secret for a company (sets sync_api_key = NULL)."""
    def _revoke():
        db = get_supabase()
        res = db.table("companies").select("id").eq("id", company_id).execute()
        if not res.data:
            raise HTTPException(404, "Company not found.")
        db.table("companies").update({"sync_api_key": None}).eq("id", company_id).execute()

    await asyncio.to_thread(_revoke)


@router.get("/v1/admin/companies/{company_id}/sync-status")
async def get_sync_status(
    company_id: str,
    current_user: TokenData = Depends(require_superadmin),
):
    """Return sync key status and the last 10 sync log entries. Never returns the key or hash."""
    def _fetch():
        db = get_supabase()
        company_res = (
            db.table("companies")
            .select("id, sync_api_key")
            .eq("id", company_id)
            .execute()
        )
        if not company_res.data:
            raise HTTPException(404, "Company not found.")

        company = company_res.data[0]
        sync_enabled = bool(company.get("sync_api_key"))

        logs_res = (
            db.table("master_sync_logs")
            .select("id, mode, records_synced, records_skipped, status, error_message, triggered_at")
            .eq("company_id", company_id)
            .order("triggered_at", desc=True)
            .limit(10)
            .execute()
        )
        recent_syncs = logs_res.data or []
        last_synced_at = recent_syncs[0]["triggered_at"] if recent_syncs else None

        return {
            "sync_enabled":  sync_enabled,
            "last_synced_at": last_synced_at,
            "recent_syncs":  recent_syncs,
        }

    return await asyncio.to_thread(_fetch)


# ---------------------------------------------------------------------------
# Activate / Deactivate  —  company (partner_admin+) and user (client_admin+)
# ---------------------------------------------------------------------------

class ToggleActiveRequest(BaseModel):
    is_active: bool


@router.patch("/v1/admin/companies/{company_id}/active")
async def toggle_company_active(
    company_id: str,
    req: ToggleActiveRequest,
    current_user: TokenData = Depends(require_partner_or_above),
):
    """Partner admin can activate/deactivate their own client companies. Superadmin can do any."""
    def _update():
        db = get_supabase()
        res = db.table("companies").select("id, partner_id").eq("id", company_id).execute()
        if not res.data:
            raise HTTPException(404, "Company not found.")
        company = res.data[0]

        if current_user.role == "partner_admin":
            if company.get("partner_id") != current_user.partner_id:
                raise HTTPException(403, "This company does not belong to your partner account.")

        db.table("companies").update({"is_active": req.is_active}).eq("id", company_id).execute()
        return {"id": company_id, "is_active": req.is_active}

    return await asyncio.to_thread(_update)


# ---------------------------------------------------------------------------
# Credit Settings  —  GET: all admins (scoped)  PATCH: partner_admin only
# ---------------------------------------------------------------------------

_DEFAULT_PRICE_PER_INVOICE = 20.00


@router.get("/v1/admin/credit-settings")
async def get_credit_settings(current_user: TokenData = Depends(require_admin)):
    """Price-per-invoice for each company in scope, read directly from the companies table."""
    def _fetch():
        db = get_supabase()
        company_ids = _company_ids_for_user(db, current_user)

        if company_ids is not None and not company_ids:
            return []

        q = db.table("companies").select("id, name, price_per_page, price_updated_at")
        if company_ids is not None:
            q = q.in_("id", company_ids)
        companies = q.order("name").execute().data or []

        return [
            {
                "company_id":         c["id"],
                "company_name":       c["name"],
                "price_per_invoice":  float(c.get("price_per_page") or _DEFAULT_PRICE_PER_INVOICE),
                "has_custom":         float(c.get("price_per_page") or _DEFAULT_PRICE_PER_INVOICE) != _DEFAULT_PRICE_PER_INVOICE,
                "price_updated_at":   c.get("price_updated_at"),
            }
            for c in companies
        ]

    return await asyncio.to_thread(_fetch)


class UpdatePricePerInvoiceRequest(BaseModel):
    price_per_invoice: float


@router.patch("/v1/admin/companies/{company_id}/price-per-invoice")
async def update_price_per_invoice(
    company_id: str,
    req: UpdatePricePerInvoiceRequest,
    current_user: TokenData = Depends(require_partner_admin),
):
    """Set or reset the price per invoice for a client company. Partner admin only."""
    if req.price_per_invoice <= 0:
        raise HTTPException(400, "price_per_invoice must be greater than 0.")

    def _update():
        db = get_supabase()
        company_ids = _company_ids_for_user(db, current_user)
        if company_ids is not None and company_id not in company_ids:
            raise HTTPException(403, "This company does not belong to your partner account.")

        res = db.table("companies").select("id").eq("id", company_id).execute()
        if not res.data:
            raise HTTPException(404, "Company not found.")

        db.table("companies").update({
            "price_per_page":      req.price_per_invoice,  # DB column still named price_per_page
            "price_updated_at":    datetime.now(timezone.utc).isoformat(),
            "price_updated_by_id": current_user.user_id,
        }).eq("id", company_id).execute()

        return {"company_id": company_id, "price_per_invoice": req.price_per_invoice}

    return await asyncio.to_thread(_update)


# ---------------------------------------------------------------------------
# GET /v1/admin/product-catalog  —  any admin, scoped by role
# ---------------------------------------------------------------------------

@router.get("/v1/admin/product-catalog")
async def admin_product_catalog(
    search: str | None = Query(None),
    limit:  int        = Query(50, le=200),
    offset: int        = Query(0, ge=0),
    current_user: TokenData = Depends(require_admin),
):
    """Product catalog scoped to the caller's company (client_admin) or all companies in scope."""
    def _fetch():
        db = get_supabase()
        company_ids = _company_ids_for_user(db, current_user)

        if company_ids is not None and not company_ids:
            return {"items": [], "total": 0}

        q = (
            db.table("product_catalog")
            .select(
                "id, sku_code, plu_code, sku_description, ean_code, "
                "cost_price, mrp, gst_percent, priority, status, uom, synced_at",
                count="exact",
            )
        )
        if company_ids is not None:
            q = q.in_("company_id", company_ids)
        if search:
            s = search.strip().replace("%", r"\%").replace("_", r"\_")
            q = q.or_(
                f"sku_description.ilike.%{s}%,"
                f"plu_code.ilike.%{s}%,"
                f"sku_code.ilike.%{s}%,"
                f"ean_code.ilike.%{s}%"
            )

        result = (
            q.order("sku_description", nullsfirst=False)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return {"items": result.data or [], "total": result.count or 0}

    return await asyncio.to_thread(_fetch)


@router.patch("/v1/admin/users/{user_id}/active")
async def toggle_user_active(
    user_id: str,
    req: ToggleActiveRequest,
    current_user: TokenData = Depends(require_admin),
):
    """Client admin can activate/deactivate users within their company. Partner admin / superadmin have broader scope."""
    def _update():
        db = get_supabase()
        res = db.table("users").select("id, role, company_id").eq("id", user_id).execute()
        if not res.data:
            raise HTTPException(404, "User not found.")
        target = res.data[0]

        if target["role"] in ("superadmin", "partner_admin"):
            raise HTTPException(403, "Cannot deactivate superadmin or partner_admin accounts.")

        if current_user.role == "client_admin":
            if target["company_id"] != current_user.company_id:
                raise HTTPException(403, "Cannot modify users from other companies.")
        elif current_user.role == "partner_admin":
            company_ids = _company_ids_for_user(db, current_user)
            if company_ids is not None and target["company_id"] not in company_ids:
                raise HTTPException(403, "This user does not belong to any of your client companies.")

        db.table("users").update({"is_active": req.is_active}).eq("id", user_id).execute()
        return {"id": user_id, "is_active": req.is_active}

    return await asyncio.to_thread(_update)
