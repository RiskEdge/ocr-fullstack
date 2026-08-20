import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from pydantic import BaseModel

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, Depends, status
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
from app.profiles import router as profiles_router, _aggregate_all
from app.admin import router as admin_router
from app.sync import router as sync_router

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


async def _nightly_aggregator():
    """Runs _aggregate_all once per day at midnight UTC."""
    while True:
        now = datetime.now(timezone.utc)
        next_midnight = (now + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        await asyncio.sleep((next_midnight - now).total_seconds())
        try:
            results = await asyncio.to_thread(_aggregate_all)
            print(f"[scheduler] nightly aggregator complete — {len(results)} users updated")
        except Exception as exc:
            print(f"[scheduler] nightly aggregator failed: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_nightly_aggregator())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)

origins = [
    "http://localhost:3020",
    "http://localhost:3010",
    "https://invoice-vision.riskedgesolutions.com",
    "https://invoice-vision-admin.riskedgesolutions.com"
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
app.include_router(admin_router)
app.include_router(sync_router)

class LoginRequest(BaseModel):
    company_name: Optional[str] = None
    username: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

processor  = OCRProcessor(api_key=os.environ["GEMINI_API_KEY"])
validator  = ValidationProcessor(client=processor.client)

@app.get("/")
async def root():
    return JSONResponse(content={"message": "Backend is working!"})


def _record_login_event(**fields):
    """Insert one row into login_events. Never raises — auditing must not break login."""
    try:
        db = get_supabase()
        db.table("login_events").insert(fields).execute()
    except Exception as exc:
        print(f"[login-audit] failed to record login event: {exc}")


@app.post("/v1/login")
async def login(req: LoginRequest, request: Request):
    db = get_supabase()
    _bad_creds = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect credentials")

    login_type = "company" if req.company_name else "global"
    ip_address = (request.headers.get("x-forwarded-for") or request.client.host if request.client else None)
    if ip_address and "," in ip_address:
        ip_address = ip_address.split(",")[0].strip()
    user_agent = request.headers.get("user-agent")

    def _log(*, success, user_id=None, company_id=None, role=None, failure_reason=None):
        _record_login_event(
            user_id=user_id,
            company_id=company_id,
            username=req.username,
            company_name=req.company_name,
            role=role,
            login_type=login_type,
            success=success,
            failure_reason=failure_reason,
            ip_address=ip_address,
            user_agent=user_agent,
        )

    if req.company_name:
        # --- Company-scoped login (client_admin / user) ---
        company_res = db.table("companies").select("id, is_active").eq("name", req.company_name).execute()
        if not company_res.data:
            _log(success=False, failure_reason="bad_credentials")
            raise _bad_creds
        company_row = company_res.data[0]
        company_id  = company_row["id"]

        if not company_row.get("is_active", True):
            _log(success=False, company_id=company_id, failure_reason="company_deactivated")
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="company_deactivated")

        user_res = (
            db.table("users")
            .select("id, password, role, is_active")
            .eq("username", req.username)
            .eq("company_id", company_id)
            .execute()
        )
        user = user_res.data[0] if user_res.data else None
        if not user or not pwd_context.verify(req.password[:72], user["password"]):
            _log(success=False, company_id=company_id, failure_reason="bad_credentials")
            raise _bad_creds

        if not user.get("is_active", True):
            _log(success=False, user_id=user["id"], company_id=company_id,
                 role=user.get("role"), failure_reason="account_deactivated")
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="account_deactivated")

        role = user.get("role", "user")
        if role not in ("client_admin", "user"):
            _log(success=False, user_id=user["id"], company_id=company_id,
                 role=role, failure_reason="wrong_login_endpoint")
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Use global login for admin accounts.")

        access_token = create_access_token(data={
            "sub": req.username,
            "role": role,
            "user_id": user["id"],
            "company_id": company_id,
            "company": req.company_name,
            "is_superadmin": False,
        })
        _log(success=True, user_id=user["id"], company_id=company_id, role=role)
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "user": {"username": req.username, "company": req.company_name, "role": role},
        }

    else:
        # --- Global login (superadmin / partner_admin) ---
        user_res = (
            db.table("users")
            .select("id, password, role, partner_id, partners(name)")
            .eq("username", req.username)
            .execute()
        )
        user = next((u for u in user_res.data if u.get("role") in ("superadmin", "partner_admin")), None)
        if not user or not pwd_context.verify(req.password[:72], user["password"]):
            _log(success=False, failure_reason="bad_credentials")
            raise _bad_creds

        role = user["role"]
        partner_id = user.get("partner_id")
        partner_name = (user.get("partners") or {}).get("name") if partner_id else None

        token_data: dict = {
            "sub": req.username,
            "role": role,
            "user_id": user["id"],
            "is_superadmin": role == "superadmin",
        }
        if partner_id:
            token_data["partner_id"] = partner_id
            token_data["partner"] = partner_name

        access_token = create_access_token(data=token_data)
        _log(success=True, user_id=user["id"], role=role)
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "user": {"username": req.username, "role": role, "partner": partner_name},
        }


