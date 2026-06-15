"""
sync.py — Machine-to-machine master data sync API.

POST /v1/sync/master-data
  Client ERP/POS systems push their product catalog into product_catalog.
  Auth: Authorization: Bearer <sync_secret> header + client_code in request body.
  No JWT — this is a separate M2M credential issued per company.
"""

import asyncio
import csv
import io
import json
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Form, Header, HTTPException, Request, UploadFile, status
from passlib.context import CryptContext
from pydantic import BaseModel

from app.db import get_supabase

router = APIRouter()
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ---------------------------------------------------------------------------
# Column-name normalisation
# Maps normalised key → canonical product_catalog column name.
# _norm() lowercases and strips spaces, underscores, and dots so that
# "Sku Description", "sku_description", "SKU_DESC", "sku_descri" all resolve.
# ---------------------------------------------------------------------------
_COLUMN_MAP: dict[str, str] = {
    # PLU / SKU identifiers
    "plucode":             "plu_code",
    "skucode":             "sku_code",
    # Description — full name, old name, and truncated ERP variant
    "skudescription":      "sku_description",
    "skudesc":             "sku_description",
    "skudescri":           "sku_description",     # ERP truncation
    "description":         "sku_description",
    # Short description
    "skushortdescription": "sku_short_description",
    "skushortdesc":        "sku_short_description",
    "skushort":            "sku_short_description",   # ERP truncation
    # GST / Tax — all common naming conventions
    "gstpercent":          "gst_percent",
    "gstpercer":           "gst_percent",             # ERP truncation of gst_percent
    "gst%":                "gst_percent",
    "tax%":                "gst_percent",
    "tax":                 "gst_percent",
    "taxpct":              "gst_percent",
    "taxpercent":          "gst_percent",
    # EAN / Barcode
    "eancode":             "ean_code",
    "ean":                 "ean_code",
    "barcode":             "ean_code",
    # Prices
    "basicprice":          "basic_price",
    "costprice":           "cost_price",
    "mrp":                 "mrp",
    "saleprice":           "sale_price",
    # Other fields
    "priority":            "priority",
    "uom":                 "uom",
    "hsncode":             "hsn_code",
    "hsn":                 "hsn_code",
    "lastupdated":         "last_updated",
    "lastupdate":          "last_updated",            # ERP truncation
    "status":              "status",
}

_CANONICAL = {
    "plu_code", "sku_code", "sku_description", "sku_short_description",
    "gst_percent", "ean_code", "basic_price", "cost_price", "mrp", "sale_price",
    "priority", "uom", "hsn_code", "last_updated", "status",
}

_SYNC_MAX_MB = int(os.environ.get("SYNC_MAX_PAYLOAD_MB", "5"))
_CHUNK = 500

# ---------------------------------------------------------------------------
# Per-IP rate limiting for failed auth attempts (in-memory)
# Limits brute-force attacks without requiring an external cache.
# ---------------------------------------------------------------------------
_fail_timestamps: dict[str, list[float]] = defaultdict(list)
_FAIL_WINDOW = 600   # 10 minutes
_FAIL_MAX = 5


def _check_rate_limit(ip: str) -> None:
    now = time.monotonic()
    recent = [t for t in _fail_timestamps[ip] if now - t < _FAIL_WINDOW]
    _fail_timestamps[ip] = recent
    if len(recent) >= _FAIL_MAX:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed authentication attempts. Try again in 10 minutes.",
        )


def _record_fail(ip: str) -> None:
    _fail_timestamps[ip].append(time.monotonic())


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class SyncRequest(BaseModel):
    client_code: str
    mode: str = "upsert"
    products: list[dict]


# ---------------------------------------------------------------------------
# Item normalisation
# ---------------------------------------------------------------------------

def _norm_key(k: str) -> str:
    return k.strip().lower().replace(" ", "").replace("_", "").replace(".", "")


def _to_float(val: object) -> Optional[float]:
    try:
        return float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _ean_str(val: object) -> Optional[str]:
    """Convert 8901234567890.0 → '8901234567890'."""
    if val is None:
        return None
    try:
        return str(int(float(str(val))))
    except (ValueError, TypeError):
        s = str(val).strip()
        return s or None


