import os
from supabase import create_client, Client
import dotenv

dotenv.load_dotenv()

_client: Client | None = None


def get_supabase() -> Client:
    """Return a module-level Supabase client (created once, reused)."""
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        _client = create_client(url, key)
    return _client
