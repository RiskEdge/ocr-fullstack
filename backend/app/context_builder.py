"""
context_builder.py — Phase 3: Context Translation & Agentic Logic

Builds a personalised context block from the user's stored preference profile
and injects it into Gemini system prompts so the model's responses adapt to
the individual operator without any manual prompt-engineering.

Public API
----------
  await build_context_block(user_id, company_id, vendor_id=None) -> str

Returns an XML-tagged text block ready to be prepended to any Gemini prompt.
Returns an empty string if the user has no profile yet, or on any error —
it must never raise or block the calling workflow.

Reads three tables (all in a single thread-pool call to avoid event-loop blocking):
  user_profiles    — preference scores, suppressed flags, role
  flag_exposures   — per-flag view counts (skip preamble when count > 2)
  investigations   — past investigation outcomes (recent 5, optionally by vendor)
"""

import asyncio
from typing import Optional

from app.db import get_supabase


# ---------------------------------------------------------------------------
# Score → natural-language instruction mappings
# ---------------------------------------------------------------------------

def _depth_instruction(score: float) -> str:
    """Maps explanation_depth (1–5) to a prose instruction for the model."""
    if score < 2.0:
        return "Be extremely concise — 2-3 sentences maximum. Skip all reasoning sections."
    if score < 3.0:
        return "Be brief. State findings only; omit explanations."
    if score < 4.0:
        return "Standard analytical depth. Use bullet points where helpful."
    if score < 4.5:
        return "Provide thorough analysis with clear reasoning for each finding."
    return "Provide a comprehensive technical breakdown. Detail every step and comparison."


def _tech_instruction(score: float) -> str:
    """Maps technical_level (1–5) to a prose instruction for the model."""
    if score < 2.0:
        return "Use plain language. Avoid technical jargon."
    if score < 3.0:
        return "Use clear language with minimal jargon."
    if score < 4.0:
        return "Standard technical language appropriate for a procurement professional."
    if score < 4.5:
        return "Use technical terminology. Assume domain expertise."
    return "Use precise technical terminology. Assume expert-level knowledge."


# ---------------------------------------------------------------------------
# Synchronous DB fetch (runs inside a thread pool)
# ---------------------------------------------------------------------------

def _build_sync(user_id: str, vendor_id: Optional[str]) -> str:
    db = get_supabase()

    # ── 1. User profile ──────────────────────────────────────────────────────
    profile_result = (
        db.table("user_profiles")
        .select(
            "role, explanation_depth, technical_level, "
            "effective_risk_threshold, low_signal_flags, auto_select_plu"
        )
        .eq("user_id", user_id)
        .execute()
    )
    if not profile_result.data:
        return ""  # No profile yet — nothing to inject

    p               = profile_result.data[0]
    depth           = float(p.get("explanation_depth") or 3.0)
    tech            = float(p.get("technical_level") or 3.0)
    threshold       = float(p.get("effective_risk_threshold") or 0.5)
    role            = p.get("role") or "Procurement Analyst"
    suppressed: list[str] = p.get("low_signal_flags") or []
    auto_select_plu = bool(p.get("auto_select_plu", False))

    # ── 2. Flag exposures — skip preamble for flags seen > 2 times ───────────
    exp_result = (
        db.table("flag_exposures")
        .select("flag_type, exposure_count")
        .eq("user_id", user_id)
        .gt("exposure_count", 2)
        .execute()
    )
    seen_flags = [r["flag_type"] for r in (exp_result.data or [])]

    # ── 3. Recent investigations (last 5, optionally filtered by vendor) ─────
    inv_query = (
        db.table("investigations")
        .select("flag_type, outcome, vendor_id, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(5)
    )
    if vendor_id:
        inv_query = inv_query.eq("vendor_id", vendor_id)
    investigations = (inv_query.execute().data) or []

    # ── 4. Assemble context block ────────────────────────────────────────────
    lines = [
        f"Role: {role}.",
        f"Response depth: {_depth_instruction(depth)}",
        f"Technical level: {_tech_instruction(tech)}",
        (
            f"Risk threshold: {threshold:.2f} — "
            "only surface issues with risk above this threshold."
        ),
    ]

    if suppressed:
        lines.append(
            "Do not mention these flag types (suppressed for this user): "
            + ", ".join(suppressed) + "."
        )

    if seen_flags:
        lines.append(
            "User has seen these flags many times — skip introductory definitions, "
            "go straight to the specific finding: "
            + ", ".join(seen_flags) + "."
        )

    if investigations:
        inv_parts = []
        for inv in investigations:
            date = (inv.get("created_at") or "")[:10] or "unknown date"
            vendor = f" (vendor {inv['vendor_id']})" if inv.get("vendor_id") else ""
            inv_parts.append(
                f"{inv['outcome']} confirmed for {inv['flag_type']}{vendor} on {date}"
            )
        lines.append("Past investigation history: " + "; ".join(inv_parts) + ".")

    if auto_select_plu:
        lines.append(
            "PLU auto-selection is ON: when multiple PLUs match an EAN, "
            "select the best one decisively without hedging."
        )

    body = "\n".join(lines)
    return f"<user_context>\n{body}\n</user_context>"


# ---------------------------------------------------------------------------
# Public async entry point
# ---------------------------------------------------------------------------

async def build_context_block(
    user_id: str,
    company_id: str,
    vendor_id: Optional[str] = None,
) -> str:
    """
    Returns a personalised context block for injection into Gemini prompts.
    Always returns a string — empty string if no profile exists or on error.
    """
    try:
        return await asyncio.to_thread(_build_sync, user_id, vendor_id)
    except Exception as exc:
        print(f"[context_builder] failed for user {user_id}: {exc}")
        return ""


async def get_user_preferences(user_id: str) -> dict:
    """
    Returns lightweight preference flags from user_profiles.
    Used by validate_items to make branching decisions without parsing the
    full context block string.

    Returns defaults on any error so callers never need to guard.
    """
    def _fetch() -> dict:
        result = (
            get_supabase()
            .table("user_profiles")
            .select("auto_select_plu")
            .eq("user_id", user_id)
            .execute()
        )
        return result.data[0] if result.data else {}

    try:
        data = await asyncio.to_thread(_fetch)
        return {"auto_select_plu": bool(data.get("auto_select_plu", False))}
    except Exception as exc:
        print(f"[context_builder] get_user_preferences failed for {user_id}: {exc}")
        return {"auto_select_plu": False}
