"""
behavior.py — Phase 1: Behavior Event Ingestion

Receives user interaction events from the frontend, scrubs PII from metadata,
and writes an immutable row to the behavior_events table.

The endpoint is fire-and-forget from the frontend's perspective:
  - Always returns HTTP 204 (no body).
  - The DB insert runs in a thread pool so it never blocks the event loop.
  - If the insert fails, the error is logged but NOT surfaced to the client
    (behavioral telemetry must never degrade the main UX).
"""

import asyncio
import re
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel

from app.auth_utils import get_current_user, TokenData
from app.db import get_supabase
from app.profiles import apply_signal

router = APIRouter()

# ---------------------------------------------------------------------------
# PII scrubbing
# ---------------------------------------------------------------------------

# Field names whose values are redacted before storage.
_PII_PATTERN = re.compile(
    r"iban|account_?number|bank_?account|swift|bic|tax_?id|ssn|pan|passport",
    re.IGNORECASE,
)


def _scrub(metadata: dict) -> dict:
    """Recursively redact values whose key matches a known PII pattern."""
    result: dict[str, Any] = {}
    for k, v in metadata.items():
        if _PII_PATTERN.search(k):
            result[k] = "[REDACTED]"
        elif isinstance(v, dict):
            result[k] = _scrub(v)
        else:
            result[k] = v
    return result


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class BehaviorEventRequest(BaseModel):
    event_type: str
    metadata: dict = {}


# ---------------------------------------------------------------------------
# Allowed event types — rejects unknown events early
# ---------------------------------------------------------------------------

ALLOWED_EVENT_TYPES = {
    # Validation interactions
    "field_edit",           # user manually changed a field value
    "suggestion_accepted",  # user accepted master-data suggestion as-is
    "plu_selected",         # user picked a PLU from multi_plu options
    "flag_acknowledged",    # user opened the edit panel on a discrepancy
    # Passive signals (frontend scroll / visibility)
    "skipped_reasoning",
    "expanded_breakdown",
    "copied_summary",
    # Explicit feedback buttons
    "feedback_too_long",
    "feedback_too_short",
    "feedback_too_technical",
    "feedback_incorrect",
    # PLU auto-select preference toggle
    "plu_auto_select_toggled",
}


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/v1/memory/event", status_code=204)
async def record_behavior_event(
    request: BehaviorEventRequest,
    current_user: TokenData = Depends(get_current_user),
):
    """
    Ingest one behavior event from the frontend.

    Always returns 204 — the client must not wait on this response.
    Errors in the DB write are swallowed so telemetry never breaks the UI.
    """
    if request.event_type not in ALLOWED_EVENT_TYPES:
        # Unknown event type — ignore silently rather than erroring
        return Response(status_code=204)

    clean_metadata = _scrub(request.metadata)

    def _insert():
        db = get_supabase()
        db.table("behavior_events").insert({
            "user_id":    current_user.user_id,
            "company_id": current_user.company_id,
            "event_type": request.event_type,
            "metadata":   clean_metadata,
        }).execute()

    try:
        await asyncio.to_thread(_insert)
    except Exception as exc:
        # Log but never propagate — behavioral telemetry is non-critical
        print(f"[behavior] failed to insert event '{request.event_type}': {exc}")
        return Response(status_code=204)

    # Fire signal map processor as a background task.
    # Runs independently — any failure is already handled inside apply_signal().
    asyncio.create_task(
        apply_signal(current_user.user_id, current_user.company_id, request.event_type)
    )

    return Response(status_code=204)
