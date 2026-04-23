import asyncio
import re
from typing import List, Any
from pydantic import BaseModel

from fastapi import FastAPI, File, HTTPException, UploadFile, Depends, status, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from passlib.context import CryptContext

import dotenv
import os

dotenv.load_dotenv()

from app.ocr import OCRProcessor
from app.validation import ValidationProcessor
from app.auth_utils import create_access_token, get_current_user, TokenData
from app.db import get_supabase
from app.behavior import router as behavior_router
from app.profiles import router as profiles_router

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

app = FastAPI()

origins = [
    "http://localhost:3000",
    "http://localhost:3010",
    "https://docu-scan.riskedgesolutions.com",
    "https://invoice-vision.riskedgesolutions.com"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(behavior_router)
app.include_router(profiles_router)

class LoginRequest(BaseModel):
    company_name: str
    username: str
    password: str

processor  = OCRProcessor(api_key=os.environ["GEMINI_API_KEY"])
validator  = ValidationProcessor(client=processor.client)

@app.get("/")
async def root():
    return JSONResponse(content={"message": "Backend is working!"})

@app.post("/v1/login")
async def login(req: LoginRequest):
    db = get_supabase()
    result = (
        db.table("users")
        .select("username, password, companies(name)")
        .eq("username", req.username)
        .execute()
    )

    user = result.data[0] if result.data else None
    company_name = user["companies"]["name"] if user else None

    if not user or company_name != req.company_name or not pwd_context.verify(req.password[:72], user["password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect company name, username or password"
        )

    # Fetch user_id and company_id to embed in JWT (avoids a DB lookup on every request)
    ids_result = (
        db.table("users")
        .select("id, company_id")
        .eq("username", req.username)
        .single()
        .execute()
    )
    user_id = ids_result.data["id"]
    company_id = ids_result.data["company_id"]

    access_token = create_access_token(data={
        "sub": req.username,
        "company": req.company_name,
        "user_id": user_id,
        "company_id": company_id,
    })

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {"username": req.username, "company": req.company_name}
    }

@app.get("/v1/credits")
async def get_credits(current_user: TokenData = Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("companies")
        .select("credits")
        .eq("id", current_user.company_id)
        .single()
        .execute()
    )
    return {"credits": result.data["credits"]}


@app.post("/v1/process-invoice")
async def process_invoice_stream(
    files: List[UploadFile] = File(...),
    current_user: TokenData = Depends(get_current_user)):
    print(f"User {current_user.username} from {current_user.company} is processing {len(files)} files...")

    if len(files) > 100:
        raise HTTPException(status_code=400, detail="Maximum of 100 files allowed.")

    # Check company has at least 1 credit before processing.
    # Exact page count is unknown upfront — the final per-page deduction
    # happens after processing completes in stream_documents().
    db = get_supabase()
    credits_result = (
        db.table("companies")
        .select("credits")
        .eq("id", current_user.company_id)
        .single()
        .execute()
    )
    available_credits = credits_result.data["credits"]
    if available_credits < 1:
        raise HTTPException(
            status_code=402,
            detail="No credits remaining. Please contact support to top up your balance."
        )

    # Read all file bytes NOW, before returning StreamingResponse.
    # UploadFile temp files are closed by Starlette once the response starts,
    # so reading inside the async generator causes "I/O on closed file".
    file_data = []
    for file in files:
        content = await file.read()
        file_data.append((content, file.filename, file.content_type))

    return StreamingResponse(
        processor.stream_documents(file_data, current_user.user_id, current_user.company_id),
        media_type="application/x-ndjson",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


class ValidateDataRequest(BaseModel):
    items: list[dict]
    source_filename: str | None = None


@app.post("/v1/validate-data")
async def validate_data(
    request: ValidateDataRequest,
    current_user: TokenData = Depends(get_current_user),
):
    from datetime import datetime, timezone
    started_at = datetime.now(timezone.utc)

    try:
        validated, stats = await validator.validate_items(
            request.items,
            user_id=current_user.user_id,
            company_id=current_user.company_id,
        )
        run_status = "completed"
    except Exception as e:
        print(f"[validate-data] validation failed: {e}")
        raise HTTPException(status_code=500, detail="Validation failed.")

    completed_at  = datetime.now(timezone.utc)
    duration_ms   = int((completed_at - started_at).total_seconds() * 1000)
    gemini_calls  = stats["gemini_calls"]
    credits_used  = gemini_calls

    # Deduct credits and log run in a single thread
    remaining_credits = None
    try:
        user_id    = current_user.user_id
        company_id = current_user.company_id
        filename   = request.source_filename
        env        = os.environ.get("ENVIRONMENT", "production")

        def _deduct_and_log():
            db = get_supabase()

            # Credit deduction
            new_credits = None
            if credits_used > 0:
                row = db.table("companies").select("credits").eq("id", company_id).single().execute()
                new_credits = max(0, row.data["credits"] - credits_used)
                db.table("companies").update({"credits": new_credits}).eq("id", company_id).execute()
                print(f"[validate-data] deducted {credits_used} credit(s), remaining: {new_credits}")

            # Log validation run
            db.table("validation_runs").insert({
                "user_id":           user_id,
                "company_id":        company_id,
                "source_filename":   filename,
                "total_items":       len(request.items),
                "matched_exact":     stats["matched_exact"],
                "matched_fuzzy":     stats["matched_fuzzy"],
                "matched_multi_plu": stats["matched_multi_plu"],
                "no_match":          stats["no_match"],
                "valid_items":       stats["valid_items"],
                "items_with_issues": stats["items_with_issues"],
                "gemini_calls":      gemini_calls,
                "credits_used":      credits_used,
                "status":            run_status,
                "duration_ms":       duration_ms,
                "started_at":        started_at.isoformat(),
                "completed_at":      completed_at.isoformat(),
                "environment":       env,
            }).execute()

            return new_credits

        remaining_credits = await asyncio.to_thread(_deduct_and_log)
    except Exception as e:
        print(f"[validate-data] FAILED to deduct credits / log run: {e}")

    return {
        "validated_items":  validated,
        "credits_used":     credits_used,
        "remaining_credits": remaining_credits,
    }