def _normalize_product(raw: dict, company_id: str) -> tuple[Optional[dict], int]:
    """
    Map ERP field names to product_catalog column names.
    Unknown keys are stored in extra_data (no data lost, no migration needed).
    Returns (db_record, 0) on success, (None, 1) when plu_code is missing.
    """
    normalised: dict[str, object] = {}
    extra: dict[str, object] = {}

    for k, v in raw.items():
        canonical = _COLUMN_MAP.get(_norm_key(k))
        if canonical:
            normalised[canonical] = v
        else:
            extra[k] = v

    plu = _ean_str(normalised.get("plu_code"))
    if not plu:
        return None, 1

    record: dict = {
        "company_id":            company_id,
        "plu_code":              plu,
        "sku_code":              str(normalised["sku_code"]).strip() if normalised.get("sku_code") else None,
        "sku_description":       str(normalised["sku_description"]).strip() if normalised.get("sku_description") else None,
        "sku_short_description": str(normalised["sku_short_description"]).strip() if normalised.get("sku_short_description") else None,
        "gst_percent":           _to_float(normalised.get("gst_percent")),
        "ean_code":              _ean_str(normalised.get("ean_code")),
        "basic_price":           _to_float(normalised.get("basic_price")),
        "cost_price":            _to_float(normalised.get("cost_price")),
        "mrp":                   _to_float(normalised.get("mrp")),
        "sale_price":            _to_float(normalised.get("sale_price")),
        "priority":              int(_to_float(normalised.get("priority")) or 1),
        "uom":                   str(normalised["uom"]).strip() if normalised.get("uom") else None,
        "hsn_code":              str(normalised["hsn_code"]).strip() if normalised.get("hsn_code") else None,
        "last_updated":          str(normalised["last_updated"]) if normalised.get("last_updated") else None,
        "status":                str(normalised.get("status", "0"))[0],  # keep first char only
        "extra_data":            extra,
        "synced_at":             datetime.now(timezone.utc).isoformat(),
    }
    return record, 0


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/v1/sync/master-data")
async def sync_master_data(
    req: SyncRequest,
    request: Request,
    authorization: Optional[str] = Header(None),
):
    # Payload size guard — checked before any DB work
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > _SYNC_MAX_MB * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Payload exceeds {_SYNC_MAX_MB} MB limit.",
        )

    if req.mode not in ("upsert", "replace"):
        raise HTTPException(status_code=400, detail="mode must be 'upsert' or 'replace'.")

    # Extract Bearer token from Authorization header
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header with Bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    sync_secret = authorization[7:].strip()  # strip "Bearer "

    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    def _auth_and_sync() -> dict:
        db = get_supabase()

        # Look up company by client_code
        company_res = (
            db.table("companies")
            .select("id, sync_api_key, sync_allowed_ips")
            .eq("client_code", req.client_code)
            .execute()
        )
        company = company_res.data[0] if company_res.data else None

        # Generic 401 when client_code not found — never reveal whether code exists
        if not company:
            _record_fail(client_ip)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid client_code or sync secret.",
            )

        # 403 when company exists but no sync key has been issued yet
        if not company.get("sync_api_key"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sync is not enabled for this company. Contact your administrator.",
            )

        # Optional IP whitelist check
        allowed_ips = company.get("sync_allowed_ips")
        if allowed_ips and client_ip not in allowed_ips:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Request IP is not whitelisted for this company.",
            )

        # bcrypt verify — generic 401 on mismatch
        if not _pwd.verify(sync_secret, company["sync_api_key"]):
            _record_fail(client_ip)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid client_code or sync secret.",
            )

        company_id = company["id"]

        # Fetch last successful sync time before running the current one
        last_log = (
            db.table("master_sync_logs")
            .select("triggered_at")
            .eq("company_id", company_id)
            .eq("status", "success")
            .order("triggered_at", desc=True)
            .limit(1)
            .execute()
        )
        last_synced_at = last_log.data[0]["triggered_at"] if last_log.data else None

        # Normalise products; collect valid records and count skipped
        records: list[dict] = []
        skipped = 0
        for raw in req.products:
            rec, skip = _normalize_product(raw, company_id)
            if skip:
                skipped += 1
            else:
                records.append(rec)

        triggered_at = datetime.now(timezone.utc)

        try:
            if req.mode == "replace":
                db.table("product_catalog").delete().eq("company_id", company_id).execute()

            synced = 0
            for i in range(0, len(records), _CHUNK):
                chunk = records[i : i + _CHUNK]
                db.table("product_catalog").upsert(
                    chunk, on_conflict="company_id,plu_code"
                ).execute()
                synced += len(chunk)

            db.table("master_sync_logs").insert({
                "company_id":      company_id,
                "mode":            req.mode,
                "records_synced":  synced,
                "records_skipped": skipped,
                "status":          "success",
                "triggered_at":    triggered_at.isoformat(),
            }).execute()

            return {
                "status":          "success",
                "mode":            req.mode,
                "records_synced":  synced,
                "records_skipped": skipped,
                "triggered_at":    triggered_at.isoformat(),
                "last_synced_at":  last_synced_at,
            }

        except Exception as exc:
            try:
                db.table("master_sync_logs").insert({
                    "company_id":      company_id,
                    "mode":            req.mode,
                    "records_synced":  0,
                    "records_skipped": skipped,
                    "status":          "error",
                    "error_message":   str(exc)[:500],
                    "triggered_at":    triggered_at.isoformat(),
                }).execute()
            except Exception:
                pass
            raise HTTPException(status_code=500, detail="Sync failed due to an internal error.")

    return await asyncio.to_thread(_auth_and_sync)


