"""
profiles.py — Phase 2: Structured Persistence & Thresholding

Responsibilities
----------------
1. Signal map — translates behavior events into real-time preference score nudges
   on user_profiles. Called as a background task from behavior.py after each
   successful event insert.

2. Flag exposure tracking — POST /v1/memory/flag-exposure
   Upserts a (user, flag_type) row each time a validation flag is rendered.
   The context builder uses exposure_count to skip educational preamble when > 2.

3. Dismissal tracking — POST /v1/memory/dismiss
   Upserts a (user, flag_type) row. When dismiss_count >= 3, sets auto_suppressed
   and adds the flag to user_profiles.low_signal_flags.

4. Investigation recording — POST /v1/memory/investigation
   Inserts one row per outcome (Fraud / VendorError / FalsePositive). The
   risk_score is collected here and consumed by the nightly aggregator.

5. Profile read — GET /v1/user-profile
   Returns the current user's preference state (or sensible defaults if no row
   exists yet).

6. Profile update — PATCH /v1/user-profile
   Partial update of user preference fields (e.g. auto_select_plu).
   Creates the profile row with defaults if it does not yet exist.

7. Nightly aggregator — POST /v1/internal/aggregate-profiles
   Recalculates effective_risk_threshold using the midpoint formula defined in
   the framework document, and applies 30-day behavioral dominance nudges to
   explanation_depth. Secured with AGGREGATOR_SECRET from .env. Intended to be
   called by pg_cron via pg_net (see migrations/schedule_aggregator.sql).
"""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel

from app.auth_utils import get_current_user, TokenData
from app.db import get_supabase

router = APIRouter()

# ── Signal Map ────────────────────────────────────────────────────────────────
# Maps event_type → (preference_dimension, delta).
# Scores are clamped to [1.0, 5.0] after each update.
#
# Weight guide (from framework doc):
#   ±1.0 = high-intent (explicit feedback buttons)
#   ±0.5 = low-intent  (passive/scroll signals)

SIGNAL_MAP: dict[str, tuple[str, float]] = {
    "feedback_too_long":      ("explanation_depth", -1.0),
    "feedback_too_short":     ("explanation_depth", +1.0),
    "feedback_too_technical": ("technical_level",   -1.0),
    "skipped_reasoning":      ("explanation_depth", -0.5),
    "copied_summary":         ("explanation_depth", -0.5),
    "expanded_breakdown":     ("explanation_depth", +0.5),
}

# Dismiss count at which a flag is auto-suppressed for this user.
AUTO_SUPPRESS_THRESHOLD = 3

# Valid outcomes for the investigations table.
VALID_OUTCOMES = {"Fraud", "VendorError", "FalsePositive"}


# ── Signal map processor ──────────────────────────────────────────────────────

def _apply_signal_sync(user_id: str, company_id: str, dimension: str, delta: float) -> None:
    """
    Fetch the user's current score for `dimension`, apply `delta`, clamp to
    [1.0, 5.0], and persist.  Creates the profile row with defaults (3.0/3.0)
    if it does not exist yet.

    Runs in a thread pool — must not use async constructs.
    """
    db = get_supabase()
    now = datetime.now(timezone.utc).isoformat()

    existing = (
        db.table("user_profiles")
        .select(dimension)
        .eq("user_id", user_id)
        .execute()
    )

    if not existing.data:
        db.table("user_profiles").insert({
            "user_id":    user_id,
            "company_id": company_id,
        }).execute()
        current = 3.0  # default midpoint
    else:
        current = float(existing.data[0][dimension])

    new_score = max(1.0, min(5.0, current + delta))

    db.table("user_profiles").update({
        dimension:    new_score,
        "updated_at": now,
    }).eq("user_id", user_id).execute()


async def apply_signal(user_id: str, company_id: str, event_type: str) -> None:
    """
    Public entry point called by behavior.py after a successful event insert.
    Fire-and-forget: swallows all exceptions so telemetry never breaks the UI.
    """
    mapping = SIGNAL_MAP.get(event_type)
    if mapping is None:
        return
    dimension, delta = mapping
    try:
        await asyncio.to_thread(_apply_signal_sync, user_id, company_id, dimension, delta)
    except Exception as exc:
        print(f"[profiles] signal map failed for '{event_type}': {exc}")


