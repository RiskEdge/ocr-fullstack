from typing import List
from pydantic import BaseModel

from fastapi import FastAPI, File, HTTPException, UploadFile, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

import dotenv
import os
import json

dotenv.load_dotenv()

from app.ocr import OCRProcessor
from app.auth_utils import create_access_token, get_current_user, TokenData

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
    
def load_users():
    raw_users = os.environ["MOCK_USERS"]
    try:
        users_list = json.loads(raw_users)
        return {u["username"]: u for u in users_list}
    except json.JSONDecodeError:
        print("Error: MOCK_USERS in .env is not valid JSON")
        return {}
    
MOCK_USERS = load_users()

processor = OCRProcessor(api_key=os.environ["GEMINI_API_KEY"])

@app.get("/")
async def root():
    return JSONResponse(content={"message": "Backend is working!"})

@app.post("/v1/login")
async def login(req: LoginRequest):
    user = MOCK_USERS.get(req.username)
    
    if not user or user["password"] != req.password or user["company"] != req.company_name:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect company name, username or password"
        )
        
    access_token = create_access_token(data={"sub": req.username, "company": req.company_name})
    
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
    return StreamingResponse(processor.stream_documents(files), media_type="application/x-ndjson")
 
