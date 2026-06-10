"""
sync_client.py — Production sync tool for clients.

Reads a product catalog from a CSV or JSON file and pushes it to the
master data sync API. Safe to run on every ERP export (upsert by default).

Usage:
    python sync_client.py --file products.csv --client-code STR122 --secret <your_sync_secret>
    python sync_client.py --file products.json --client-code STR122 --secret <your_sync_secret>
    python sync_client.py --file products.csv --client-code STR122 --secret <your_sync_secret> --mode replace
    python sync_client.py --file products.csv --client-code STR122 --secret <your_sync_secret> --url https://your-api-domain.com

Options:
    --file          Path to CSV or JSON file containing product data (required)
    --client-code   Your company client code, e.g. STR122 (required)
    --secret        Your sync API secret key (required)
    --url           API base URL (default: http://localhost:8010)
    --mode          upsert (default) — add/update rows
                    replace — wipe your catalog first, then insert fresh

CSV column names are flexible — the server accepts common ERP variants.
Required column: plu_code (or PLU Code, PLUCode, etc.)
"""

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' library not installed. Run: pip install requests")
    sys.exit(1)

DEFAULT_URL = "http://localhost:8010"
ENDPOINT    = "/v1/sync/master-data"


def load_csv(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return [row for row in reader]


def load_json(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "products" in data:
        return data["products"]
    print("ERROR: JSON must be a list of products, or an object with a 'products' key.")
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Push product catalog to the master sync API.")
    parser.add_argument("--file",        required=True,  help="Path to CSV or JSON file")
    parser.add_argument("--client-code", required=True,  help="Your company client code (e.g. STR122)")
    parser.add_argument("--secret",      required=True,  help="Your sync API secret key")
    parser.add_argument("--url",         default=DEFAULT_URL, help=f"API base URL (default: {DEFAULT_URL})")
    parser.add_argument("--mode",        default="upsert", choices=["upsert", "replace"],
                        help="upsert (default) or replace")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"ERROR: File not found: {path}")
        sys.exit(1)

    suffix = path.suffix.lower()
    if suffix == ".csv":
        products = load_csv(path)
    elif suffix == ".json":
        products = load_json(path)
    else:
        print(f"ERROR: Unsupported file type '{suffix}'. Use .csv or .json")
        sys.exit(1)

    if not products:
        print("ERROR: File contains no products.")
        sys.exit(1)

    print(f"  Loaded {len(products)} product(s) from {path.name}")
    print(f"  Client code : {args.client_code}")
    print(f"  Mode        : {args.mode}")
    print(f"  Target      : {args.url}{ENDPOINT}")
    print()

    payload = {
        "client_code": args.client_code,
        "mode":        args.mode,
        "products":    products,
    }

    try:
        resp = requests.post(
            f"{args.url}{ENDPOINT}",
            json=payload,
            headers={"Authorization": f"Bearer {args.secret}"},
            timeout=60,
        )
    except requests.exceptions.ConnectionError:
        print(f"ERROR: Could not connect to {args.url}. Is the server running?")
        sys.exit(1)
    except requests.exceptions.Timeout:
        print("ERROR: Request timed out after 60 seconds.")
        sys.exit(1)

    if resp.status_code == 200:
        result = resp.json()

        def _fmt(iso: str | None) -> str:
            if not iso:
                return "Never"
            try:
                dt = datetime.fromisoformat(iso).astimezone(timezone.utc)
                return dt.strftime("%d %b %Y  %H:%M:%S UTC")
            except Exception:
                return iso

        print("SUCCESS")
        print(f"  Records synced  : {result.get('records_synced', '?')}")
        print(f"  Records skipped : {result.get('records_skipped', '?')} (missing plu_code)")
        print(f"  Mode            : {result.get('mode', '?')}")
        print(f"  Synced at       : {_fmt(result.get('triggered_at'))}")
        print(f"  Last synced at  : {_fmt(result.get('last_synced_at'))}")
    else:
        print(f"FAILED  (HTTP {resp.status_code})")
        try:
            print(f"  Detail: {resp.json().get('detail', resp.text)}")
        except Exception:
            print(f"  Response: {resp.text[:300]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
