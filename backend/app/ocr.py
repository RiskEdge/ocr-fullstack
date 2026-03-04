import mimetypes
import os
import json
import asyncio
import tempfile
from typing import AsyncGenerator, List, Any

# Max simultaneous Gemini API calls. Tune via OCR_CONCURRENCY env var.
_CONCURRENCY = int(os.environ.get("OCR_CONCURRENCY", "5"))
_MAX_RETRIES = 3
# Keywords that identify a Gemini rate-limit / quota error
_RATE_LIMIT_SIGNALS = ("quota", "rate limit", "429", "resource exhausted", "too many requests")

from fastapi import UploadFile
from google import genai
from PIL import Image
import io


class OCRProcessor:
    def __init__(self, api_key: str):
        self.client = genai.Client()
        
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
            # response = await asyncio.to_thread(
            #     self.client.models.generate_content,
            #     [prompt, img]
            # )
            
            # print(response)
            
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
            
            # print(response)
            
            return {
                "filename": filename,
                "status": "success",
                "content": json.loads(response.text)
                # "text": response.text,
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
    
    async def stream_documents(self, files: List[UploadFile]) -> AsyncGenerator[str, None]:
        """Processes documents with bounded concurrency, retrying on rate-limit errors."""
        semaphore = asyncio.Semaphore(_CONCURRENCY)

        async def process_bounded(content: bytes, filename: str, mime_type: str) -> dict:
            async with semaphore:
                for attempt in range(_MAX_RETRIES + 1):
                    result = await self.process_single_file(content, filename, mime_type)
                    if result["status"] == "success":
                        return result
                    msg = result.get("message", "").lower()
                    is_rate_limit = any(sig in msg for sig in _RATE_LIMIT_SIGNALS)
                    if is_rate_limit and attempt < _MAX_RETRIES:
                        wait = 2 ** attempt   # 1 s, 2 s, 4 s
                        print(f"Rate limit hit for {filename}, retrying in {wait}s (attempt {attempt + 1})")
                        await asyncio.sleep(wait)
                        continue
                    break
                # Never expose quota/rate-limit details to the client
                if any(sig in result.get("message", "").lower() for sig in _RATE_LIMIT_SIGNALS):
                    result = {**result, "message": "Processing failed. Please try again later."}
                return result

        tasks = []
        for file in files:
            content = await file.read()
            task = asyncio.create_task(
                process_bounded(content, file.filename, file.content_type)
            )
            tasks.append(task)

        for completed_task in asyncio.as_completed(tasks):
            result = await completed_task
            yield json.dumps(result) + "\n"
            
    async def process_multiple_images(self, files: List[tuple]):
        """ 
        Processes multiple images in parallel.
        Yeilds results one by one as they finish.
        """
        
        tasks = [self.process_image(f_bytes, f_name) for f_bytes, f_name in files]
        
        for task in asyncio.as_completed(tasks):
            result = await task
            
            yield json.dumps(result) + "\n"
