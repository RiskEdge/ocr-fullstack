import uvicorn
import os

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8010))
    uvicorn.run("app.api:app", host="0.0.0.0", port=port)
    # uvicorn.run("app.api:app", host="0.0.0.0", port=8000, reload=True)