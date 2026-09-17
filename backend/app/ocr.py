import mimetypes
import os
import json
import re
import asyncio
import tempfile
from datetime import datetime, timezone
from typing import AsyncGenerator, List

# Max simultaneous Gemini API calls. Tune via OCR_CONCURRENCY env var.
_CONCURRENCY = int(os.environ.get("OCR_CONCURRENCY", "5"))
_MAX_RETRIES = 3
_ENVIRONMENT = os.environ.get("ENVIRONMENT", "production")
# Keywords that identify a Gemini rate-limit / quota error
_RATE_LIMIT_SIGNALS = ("quota", "rate limit", "429", "resource exhausted", "too many requests")
# Prefix on the errors a second attempt can plausibly fix: a reply that came
# back truncated, unparseable or stuck repeating a row. Sampling alone decides
# those, so the same file usually succeeds on the next call.
_INCOMPLETE = "Incomplete extraction:"
_RETRY_SIGNALS = _RATE_LIMIT_SIGNALS + (_INCOMPLETE.lower(),)

# Gemini 3 Flash pricing (USD per 1M tokens)
_INPUT_PRICE_PER_M = 0.50
_OUTPUT_PRICE_PER_M = 3.00

from google import genai
from google.genai import types

from app.db import get_supabase
from app.documents import record_processed_documents
from app.schemas import Document, coerce_document, document_to_content, schema_outline


# Headroom for a dense multi-page invoice — truncation loses the whole
# document, not a field — and a ceiling on a reply that runs away.
# Tune via OCR_MAX_OUTPUT_TOKENS.
_MAX_OUTPUT_TOKENS = int(os.environ.get("OCR_MAX_OUTPUT_TOKENS", "50768"))


