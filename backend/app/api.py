from typing import List
from pydantic import BaseModel

from fastapi import FastAPI, File, HTTPException, UploadFile, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from passlib.context import CryptContext

import dotenv
import os

dotenv.load_dotenv()

from app.ocr import OCRProcessor
from app.auth_utils import create_access_token, get_current_user, TokenData
from app.db import get_supabase

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

app = FastAPI()

origins = [
    "http://localhost:3000",
    "http://localhost:3010",
    "https://docu-scan.riskedgesolutions.com"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class LoginRequest(BaseModel):
    company_name: str
    username: str
    password: str

processor = OCRProcessor(api_key=os.environ["GEMINI_API_KEY"])

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

@app.post("/v1/process-invoice")
async def process_invoice_stream(
    files: List[UploadFile] = File(...),
    current_user: TokenData = Depends(get_current_user)):
    print(f"User {current_user.username} from {current_user.company} is processing {len(files)} files...")
    
    if len(files) > 100:
        raise HTTPException(status_code=400, detail="Maximum of 100 files allowed.")
    
    print(files)
    return StreamingResponse(
        processor.stream_documents(files, current_user.user_id, current_user.company_id),
        media_type="application/x-ndjson",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )
 
