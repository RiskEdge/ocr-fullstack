import mimetypes
import os
import json
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

# Gemini 3 Flash pricing (USD per 1M tokens)
_INPUT_PRICE_PER_M = 0.50
_OUTPUT_PRICE_PER_M = 3.00

from google import genai
from PIL import Image
import io

from app.db import get_supabase


class OCRProcessor:
    def __init__(self, api_key: str):
        self.client = genai.Client()

    @staticmethod
    def calculate_cost(input_tokens: int, output_tokens: int, total_pages: int = 1) -> dict:
        """Returns token counts, cost breakdown, and per-page metrics."""
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
        
    async def process_image(self, file_bytes: bytes, filename: str) -> dict:
        """Performs OCR on a single image."""
        try:
            img = Image.open(io.BytesIO(file_bytes))
            
            prompt = """
            Perform OCR on this invoice image. Extract all data into a structured JSON format.
            Return ONLY the raw JSON without any markdown formatting or code blocks.
            """
            
            response = await self.client.aio.models.generate_content(
                model='gemini-3-flash-preview',
                contents=[
                    prompt,
                    img
                ]
            )
            
            return {
                "filename": filename,
                "content": response.text
            }
        except Exception as e:
            return {
                "filename": filename,
                "error": str(e)
            }
            
    async def process_single_file(self, file_bytes: bytes, filename: str, mime_type: str) -> dict:
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
            
            # print(self.client.files.get(name=uploaded_file.name))
            
            prompt = """
            Extract all data from this document. If it spans multiple pages, 
            consolidate all line items, totals, and relevant metadata into a single flat JSON object.
            Ensure dynamic keys are descriptive strings (e.g., 'vendor_name', 'invoice_date').
            Return ONLY the raw JSON without any markdown formatting or code blocks.
            You MUST return the data in a strict JSON format with the following structure:
            {
              "total_pages": <number of pages in the document>,
              "pages": [
                {
                  "page_number": <the specific page number starting at 1>,
                  "extracted_data": { 
                      {
                          <dynamic keys and values found ONLY on this specific page>,
                          "confidence_score": <a number between 0 and 1 representing the confidence in the data>,
                      }
                  }
                }
              ]
            }
            Do not consolidate items across pages. Keep the extracted_data specific to its page_number.
            """
            
            response = await self.client.aio.models.generate_content(
                model='gemini-3-flash-preview',
                contents=[
                    prompt,
                    uploaded_file
                ]
            )
            
            content = json.loads(response.text)
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
                    await asyncio.to_thread(self.client.file.delete, uploaded_file.name)
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

        async def process_and_enqueue(content: bytes, filename: str, mime_type: str) -> None:
            try:
                async with semaphore:
                    for attempt in range(_MAX_RETRIES + 1):
                        result = await self.process_single_file(content, filename, mime_type)
                        if result["status"] == "success":
                            break
                        msg = result.get("message", "").lower()
                        is_rate_limit = any(sig in msg for sig in _RATE_LIMIT_SIGNALS)
                        if is_rate_limit and attempt < _MAX_RETRIES:
                            wait = 2 ** attempt
                            print(f"Rate limit hit for {filename}, retrying in {wait}s (attempt {attempt + 1})")
                            await asyncio.sleep(wait)
                            continue
                        break
                    if any(sig in result.get("message", "").lower() for sig in _RATE_LIMIT_SIGNALS):
                        result = {**result, "message": "Processing failed. Please try again later."}
            except Exception as e:
                result = {"filename": filename, "status": "error", "message": str(e)}
            await queue.put(result)

        # Send a ping immediately to establish chunked transfer encoding.
        yield json.dumps({"type": "ping"}) + "\n"

        file_types: dict[str, int] = {}
        tasks = []
        for content, filename, content_type in files:
            file_types[content_type] = file_types.get(content_type, 0) + 1
            tasks.append(asyncio.create_task(
                process_and_enqueue(content, filename, content_type)
            ))

        # Run-level accumulators
        started_at = datetime.now(timezone.utc)
        run_successful = 0
        run_failed = 0
        run_input_tokens = 0
        run_output_tokens = 0
        run_total_pages = 0
        run_total_fields = 0

        # Yield each result as soon as it arrives in the queue
        for _ in range(total_files):
            result = await queue.get()
            if result.get("status") == "success":
                run_successful += 1
                tu = result.get("token_usage", {})
                run_input_tokens += tu.get("input_tokens", 0)
                run_output_tokens += tu.get("output_tokens", 0)
                run_total_pages += tu.get("total_pages", 0)
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

        # 1 credit per page processed (only successful files contribute pages)
        credits_used = run_total_pages

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
        # print(f"[run_log] inserting: {log_row}")
        try:
            def _insert():
                return get_supabase().table("processing_runs").insert(log_row).execute()
            result = await asyncio.to_thread(_insert)
            print(f"[run_log] inserted ok: {result}")
        except Exception as e:
            import traceback
            print(f"[run_log] FAILED: {e}")
            traceback.print_exc()

        # Deduct 1 credit per page from the company balance
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
                    print(f"[credits] update result: {update_result}")
                    return new_credits

                remaining_credits = await asyncio.to_thread(_deduct_credits)
                print(f"[credits] deducted {credits_used} (pages), remaining: {remaining_credits}")
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
            
    async def process_multiple_images(self, files: List[tuple]):
        """ 
        Processes multiple images in parallel.
        Yeilds results one by one as they finish.
        """
        
        tasks = [self.process_image(f_bytes, f_name) for f_bytes, f_name in files]
        
        for task in asyncio.as_completed(tasks):
            result = await task
            
            yield json.dumps(result) + "\n"