_EXTRACTION_PROMPT = """You are extracting data from and performing OCR on a scanned or photographed business document, usually a GST tax invoice.
Extract all the data correctly from this document.
Read every printed value. Route each one to the field that matches its meaning, and leave a field out when the document does not print it.

PAGES
- One entry in `pages` per physical page, `page_number` starting at 1.
- Emit each physical page exactly once. Never repeat a page or re-list its line items under a second entry.
- Never merge line items or totals across pages. A figure printed on page 3 belongs to page 3.

PARTIES
- `supplier`: the party issuing the invoice — the letterhead, or the name above "Authorised Signatory".
- `buyer`: "Buyer", "Bill to", "Billed to".
- `consignee`: "Consignee", "Ship to". Fill it even when it repeats the buyer exactly.

LINE ITEMS
Item tables differ from vendor to vendor, so map every column by meaning, not by position:
- "S.No", "Sl No.", "Sr." -> serial_no
- "Description of Goods", "Item Description", "Product Description", "Particulars" -> sku_description
- "HSN", "HSN/SAC", "HSN Code" -> hsn_code
- "EAN", "Barcode" -> ean_code; "Item Code", "Product Code", "Article Code" -> sku_code
- "Qty", "Quantity", "PCS", "Nos" -> quantity; "Free" -> free_quantity
- "UOM", "Unit", "per" -> uom; "Pack Size", "Conversion Factor" -> uom_qty
- "MRP" -> mrp, never invoice_price
- "Rate", "Basic Rate", "B.Rate", "Basic Cost", "PC Price", "Rate Excl" -> invoice_price
- "Rate Inc", "Rate Incl", "Rate Inc GST" -> invoice_price_incl, never invoice_price
- "Cost Price" -> cost_price
- "Gross Amount" -> gross_amount
- "Disc %", "Disc. %", "C.D %", "Discount %" -> discount_pct
- "Disc Amount", "Discount Amount" -> discount_amount
- "Scheme", "Schemes", "Scheme Amount" -> scheme_amount
- "Taxable Amount", "Taxable Value", "Assessable Value" -> taxable_value
- "GST %", "GST Rate", "Tax %" -> gst_percent; "CGST %", "SGST %", "IGST %" -> cgst_percent, sgst_percent, igst_percent
- A "CGST" / "SGST" / "IGST" column holding money -> cgst_amount / sgst_amount / igst_amount; holding a rate -> the matching *_percent
- "Amount", "Net Amount", "Net Value" -> net_amount

Line item rules:
- A quantity cell that prints its unit ("6 Pcs", "12 NOS") gives quantity 6 and uom "Pcs".
- A column headed only "Amount" is net_amount, even where the invoice adds tax further down and that figure is therefore pre-tax. taxable_value is only for a column that names itself: "Taxable Amount", "Taxable Value", "Assessable Value".
- A column you cannot map confidently goes in that row's `additional_fields`, with the printed header as `key`. Never force it into a field above.

TAX SUMMARY
- The HSN-wise or rate-wise tax summary table goes in `tax_summary`, never in `line_items`.
- Exclude its "Total" row: it would double every sum. Those figures belong in `invoice_summary`.
- Grouped headers — a "CGST" header spanning "Rate" and "Amount" — map to cgst_percent and cgst_amount.

TOTALS
- `grand_total` is the final amount payable, and it is the first field to fill from the totals block. A row labelled only "Total", or a single closing figure with no label at all, is the grand total. Never put it in `charges`.
- `charges` is for the component figures *between* the subtotal and the grand total — tax, freight, discount, round-off, and anything else the totals block lists. Keep each label exactly as printed, including labels printed inside the item table's own columns, such as "SGST", "CGST" or "Round Off" appearing under the description column.
- Every charge whose label is recognisable must ALSO fill its named field: SGST -> sgst_total, CGST -> cgst_total, IGST -> igst_total, Total Tax -> total_tax, Freight -> freight_charges, TCS -> tcs, Round Off -> round_off, Discount -> discount, Subtotal or Taxable Value -> taxable_value. This is not optional: `charges` records how a figure was printed, it does not stand in for the named field.
- `round_off` is signed the way it moves the total: -0.30 when it reduces the payable amount.
- A "Total" row carrying both a quantity and an amount ("Total  99 Pcs  16,753.00") gives total_quantity 99, total_quantity_uom "Pcs" and grand_total 16753.
- Report every figure as printed. Do not compute, correct or balance them.

STAMPS AND HANDWRITING
- Rubber stamps, inward or security seals, handwritten notes, ticks and margin scribbles go in `annotations` only.
- They are never invoice data. A date inside a stamp is not `invoice_date`; a handwritten number is not `invoice_number`.

NUMBERS AND DATES
- Numbers are plain: strip currency symbols, thousands separators and a trailing "/-". "1,262.42" becomes 1262.42
- Dates exactly as printed ("22-Aug-26"). Do not reformat them.

OMISSIONS
- `confidence_score` is 0 to 1 for the page as a whole. Lower it when the scan is skewed, blurred or partly obscured.

OUTPUT
- Return ONLY raw JSON, with no markdown fences and no commentary, in exactly this shape:
""" + schema_outline() + """
- Omit any key the document does not print. Never emit null, "" or an empty list.
- Use only the keys above. Anything else printed goes in the nearest `additional_fields` as {"key": "<label as printed>", "value": "<value as printed>"}.
- Write each line item exactly once, in the order printed. Never repeat a row you have already written, and stop the array when the printed rows run out.
"""


_FENCE_OPEN_RE = re.compile(r"^```[a-zA-Z]*\n?")
_FENCE_CLOSE_RE = re.compile(r"\n?```\s*$")


def _json_payload(text: str) -> str:
    """The JSON object inside a reply that may carry fences or a stray sentence."""
    text = _FENCE_CLOSE_RE.sub("", _FENCE_OPEN_RE.sub("", text.strip())).strip()
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if start != -1 and end > start else text