# ── GET /v1/user-profile ──────────────────────────────────────────────────────

@router.get("/v1/user-profile")
async def get_user_profile(current_user: TokenData = Depends(get_current_user)):
    """Return the current user's preference profile. Returns defaults if no row exists."""

    def _fetch():
        db = get_supabase()
        result = (
            db.table("user_profiles")
            .select("*")
            .eq("user_id", current_user.user_id)
            .execute()
        )
        return result.data[0] if result.data else None

    profile = await asyncio.to_thread(_fetch)

    if profile is None:
        return {
            "user_id":                  current_user.user_id,
            "company_id":               current_user.company_id,
            "role":                     None,
            "explanation_depth":        3.0,
            "technical_level":          3.0,
            "effective_risk_threshold": 0.5,
            "low_signal_flags":         [],
            "auto_select_plu":          False,
            "last_aggregated_at":       None,
        }

    return profile


# ── PATCH /v1/user-profile ────────────────────────────────────────────────────

# Only preference fields the user is allowed to set directly.
_PATCHABLE_FIELDS = {"auto_select_plu"}


class UserProfilePatch(BaseModel):
    auto_select_plu: Optional[bool] = None


@router.patch("/v1/user-profile", status_code=204)
async def patch_user_profile(
    request: UserProfilePatch,
    current_user: TokenData = Depends(get_current_user),
):
    """
    Partial update of user preference fields.
    Creates the profile row with defaults if it does not yet exist.
    Only fields present in _PATCHABLE_FIELDS are accepted.
    """
    updates = {
        k: v for k, v in request.model_dump().items()
        if v is not None and k in _PATCHABLE_FIELDS
    }
    if not updates:
        return Response(status_code=204)

    def _upsert():
        db  = get_supabase()
        now = datetime.now(timezone.utc).isoformat()
        updates["updated_at"] = now

        existing = (
            db.table("user_profiles")
            .select("id")
            .eq("user_id", current_user.user_id)
            .execute()
        )
        if existing.data:
            db.table("user_profiles").update(updates).eq(
                "user_id", current_user.user_id
            ).execute()
        else:
            db.table("user_profiles").insert({
                "user_id":    current_user.user_id,
                "company_id": current_user.company_id,
                **updates,
            }).execute()

    try:
        await asyncio.to_thread(_upsert)
    except Exception as exc:
        print(f"[profiles] profile patch failed: {exc}")

    return Response(status_code=204)


# ── POST /v1/memory/flag-exposure ─────────────────────────────────────────────

class FlagExposureRequest(BaseModel):
    flag_type: str


@router.post("/v1/memory/flag-exposure", status_code=204)
async def record_flag_exposure(
    request: FlagExposureRequest,
    current_user: TokenData = Depends(get_current_user),
):
    """
    Upsert a flag exposure row. Always returns 204; errors are swallowed.
    Call this each time a validation flag is rendered in the UI.
    """

    def _upsert():
        db = get_supabase()
        now = datetime.now(timezone.utc).isoformat()

        existing = (
            db.table("flag_exposures")
            .select("id, exposure_count")
            .eq("user_id", current_user.user_id)
            .eq("flag_type", request.flag_type)
            .execute()
        )

        if existing.data:
            row = existing.data[0]
            db.table("flag_exposures").update({
                "exposure_count": row["exposure_count"] + 1,
                "last_seen_at":   now,
            }).eq("id", row["id"]).execute()
        else:
            db.table("flag_exposures").insert({
                "user_id":    current_user.user_id,
                "company_id": current_user.company_id,
                "flag_type":  request.flag_type,
            }).execute()

    try:
        await asyncio.to_thread(_upsert)
    except Exception as exc:
        print(f"[profiles] flag-exposure upsert failed: {exc}")

    return Response(status_code=204)


# ── POST /v1/memory/dismiss ───────────────────────────────────────────────────

class DismissalRequest(BaseModel):
    flag_type:  str
    risk_score: Optional[float] = None


