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
    company: str
    user_id: str
    company_id: str
    
def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, os.environ["SECRET_KEY"], algorithm=os.environ["ALGORITHM"])

async def get_current_user(token: str = Depends(oauth2_scheme)):
    """Dpendency that protect the routes.
    It decodes the JWT and ensure it's valid."""
    
    credentials_expection = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"}
    )
    
    try:
        payload = jwt.decode(token, os.environ["SECRET_KEY"], algorithms=[os.environ["ALGORITHM"]])
        username: str = payload.get("sub")
        company: str = payload.get("company")
        user_id: str = payload.get("user_id")
        company_id: str = payload.get("company_id")
        if not all([username, company, user_id, company_id]):
            raise credentials_expection
        return TokenData(username=username, company=company, user_id=user_id, company_id=company_id)
    except JWTError:
        raise credentials_expection