def _repeated_line_items(document: Document) -> str | None:
    """Names the decoder looping on one row, or None when the table looks real.

    A stuck run comes back as byte-identical rows, and the stuck row is always
    a partial one — it is the copy the model could not move past. Invoices do
    legitimately repeat a row (the same SKU in two batches), so a handful of
    matching rows is not enough: the run has to be at least three long and a
    quarter of the page before it counts.
    """
    for page in document.pages:
        rows = page.line_items
        if len(rows) < 3:
            continue
        counts: dict[str, int] = {}
        for row in rows:
            key = row.model_dump_json()
            counts[key] = counts.get(key, 0) + 1
        worst = max(counts.values())
        if worst >= 3 and worst * 4 >= len(rows):
            return (
                f"page {page.page_number} repeats one line item {worst} times "
                f"across {len(rows)} rows"
            )
    return None


class OCRProcessor:
    def __init__(self, api_key: str):
        self.client = genai.Client()

    @staticmethod
    def calculate_cost(input_tokens: int, output_tokens: int, total_pages: int = 1) -> dict:
        """Returns token counts and USD cost breakdown.

        Per-page figures here are API-cost metrics only — customer billing is a
        flat 1 credit per document and never uses these.
        """
        input_cost = (input_tokens / 1_000_000) * _INPUT_PRICE_PER_M
        output_cost = (output_tokens / 1_000_000) * _OUTPUT_PRICE_PER_M
        total_cost = input_cost + output_cost
        per_page_cost = total_cost / total_pages if total_pages > 0 else total_cost
        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "total_pages": total_pages,
            "input_cost_usd": round(input_cost, 6),
            "output_cost_usd": round(output_cost, 6),
            "total_cost_usd": round(total_cost, 6),
            "cost_per_page_usd": round(per_page_cost, 6),
        }

    @staticmethod
    def _parse_document(response) -> Document:
        """Validated `Document` out of Gemini's JSON reply.

        Gemini is asked for JSON but deliberately *not* pinned to a
        `response_schema`. A schema as wide as `Document` — thirty optional
        columns per line item, each with its own key/value escape hatch — sent
        the constrained decoder into a repetition loop on a dense item table:
        it would re-emit line item 1 until it either ran to MAX_TOKENS or gave
        up and closed the array, so a 20-row invoice arrived holding one row.
        Unconstrained, the same prompt and model read the table straight
        through. The shape travels in the prompt instead (`schema_outline()`)
        and `coerce_document()` puts the reply back on the models here, so
        everything downstream still receives a validated `Document`.
        """
        candidates = getattr(response, "candidates", None) or []
        finish_reason = getattr(candidates[0], "finish_reason", None) if candidates else None
        if finish_reason is not None and str(finish_reason).endswith("MAX_TOKENS"):
            raise ValueError(
                f"{_INCOMPLETE} Gemini hit the output token limit before closing the JSON. "
                "Raise OCR_MAX_OUTPUT_TOKENS or split the file."
            )

        text = (getattr(response, "text", None) or "").strip()
        if not text:
            raise ValueError(f"{_INCOMPLETE} Gemini returned no content (finish_reason={finish_reason})")

        try:
            raw = json.loads(_json_payload(text))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{_INCOMPLETE} Gemini returned unparseable JSON ({exc})") from exc

        document = coerce_document(raw)
        looping = _repeated_line_items(document)
        if looping:
            raise ValueError(f"{_INCOMPLETE} {looping}")
        return document

    async def process_single_file(
        self,
        file_bytes: bytes,
        filename: str,
        mime_type: str,
    ) -> dict:
        """Uploads a file via File API, waits for it to process and extracts data."""
        
        temp_file_path = None
        uploaded_file = None
        
        try:
            # Save file to a local temp file (File API requires a file path)
            ext = mimetypes.guess_extension(mime_type) or ".bin"
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_file:
                temp_file.write(file_bytes)
                temp_file_path = temp_file.name
                
            # Upload to gemini
            uploaded_file = await asyncio.to_thread(
                self.client.files.upload,
                file=temp_file_path
            )

            response = await self.client.aio.models.generate_content(
                model='gemini-3-flash-preview',
                contents=[
                    _EXTRACTION_PROMPT,
                    uploaded_file
                ],
                config=types.GenerateContentConfig(
                    # No `response_schema`: see `_parse_document` for why
                    # constraining the decoder breaks dense item tables.
                    response_mime_type="application/json",
                    max_output_tokens=_MAX_OUTPUT_TOKENS,
                ),
            )

            content = document_to_content(self._parse_document(response))
            total_pages = content.get("total_pages", 1)

            usage = response.usage_metadata
            token_usage = self.calculate_cost(
                input_tokens=usage.prompt_token_count,
                output_tokens=usage.candidates_token_count,
                total_pages=total_pages,
            )

            return {
                "filename": filename,
                "status": "success",
                "content": content,
                "token_usage": token_usage,
            }

        except Exception as e:
            return {
                "filename": filename,
                "status": "error",
                "message": str(e)
            }
        finally:
            if uploaded_file:
                try:
                    await asyncio.to_thread(self.client.files.delete, name=uploaded_file.name)
                except Exception:
                    pass
            if temp_file_path and os.path.exists(temp_file_path):
                os.remove(temp_file_path)
    
    async def stream_documents(
        self,
        files: List[tuple],  # list of (bytes, filename, content_type)
        user_id: str,
        company_id: str,
    ) -> AsyncGenerator[str, None]:
        """Processes documents with bounded concurrency, retrying on rate-limit errors."""
        semaphore = asyncio.Semaphore(_CONCURRENCY)
        queue: asyncio.Queue = asyncio.Queue()
        total_files = len(files)

        async def process_and_enqueue(index: int, content: bytes, filename: str, mime_type: str) -> None:
            try:
                async with semaphore:
                    for attempt in range(_MAX_RETRIES + 1):
                        result = await self.process_single_file(
                            content, filename, mime_type
                        )
                        if result["status"] == "success":
                            break
                        msg = result.get("message", "").lower()
                        if not any(sig in msg for sig in _RETRY_SIGNALS) or attempt >= _MAX_RETRIES:
                            break
                        if any(sig in msg for sig in _RATE_LIMIT_SIGNALS):
                            wait = 2 ** attempt
                            print(f"Rate limit hit for {filename}, retrying in {wait}s (attempt {attempt + 1})")
                            await asyncio.sleep(wait)
                        else:
                            # A truncated or looping reply is a sampling accident,
                            # so retry straight away rather than backing off.
                            print(f"Retrying {filename}: {result.get('message')} (attempt {attempt + 1})")
                    if any(sig in result.get("message", "").lower() for sig in _RATE_LIMIT_SIGNALS):
                        result = {**result, "message": "Processing failed. Please try again later."}
            except Exception as e:
                result = {"filename": filename, "status": "error", "message": str(e)}
            # The index travels alongside the result so the consumer can map it
            # back to the source bytes for duplicate-detection bookkeeping.
            await queue.put((index, result))

        # Send a ping immediately to establish chunked transfer encoding.
        yield json.dumps({"type": "ping"}) + "\n"

        file_types: dict[str, int] = {}
        tasks = []
        for index, (content, filename, content_type) in enumerate(files):
            file_types[content_type] = file_types.get(content_type, 0) + 1
            tasks.append(asyncio.create_task(
                process_and_enqueue(index, content, filename, content_type)
            ))

        # Run-level accumulators
        started_at = datetime.now(timezone.utc)
        run_successful = 0
        run_failed = 0
        run_input_tokens = 0
        run_output_tokens = 0
        run_total_pages = 0
        run_total_fields = 0
        # Successfully processed files, recorded afterwards for duplicate detection
        processed_docs: list[dict] = []

        # Yield each result as soon as it arrives in the queue
        for _ in range(total_files):
            index, result = await queue.get()
            print(result)
            if result.get("status") == "success":
                run_successful += 1
                tu = result.get("token_usage", {})
                run_input_tokens += tu.get("input_tokens", 0)
                run_output_tokens += tu.get("output_tokens", 0)
                run_total_pages += tu.get("total_pages", 0)
                src_bytes, src_filename, src_mime = files[index]
                processed_docs.append({
                    "file_bytes": src_bytes,
                    "filename": src_filename,
                    "mime_type": src_mime,
                    "page_count": tu.get("total_pages"),
                })
                # Count extracted fields (top-level keys minus confidence_score)
                for page in result.get("content", {}).get("pages", []):
                    run_total_fields += max(0, len(page.get("extracted_data", {})) - 1)
            else:
                run_failed += 1
            yield json.dumps(result) + "\n"

        await asyncio.gather(*tasks, return_exceptions=True)

        completed_at = datetime.now(timezone.utc)
        run_cost = self.calculate_cost(run_input_tokens, run_output_tokens, run_total_pages)

        if run_failed == 0:
            run_status = "completed"
        elif run_successful == 0:
            run_status = "failed"
        else:
            run_status = "partial"

        # 1 credit per successfully processed invoice
        credits_used = run_successful

        # Insert run log
        log_row = {
            "user_id": user_id,
            "company_id": company_id,
            "total_files": len(tasks),
            "successful_files": run_successful,
            "failed_files": run_failed,
            "total_pages": run_total_pages,
            "total_fields_extracted": run_total_fields,
            "file_types": file_types,
            "input_tokens": run_input_tokens,
            "output_tokens": run_output_tokens,
            "total_cost_usd": run_cost["total_cost_usd"],
            "total_duration_ms": int((completed_at - started_at).total_seconds() * 1000),
            "status": run_status,
            "started_at": started_at.isoformat(),
            "completed_at": completed_at.isoformat(),
            "environment": _ENVIRONMENT,
            "credits_used": credits_used,
        }
        run_id = None
        try:
            def _insert():
                return get_supabase().table("processing_runs").insert(log_row).execute()
            run_insert = await asyncio.to_thread(_insert)
            inserted_rows = getattr(run_insert, "data", None) or []
            if inserted_rows:
                run_id = inserted_rows[0].get("id")
            # print(f"[run_log] inserted ok: {run_insert}")
        except Exception as e:
            import traceback
            print(f"[run_log] FAILED: {e}")
            traceback.print_exc()

        # Fingerprint every successful file so a later upload of the same bytes
        # can be flagged before the user spends credits on it again. Failures
        # here are swallowed — bookkeeping must not break the stream.
        await record_processed_documents(
            company_id=company_id,
            user_id=user_id,
            run_id=run_id,
            documents=processed_docs,
        )

        # Deduct 1 credit per successful document from the company balance
        remaining_credits = None
        if credits_used > 0:
            try:
                cid = company_id
                to_deduct = credits_used

                def _deduct_credits():
                    db = get_supabase()
                    row = db.table("companies").select("credits").eq("id", cid).single().execute()
                    current_credits = row.data["credits"]
                    new_credits = max(0, current_credits - to_deduct)
                    update_result = db.table("companies").update({"credits": new_credits}).eq("id", cid).execute()
                    # print(f"[credits] update result: {update_result}")
                    return new_credits

                remaining_credits = await asyncio.to_thread(_deduct_credits)
                print(f"[credits] deducted {credits_used} (1/document), remaining: {remaining_credits}")
            except Exception as e:
                import traceback
                print(f"[credits] FAILED to deduct credits: {e}")
                traceback.print_exc()

        run_summary = {**run_cost, "documents_processed": total_files}
        yield json.dumps({
            "type": "run_summary",
            "token_usage": run_summary,
            "credits_used": credits_used,
            "remaining_credits": remaining_credits,
        }) + "\n"
            