@router.post("/v1/memory/dismiss", status_code=204)
async def record_dismissal(
    request: DismissalRequest,
    current_user: TokenData = Depends(get_current_user),
):
    """
    Upsert a dismissal row. When dismiss_count reaches AUTO_SUPPRESS_THRESHOLD
    (3), sets auto_suppressed = TRUE and adds the flag to low_signal_flags on
    user_profiles so the context builder knows to suppress it in prompts.
    """

    def _upsert():
        db = get_supabase()
        now = datetime.now(timezone.utc).isoformat()

        existing = (
            db.table("dismissals")
            .select("id, dismiss_count")
            .eq("user_id", current_user.user_id)
            .eq("flag_type", request.flag_type)
            .execute()
        )

        if existing.data:
            row = existing.data[0]
            new_count = row["dismiss_count"] + 1
            auto_suppressed = new_count >= AUTO_SUPPRESS_THRESHOLD

            update_payload: dict = {
                "dismiss_count":     new_count,
                "auto_suppressed":   auto_suppressed,
                "last_dismissed_at": now,
            }
            if request.risk_score is not None:
                update_payload["last_risk_score"] = request.risk_score

            db.table("dismissals").update(update_payload).eq("id", row["id"]).execute()

            # On the crossing of the threshold, add to low_signal_flags
            if auto_suppressed and new_count == AUTO_SUPPRESS_THRESHOLD:
                profile = (
                    db.table("user_profiles")
                    .select("low_signal_flags")
                    .eq("user_id", current_user.user_id)
                    .execute()
                )
                if profile.data:
                    flags: list = profile.data[0]["low_signal_flags"] or []
                    if request.flag_type not in flags:
                        db.table("user_profiles").update({
                            "low_signal_flags": flags + [request.flag_type],
                            "updated_at":       now,
                        }).eq("user_id", current_user.user_id).execute()
        else:
            insert_payload: dict = {
                "user_id":    current_user.user_id,
                "company_id": current_user.company_id,
                "flag_type":  request.flag_type,
            }
            if request.risk_score is not None:
                insert_payload["last_risk_score"] = request.risk_score

            db.table("dismissals").insert(insert_payload).execute()

    try:
        await asyncio.to_thread(_upsert)
    except Exception as exc:
        print(f"[profiles] dismissal upsert failed: {exc}")

    return Response(status_code=204)


# ── POST /v1/memory/investigation ─────────────────────────────────────────────

class InvestigationRequest(BaseModel):
    flag_type:       str
    outcome:         str   # Fraud | VendorError | FalsePositive
    vendor_id:       Optional[str]   = None
    risk_score:      Optional[float] = None
    source_filename: Optional[str]   = None
    notes:           Optional[str]   = None


@router.post("/v1/memory/investigation", status_code=204)
async def record_investigation(
    request: InvestigationRequest,
    current_user: TokenData = Depends(get_current_user),
):
    """
    Insert an investigation outcome row. Invalid outcomes are silently ignored.
    risk_score is stored here and consumed by the nightly aggregator to
    recalibrate effective_risk_threshold.
    """
    if request.outcome not in VALID_OUTCOMES:
        return Response(status_code=204)

    def _insert():
        db = get_supabase()
        db.table("investigations").insert({
            "user_id":         current_user.user_id,
            "company_id":      current_user.company_id,
            "flag_type":       request.flag_type,
            "outcome":         request.outcome,
            "vendor_id":       request.vendor_id,
            "risk_score":      request.risk_score,
            "source_filename": request.source_filename,
            "notes":           request.notes,
        }).execute()

    try:
        await asyncio.to_thread(_insert)
    except Exception as exc:
        print(f"[profiles] investigation insert failed: {exc}")

    return Response(status_code=204)


# ── POST /v1/internal/aggregate-profiles ─────────────────────────────────────

class AggregateRequest(BaseModel):
    secret: str