@app.get("/v1/companies")
async def list_companies():
    """Public endpoint — returns all client companies for the login dropdown."""
    db = get_supabase()
    result = db.table("companies").select("id, name").order("name").execute()
    return result.data or []

@app.patch("/v1/user/change-password")
async def change_password(
    req: ChangePasswordRequest,
    current_user: TokenData = Depends(get_current_user),
):
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")

    db = get_supabase()
    user_res = db.table("users").select("password").eq("id", current_user.user_id).single().execute()
    if not user_res.data:
        raise HTTPException(status_code=404, detail="User not found.")

    stored_hash = user_res.data["password"]
    if not pwd_context.verify(req.current_password[:72], stored_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")

    if pwd_context.verify(req.new_password[:72], stored_hash):
        raise HTTPException(status_code=400, detail="New password must differ from the current one.")

    new_hash = pwd_context.hash(req.new_password[:72])
    db.table("users").update({"password": new_hash}).eq("id", current_user.user_id).execute()

    return {"message": "Password updated successfully."}


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


# Accepted upload formats for OCR — mirrors the client-side guard in
# frontend/ocr-riskedge/src/components/FileUpload.tsx.
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif"}


def _is_supported_upload(filename: str | None, content_type: str | None) -> bool:
    if content_type and content_type != "application/octet-stream":
        return content_type.startswith("image/") or content_type == "application/pdf"
    # Some clients omit or genericise the MIME type — fall back to the extension.
    ext = filename.rsplit(".", 1)[-1].lower() if filename and "." in filename else ""
    return ext == "pdf" or ext in IMAGE_EXTENSIONS


@app.post("/v1/process-invoice")
async def process_invoice_stream(
    files: List[UploadFile] = File(...),
    current_user: TokenData = Depends(get_current_user)):
    print(f"User {current_user.username} from {current_user.company} is processing {len(files)} files...")

    if len(files) > 100:
        raise HTTPException(status_code=400, detail="Maximum of 100 files allowed.")

    # Reject before any file read, credit check or Gemini call.
    unsupported = [
        file.filename or "(unnamed file)"
        for file in files
        if not _is_supported_upload(file.filename, file.content_type)
    ]
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=(
                "Only image and PDF files can be processed. Unsupported: "
                + ", ".join(unsupported)
            ),
        )

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

    completed_at = datetime.now(timezone.utc)
    duration_ms  = int((completed_at - started_at).total_seconds() * 1000)
    gemini_calls = stats["gemini_calls"]

    # Log validation run (no credit deduction — validation is free)
    try:
        user_id    = current_user.user_id
        company_id = current_user.company_id
        filename   = request.source_filename
        env        = os.environ.get("ENVIRONMENT", "production")

        def _log():
            db = get_supabase()
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
                "credits_used":      0,
                "status":            run_status,
                "duration_ms":       duration_ms,
                "started_at":        started_at.isoformat(),
                "completed_at":      completed_at.isoformat(),
                "environment":       env,
            }).execute()

        await asyncio.to_thread(_log)
    except Exception as e:
        print(f"[validate-data] FAILED to log run: {e}")

    return {"validated_items": validated}
