"""
Seed product_catalog with demo data for a named demo company.

Usage:
    python seed_demo_catalog.py --company-name "Demo Company"
    python seed_demo_catalog.py --company-id  <uuid>
    python seed_demo_catalog.py --company-name "Demo Company" --clear

Options:
    --company-name  Look up the company by name.
    --company-id    Use the company UUID directly.
    --clear         Delete existing rows for this company before inserting.
                    Default behaviour is upsert (safe to re-run).
"""

import argparse
import os
import sys
import dotenv

dotenv.load_dotenv()

from app.db import get_supabase

# ---------------------------------------------------------------------------
# Demo product data — realistic FMCG catalog across multiple categories
# Covers 0%, 5%, 12%, 18% GST to test different tax scenarios.
# ---------------------------------------------------------------------------
DEMO_PRODUCTS = [
    # ── Staples (5% GST) ────────────────────────────────────────────────────
    {
        "sku_code": "SKU001", "plu_code": "100101",
        "sku_description": "AASHIRVAAD ATTA 5KG", "sku_short_description": "ATTA 5KG",
        "gst_percent": 5.00, "ean_code": "8901234567890",
        "basic_price": 270.00, "cost_price": 280.00, "mrp": 320.00, "sale_price": 300.00,
        "priority": 1, "uom": "PKT", "uom_qty": 1, "hsn_code": "11010000", "status": "0",
    },
    {
        "sku_code": "SKU002", "plu_code": "100102",
        "sku_description": "AASHIRVAAD ATTA 10KG", "sku_short_description": "ATTA 10KG",
        "gst_percent": 5.00, "ean_code": "8901234567891",
        "basic_price": 530.00, "cost_price": 545.00, "mrp": 620.00, "sale_price": 590.00,
        "priority": 1, "uom": "PKT", "uom_qty": 1, "hsn_code": "11010000", "status": "0",
    },
    {
        "sku_code": "SKU003", "plu_code": "100103",
        "sku_description": "INDIA GATE BASMATI RICE 5KG", "sku_short_description": "BASMATI 5KG",
        "gst_percent": 5.00, "ean_code": "8901234567892",
        "basic_price": 400.00, "cost_price": 415.00, "mrp": 480.00, "sale_price": 450.00,
        "priority": 1, "uom": "PKT", "uom_qty": 1, "hsn_code": "10063020", "status": "0",
    },
    {
        "sku_code": "SKU004", "plu_code": "100104",
        "sku_description": "TATA SALT 1KG", "sku_short_description": "SALT 1KG",
        "gst_percent": 0.00, "ean_code": "8901234567893",
        "basic_price": 18.00, "cost_price": 20.00, "mrp": 24.00, "sale_price": 22.00,
        "priority": 1, "uom": "PKT", "uom_qty": 24, "hsn_code": "25010020", "status": "0",
    },
    # ── Oils & Ghee (5% GST) ─────────────────────────────────────────────────
    {
        "sku_code": "SKU005", "plu_code": "100201",
        "sku_description": "FORTUNE SUNFLOWER OIL 1LTR", "sku_short_description": "SF OIL 1L",
        "gst_percent": 5.00, "ean_code": "8901234567894",
        "basic_price": 130.00, "cost_price": 136.00, "mrp": 155.00, "sale_price": 145.00,
        "priority": 1, "uom": "LTR", "uom_qty": 1, "hsn_code": "15121100", "status": "0",
    },
    {
        "sku_code": "SKU006", "plu_code": "100202",
        "sku_description": "AMUL PURE GHEE 1KG", "sku_short_description": "GHEE 1KG",
        "gst_percent": 12.00, "ean_code": "8901234567895",
        "basic_price": 520.00, "cost_price": 535.00, "mrp": 610.00, "sale_price": 580.00,
        "priority": 1, "uom": "PCS", "uom_qty": 6, "hsn_code": "04059010", "status": "0",
    },
    # ── Dairy (12% GST) ──────────────────────────────────────────────────────
    {
        "sku_code": "SKU007", "plu_code": "100301",
        "sku_description": "AMUL BUTTER 500G", "sku_short_description": "BUTTER 500G",
        "gst_percent": 12.00, "ean_code": "8901234567896",
        "basic_price": 220.00, "cost_price": 228.00, "mrp": 260.00, "sale_price": 245.00,
        "priority": 1, "uom": "PCS", "uom_qty": 12, "hsn_code": "04051000", "status": "0",
    },
    {
        "sku_code": "SKU008", "plu_code": "100302",
        "sku_description": "NESTLE MILKMAID 400G", "sku_short_description": "MILKMAID 400G",
        "gst_percent": 12.00, "ean_code": "8901234567897",
        "basic_price": 78.00, "cost_price": 82.00, "mrp": 95.00, "sale_price": 89.00,
        "priority": 1, "uom": "PCS", "uom_qty": 24, "hsn_code": "04029910", "status": "0",
    },
    # ── Beverages (18% GST) ──────────────────────────────────────────────────
    {
        "sku_code": "SKU009", "plu_code": "100401",
        "sku_description": "COCA COLA 2LTR", "sku_short_description": "COKE 2L",
        "gst_percent": 28.00, "ean_code": "8901234567898",
        "basic_price": 68.00, "cost_price": 72.00, "mrp": 90.00, "sale_price": 82.00,
        "priority": 1, "uom": "PCS", "uom_qty": 12, "hsn_code": "22021010", "status": "0",
    },
    {
        "sku_code": "SKU010", "plu_code": "100402",
        "sku_description": "RED BULL ENERGY DRINK 250ML", "sku_short_description": "RED BULL 250ML",
        "gst_percent": 28.00, "ean_code": "8901234567899",
        "basic_price": 95.00, "cost_price": 100.00, "mrp": 125.00, "sale_price": 115.00,
        "priority": 1, "uom": "PCS", "uom_qty": 24, "hsn_code": "22029090", "status": "0",
    },
    # ── Personal Care (18% GST) ──────────────────────────────────────────────
    {
        "sku_code": "SKU011", "plu_code": "100501",
        "sku_description": "SANTOOR SOAP 100G", "sku_short_description": "SANTOOR 100G",
        "gst_percent": 18.00, "ean_code": "8901399000591",
        "basic_price": 28.00, "cost_price": 30.00, "mrp": 38.00, "sale_price": 35.00,
        "priority": 1, "uom": "PCS", "uom_qty": 12, "hsn_code": "34011110", "status": "0",
    },
    {
        "sku_code": "SKU012", "plu_code": "100502",
        "sku_description": "DOVE SOAP 100G", "sku_short_description": "DOVE 100G",
        "gst_percent": 18.00, "ean_code": "8901234567901",
        "basic_price": 40.00, "cost_price": 42.00, "mrp": 55.00, "sale_price": 50.00,
        "priority": 1, "uom": "PCS", "uom_qty": 12, "hsn_code": "34011110", "status": "0",
    },
    {
        "sku_code": "SKU013", "plu_code": "100503",
        "sku_description": "HEAD AND SHOULDERS SHAMPOO 340ML", "sku_short_description": "H&S 340ML",
        "gst_percent": 18.00, "ean_code": "8901234567902",
        "basic_price": 220.00, "cost_price": 230.00, "mrp": 285.00, "sale_price": 265.00,
        "priority": 1, "uom": "PCS", "uom_qty": 6, "hsn_code": "33051010", "status": "0",
    },
    # ── Snacks (12% GST) ─────────────────────────────────────────────────────
    {
        "sku_code": "SKU014", "plu_code": "100601",
        "sku_description": "LAYS CHIPS CLASSIC SALTED 52G", "sku_short_description": "LAYS 52G",
        "gst_percent": 12.00, "ean_code": "8901234567903",
        "basic_price": 18.00, "cost_price": 20.00, "mrp": 30.00, "sale_price": 28.00,
        "priority": 1, "uom": "PCS", "uom_qty": 50, "hsn_code": "19041090", "status": "0",
    },
    {
        "sku_code": "SKU015", "plu_code": "100602",
        "sku_description": "KURKURE MASALA MUNCH 90G", "sku_short_description": "KURKURE 90G",
        "gst_percent": 12.00, "ean_code": "8901234567904",
        "basic_price": 18.00, "cost_price": 20.00, "mrp": 30.00, "sale_price": 28.00,
        "priority": 1, "uom": "PCS", "uom_qty": 50, "hsn_code": "19041090", "status": "0",
    },
    # ── Household (18% GST) ──────────────────────────────────────────────────
    {
        "sku_code": "SKU016", "plu_code": "100701",
        "sku_description": "SURF EXCEL DETERGENT 1KG", "sku_short_description": "SURF 1KG",
        "gst_percent": 18.00, "ean_code": "8901234567905",
        "basic_price": 115.00, "cost_price": 120.00, "mrp": 145.00, "sale_price": 135.00,
        "priority": 1, "uom": "PKT", "uom_qty": 12, "hsn_code": "34029019", "status": "0",
    },
    {
        "sku_code": "SKU017", "plu_code": "100702",
        "sku_description": "HARPIC TOILET CLEANER 500ML", "sku_short_description": "HARPIC 500ML",
        "gst_percent": 18.00, "ean_code": "8901234567906",
        "basic_price": 68.00, "cost_price": 72.00, "mrp": 90.00, "sale_price": 82.00,
        "priority": 1, "uom": "PCS", "uom_qty": 12, "hsn_code": "38089400", "status": "0",
    },
    # ── Biscuits (18% GST) ───────────────────────────────────────────────────
    {
        "sku_code": "SKU018", "plu_code": "100801",
        "sku_description": "PARLE G BISCUIT 800G", "sku_short_description": "PARLE G 800G",
        "gst_percent": 18.00, "ean_code": "8901234567907",
        "basic_price": 58.00, "cost_price": 62.00, "mrp": 75.00, "sale_price": 70.00,
        "priority": 1, "uom": "PKT", "uom_qty": 12, "hsn_code": "19053100", "status": "0",
    },
    {
        "sku_code": "SKU019", "plu_code": "100802",
        "sku_description": "BRITANNIA GOOD DAY CASHEW 200G", "sku_short_description": "GOOD DAY 200G",
        "gst_percent": 18.00, "ean_code": "8901234567908",
        "basic_price": 28.00, "cost_price": 30.00, "mrp": 40.00, "sale_price": 37.00,
        "priority": 1, "uom": "PCS", "uom_qty": 24, "hsn_code": "19053100", "status": "0",
    },
    # ── Confectionery (18% GST) ──────────────────────────────────────────────
    {
        "sku_code": "SKU020", "plu_code": "100901",
        "sku_description": "CADBURY DAIRY MILK 36G", "sku_short_description": "CDM 36G",
        "gst_percent": 18.00, "ean_code": "8901234567909",
        "basic_price": 18.00, "cost_price": 20.00, "mrp": 30.00, "sale_price": 28.00,
        "priority": 1, "uom": "PCS", "uom_qty": 24, "hsn_code": "18063190", "status": "0",
    },
]