# ---------------------------------------------------------------------------
# File-upload endpoint
# POST /v1/sync/master-data/upload
# Accepts multipart/form-data: file (.csv or .json), client_code, mode
# ---------------------------------------------------------------------------

def _parse_upload(content: bytes, filename: str) -> list[dict]:
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix == "json":
        data = json.loads(content.decode("utf-8"))
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "products" in data:
            return data["products"]
        raise ValueError("JSON must be a list of products or an object with a 'products' key.")
    if suffix == "csv":
        text = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        return [row for row in reader]
    raise ValueError(f"Unsupported file type '.{suffix}'. Upload a .csv or .json file.")


@router.post("/v1/sync/master-data/upload")
async def sync_master_data_upload(
    request: Request,
    file: UploadFile,
    client_code: str = Form(...),
    mode: str = Form("upsert"),
    authorization: Optional[str] = Header(None),
):
    if mode not in ("upsert", "replace"):
        raise HTTPException(status_code=400, detail="mode must be 'upsert' or 'replace'.")

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header with Bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    sync_secret = authorization[7:].strip()

    content = await file.read()
    if len(content) > _SYNC_MAX_MB * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {_SYNC_MAX_MB} MB limit.",
        )

    try:
        products = _parse_upload(content, file.filename or "")
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not products:
        raise HTTPException(status_code=400, detail="File contains no products.")

    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    # Reuse the same auth + sync logic as the JSON-body endpoint
    sync_req = SyncRequest(client_code=client_code, mode=mode, products=products)

    def _auth_and_sync_upload() -> dict:
        db = get_supabase()

        company_res = (
            db.table("companies")
            .select("id, sync_api_key, sync_allowed_ips")
            .eq("client_code", sync_req.client_code)
            .execute()
        )
        company = company_res.data[0] if company_res.data else None

        if not company:
            _record_fail(client_ip)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid client_code or sync secret.",
            )

        if not company.get("sync_api_key"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sync is not enabled for this company. Contact your administrator.",
            )

        allowed_ips = company.get("sync_allowed_ips")
        if allowed_ips and client_ip not in allowed_ips:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Request IP is not whitelisted for this company.",
            )

        if not _pwd.verify(sync_secret, company["sync_api_key"]):
            _record_fail(client_ip)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid client_code or sync secret.",
            )

        company_id = company["id"]

        last_log = (
            db.table("master_sync_logs")
            .select("triggered_at")
            .eq("company_id", company_id)
            .eq("status", "success")
            .order("triggered_at", desc=True)
            .limit(1)
            .execute()
        )
        last_synced_at = last_log.data[0]["triggered_at"] if last_log.data else None

        records: list[dict] = []
        skipped = 0
        for raw in sync_req.products:
            rec, skip = _normalize_product(raw, company_id)
            if skip:
                skipped += 1
            else:
                records.append(rec)

        triggered_at = datetime.now(timezone.utc)

        try:
            if sync_req.mode == "replace":
                db.table("product_catalog").delete().eq("company_id", company_id).execute()

            synced = 0
            for i in range(0, len(records), _CHUNK):
                chunk = records[i : i + _CHUNK]
                db.table("product_catalog").upsert(
                    chunk, on_conflict="company_id,plu_code"
                ).execute()
                synced += len(chunk)

            db.table("master_sync_logs").insert({
                "company_id":      company_id,
                "mode":            sync_req.mode,
                "records_synced":  synced,
                "records_skipped": skipped,
                "status":          "success",
                "triggered_at":    triggered_at.isoformat(),
            }).execute()

            return {
                "status":          "success",
                "mode":            sync_req.mode,
                "records_synced":  synced,
                "records_skipped": skipped,
                "triggered_at":    triggered_at.isoformat(),
                "last_synced_at":  last_synced_at,
            }

        except Exception as exc:
            try:
                db.table("master_sync_logs").insert({
                    "company_id":      company_id,
                    "mode":            sync_req.mode,
                    "records_synced":  0,
                    "records_skipped": skipped,
                    "status":          "error",
                    "error_message":   str(exc)[:500],
                    "triggered_at":    triggered_at.isoformat(),
                }).execute()
            except Exception:
                pass
            raise HTTPException(status_code=500, detail="Sync failed due to an internal error.")

    return await asyncio.to_thread(_auth_and_sync_upload)
