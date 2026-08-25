import os
import threading
from supabase import create_client, Client
import dotenv

dotenv.load_dotenv()

_local = threading.local()


def get_supabase() -> Client:
    """
    Return this thread's Supabase client, created on first use and reused.

    Deliberately per-thread rather than per-process. The client wraps a
    synchronous httpx connection pool, and several call sites fan queries out
    across a thread pool (see ValidationProcessor._fetch_candidates_by_name)
    from inside an asyncio.to_thread worker. Driving one pool from several
    threads at once races on the underlying socket; on Windows that surfaces as
    WinError 10035 (WSAEWOULDBLOCK) and fails the whole request. A client per
    thread keeps the parallelism without the shared socket.

    Callers must therefore reuse their threads — a fresh pool per call would
    pay for a new client, and a new TLS handshake, on every single query.
    """
    client: Client | None = getattr(_local, "client", None)
    if client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        client = create_client(url, key)
        _local.client = client
    return client
