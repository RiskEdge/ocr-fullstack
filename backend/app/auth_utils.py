from typing import Optional
from datetime import datetime, timedelta, timezone
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

import os
import dotenv

dotenv.load_dotenv()

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 90

class TokenData(BaseModel):
    username: str
    user_id: str
    role: str = "user"
    company_id: Optional[str] = None
    company: Optional[str] = None
    partner_id: Optional[str] = None
    partner: Optional[str] = None
    is_superadmin: bool = False  # derived from role == 'superadmin'; kept for backward compat

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, os.environ["SECRET_KEY"], algorithm=os.environ["ALGORITHM"])

async def get_current_user(token: str = Depends(oauth2_scheme)):
    """Dependency that protects routes. Decodes the JWT and ensures it is valid."""

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"}
    )

    try:
        payload = jwt.decode(token, os.environ["SECRET_KEY"], algorithms=[os.environ["ALGORITHM"]])
        username: str = payload.get("sub")
        user_id: str = payload.get("user_id")
        if not username or not user_id:
            raise credentials_exception
        role = payload.get("role", "user")
        return TokenData(
            username=username,
            user_id=user_id,
            role=role,
            company_id=payload.get("company_id"),
            company=payload.get("company"),
            partner_id=payload.get("partner_id"),
            partner=payload.get("partner"),
            is_superadmin=role == "superadmin",
        )
    except JWTError:
        raise credentials_exception
