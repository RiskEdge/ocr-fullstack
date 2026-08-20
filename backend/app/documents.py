"""
documents.py — duplicate upload detection.

Records a one-way SHA-256 fingerprint of every *successfully* processed file so
a later upload of the same bytes can be flagged before the user spends credits
on it again.

Privacy: no document content is ever stored. A SHA-256 digest cannot be
reversed into the file it came from — the table holds only the fingerprint plus
display metadata (filename, size, page count).

Detection is advisory. /v1/process-invoice does not reject duplicates; the UI
warns and the user decides. Repeats are marked with is_repeat so admin
reporting can surface how many credits go on re-processing.
"""

import asyncio
import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Iterable, Iterator, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth_utils import get_current_user, TokenData
from app.db import get_supabase

router = APIRouter()

# How far back a duplicate counts. Anything older reads as a new file.
DUPLICATE_LOOKBACK_DAYS = 120  # ~4 months

# Mirrors the 100-file cap on /v1/process-invoice.
MAX_FILES_PER_CHECK = 100

# PostgREST puts `in_` filters in the query string; 64-char hashes add up fast,
# so the lookup is split into chunks that keep the URL comfortably short.
_HASH_CHUNK_SIZE = 25

_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


def _chunks(items: list, size: int) -> Iterator[list]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _cutoff_iso() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=DUPLICATE_LOOKBACK_DAYS)).isoformat()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Duplicate check — called by the frontend on file select, before Extract
# ---------------------------------------------------------------------------

class DuplicateCheckFile(BaseModel):
    filename: str
    sha256: str
    size: Optional[int] = None


class DuplicateCheckRequest(BaseModel):
    files: list[DuplicateCheckFile]


def _fetch_matches(company_id: str, hashes: list[str]) -> list[dict]:
    """All processed_documents rows for these hashes within the lookback window."""
    db = get_supabase()
    cutoff = _cutoff_iso()
    rows: list[dict] = []
    for chunk in _chunks(hashes, _HASH_CHUNK_SIZE):
        result = (
            db.table("processed_documents")
            .select("file_hash, filename, user_id, page_count, created_at")
            .eq("company_id", company_id)
            .in_("file_hash", chunk)
            .gte("created_at", cutoff)
            .execute()
        )
        rows.extend(result.data or [])
    # Chunks are fetched independently — sort the merged set newest-first.
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return rows


def _resolve_usernames(user_ids: Iterable[Optional[str]]) -> dict[str, str]:
    ids = list({uid for uid in user_ids if uid})
    if not ids:
        return {}
    db = get_supabase()
    names: dict[str, str] = {}
    for chunk in _chunks(ids, _HASH_CHUNK_SIZE):
        result = db.table("users").select("id, username").in_("id", chunk).execute()
        for row in result.data or []:
            names[row["id"]] = row["username"]
    return names


@router.post("/v1/duplicate-check")
async def duplicate_check(
    request: DuplicateCheckRequest,
    current_user: TokenData = Depends(get_current_user),
):
    """
    Given the SHA-256 of each staged file, report which ones this company has
    already processed in the last DUPLICATE_LOOKBACK_DAYS days.

    Returns one entry per *duplicated* hash — files with no prior run are simply
    absent from the response.
    """
    if len(request.files) > MAX_FILES_PER_CHECK:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum of {MAX_FILES_PER_CHECK} files allowed.",
        )

    # Ignore anything that is not a well-formed digest rather than failing the
    # whole check — a malformed entry should never block an upload.
    hashes = list({
        f.sha256.lower() for f in request.files if _SHA256_HEX.match(f.sha256.lower())
    })
    if not hashes:
        return {"duplicates": [], "lookback_days": DUPLICATE_LOOKBACK_DAYS}

    def _work() -> list[dict]:
        rows = _fetch_matches(current_user.company_id, hashes)
        usernames = _resolve_usernames(row["user_id"] for row in rows)

        grouped: dict[str, dict] = {}
        for row in rows:  # newest-first
            entry = grouped.get(row["file_hash"])
            if entry is None:
                grouped[row["file_hash"]] = {
                    "file_hash": row["file_hash"],
                    "count": 1,
                    "last_seen_at": row["created_at"],
                    "first_seen_at": row["created_at"],
                    "last_filename": row["filename"],
                    "last_user": usernames.get(row["user_id"]),
                    "first_user": usernames.get(row["user_id"]),
                    "page_count": row["page_count"],
                }
            else:
                entry["count"] += 1
                # Rows are ordered newest-first, so each later row is older.
                entry["first_seen_at"] = row["created_at"]
                entry["first_user"] = usernames.get(row["user_id"])
        return list(grouped.values())

    try:
        duplicates = await asyncio.to_thread(_work)
    except Exception as exc:
        # A failed check must never stop the user from extracting.
        print(f"[duplicate-check] lookup failed: {exc}")
        duplicates = []

    return {"duplicates": duplicates, "lookback_days": DUPLICATE_LOOKBACK_DAYS}


# ---------------------------------------------------------------------------
# Recording — called from OCRProcessor.stream_documents after a run completes
# ---------------------------------------------------------------------------

async def record_processed_documents(
    *,
    company_id: str,
    user_id: str,
    run_id: Optional[str],
    documents: list[dict],
) -> None:
    """
    Insert one row per successfully processed file.

    `documents` items: {file_bytes, filename, mime_type, page_count}.

    The hash is computed here from the bytes the server actually processed — a
    client-supplied hash is only ever a lookup hint and is never persisted.

    Never raises: a bookkeeping failure must not break the response stream.
    """
    if not documents:
        return

    def _work() -> int:
        rows = [
            {
                "company_id": company_id,
                "user_id": user_id,
                "run_id": run_id,
                "filename": doc["filename"],
                "file_hash": sha256_hex(doc["file_bytes"]),
                "file_size": len(doc["file_bytes"]),
                "page_count": doc.get("page_count"),
                "mime_type": doc.get("mime_type"),
            }
            for doc in documents
        ]

        db = get_supabase()
        cutoff = _cutoff_iso()
        unique_hashes = list({row["file_hash"] for row in rows})
        existing: set[str] = set()
        for chunk in _chunks(unique_hashes, _HASH_CHUNK_SIZE):
            result = (
                db.table("processed_documents")
                .select("file_hash")
                .eq("company_id", company_id)
                .in_("file_hash", chunk)
                .gte("created_at", cutoff)
                .execute()
            )
            existing.update(row["file_hash"] for row in (result.data or []))

        seen_in_batch: set[str] = set()
        for row in rows:
            row["is_repeat"] = row["file_hash"] in existing or row["file_hash"] in seen_in_batch
            seen_in_batch.add(row["file_hash"])

        db.table("processed_documents").insert(rows).execute()
        return sum(1 for row in rows if row["is_repeat"])

    try:
        repeats = await asyncio.to_thread(_work)
        print(f"[documents] recorded {len(documents)} document(s), {repeats} repeat(s)")
    except Exception as exc:
        import traceback
        print(f"[documents] FAILED to record processed documents: {exc}")
        traceback.print_exc()