CHUNK = 500


def seed(company_id: str, clear: bool) -> None:
    db = get_supabase()

    if clear:
        db.table("product_catalog").delete().eq("company_id", company_id).execute()
        print(f"  Cleared existing product_catalog rows for company {company_id}.")

    records = [{**p, "company_id": company_id} for p in DEMO_PRODUCTS]

    inserted = 0
    for i in range(0, len(records), CHUNK):
        chunk = records[i : i + CHUNK]
        db.table("product_catalog").upsert(chunk, on_conflict="company_id,plu_code").execute()
        inserted += len(chunk)

    print(f"  Upserted {inserted} demo product(s) into product_catalog.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed demo product_catalog data.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--company-name", help="Look up company by name")
    group.add_argument("--company-id",   help="Use company UUID directly")
    parser.add_argument("--clear", action="store_true", help="Delete existing rows before inserting")
    args = parser.parse_args()

    db = get_supabase()

    if args.company_id:
        company_id = args.company_id
    else:
        res = db.table("companies").select("id").eq("name", args.company_name).execute()
        if not res.data:
            print(f"ERROR: Company '{args.company_name}' not found.")
            sys.exit(1)
        company_id = res.data[0]["id"]
        print(f"  Found company: '{args.company_name}' → {company_id}")

    print(f"\nSeeding {len(DEMO_PRODUCTS)} demo products...")
    seed(company_id, clear=args.clear)
    print("Done.\n")


if __name__ == "__main__":
    main()