@router.post("/v1/internal/aggregate-profiles")
async def aggregate_profiles(request: AggregateRequest):
    """
    Nightly aggregator — recomputes per-user preference state.

    Called by pg_cron via pg_net (see migrations/schedule_aggregator.sql).
    Requires AGGREGATOR_SECRET in .env to match request.secret.

    Two operations per user:
      1. Threshold recalibration:
            effective_risk_threshold = (avg(investigation_risk_scores)
                                        + avg(dismissal_risk_scores)) / 2
         Falls back to investigation-only average if no dismissals have scores,
         and makes no change if neither table has scored data for this user.

      2. Behavioral dominance (30-day window):
            Compares skipped_reasoning vs expanded_breakdown event counts.
            If ratio >= 10:1 in either direction, applies a ±0.5 nudge to
            explanation_depth (beyond the real-time ±0.5 per-event nudge).
    """
    expected = os.environ.get("AGGREGATOR_SECRET", "")
    if not expected or request.secret != expected:
        return Response(status_code=403)

    results = await asyncio.to_thread(_aggregate_all)
    return {"aggregated_users": len(results), "details": results}


def _aggregate_all() -> list[dict]:
    """Runs synchronously inside a thread pool."""
    db   = get_supabase()
    now  = datetime.now(timezone.utc)
    window_start = (now - timedelta(days=30)).isoformat()

    profiles = db.table("user_profiles").select(
        "user_id, company_id, explanation_depth, effective_risk_threshold"
    ).execute()

    if not profiles.data:
        return []

    summary = []

    for profile in profiles.data:
        uid = profile["user_id"]
        try:
            # ── 1. Risk threshold recalibration ──────────────────────────
            inv_rows = (
                db.table("investigations")
                .select("risk_score")
                .eq("user_id", uid)
                .execute()
            )
            inv_scores = [
                float(r["risk_score"])
                for r in inv_rows.data
                if r.get("risk_score") is not None
            ]

            dis_rows = (
                db.table("dismissals")
                .select("last_risk_score")
                .eq("user_id", uid)
                .execute()
            )
            dis_scores = [
                float(r["last_risk_score"])
                for r in dis_rows.data
                if r.get("last_risk_score") is not None
            ]

            old_threshold = float(profile["effective_risk_threshold"])

            if inv_scores and dis_scores:
                avg_inv = sum(inv_scores) / len(inv_scores)
                avg_dis = sum(dis_scores) / len(dis_scores)
                new_threshold = round((avg_inv + avg_dis) / 2, 4)
            elif inv_scores:
                new_threshold = round(sum(inv_scores) / len(inv_scores), 4)
            else:
                new_threshold = old_threshold  # no data — leave unchanged

            # Clamp threshold to [0.0, 1.0]
            new_threshold = max(0.0, min(1.0, new_threshold))

            # ── 2. Behavioral dominance (30-day window) ──────────────────
            skipped_result = (
                db.table("behavior_events")
                .select("id")
                .eq("user_id", uid)
                .eq("event_type", "skipped_reasoning")
                .gte("created_at", window_start)
                .execute()
            )
            skipped = len(skipped_result.data)

            expanded_result = (
                db.table("behavior_events")
                .select("id")
                .eq("user_id", uid)
                .eq("event_type", "expanded_breakdown")
                .gte("created_at", window_start)
                .execute()
            )
            expanded = len(expanded_result.data)

            old_depth = float(profile["explanation_depth"])
            new_depth = old_depth

            if skipped >= 10 and expanded == 0:
                # Strong brevity dominance
                new_depth = max(1.0, old_depth - 1.0)
            elif expanded >= 10 and skipped == 0:
                # Strong verbosity dominance
                new_depth = min(5.0, old_depth + 1.0)
            elif skipped > 0 and expanded > 0:
                ratio = skipped / expanded
                if ratio >= 10:
                    new_depth = max(1.0, old_depth - 0.5)
                elif ratio <= 0.1:
                    new_depth = min(5.0, old_depth + 0.5)

            # ── 3. Persist ────────────────────────────────────────────────
            db.table("user_profiles").update({
                "effective_risk_threshold": new_threshold,
                "explanation_depth":        new_depth,
                "last_aggregated_at":       now.isoformat(),
                "updated_at":               now.isoformat(),
            }).eq("user_id", uid).execute()

            summary.append({
                "user_id":           uid,
                "old_threshold":     old_threshold,
                "new_threshold":     new_threshold,
                "skipped_30d":       skipped,
                "expanded_30d":      expanded,
                "old_depth":         old_depth,
                "new_depth":         new_depth,
            })

        except Exception as exc:
            print(f"[aggregator] failed for user {uid}: {exc}")

    return summary
