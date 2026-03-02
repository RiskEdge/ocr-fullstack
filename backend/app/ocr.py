import mimetypes
import os
import json
import asyncio
import tempfile
from typing import AsyncGenerator, List, Any

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
        """Processes multiple documents in parallel and streams results."""
        tasks = []
        for file in files:
            content = await file.read()
            
            task = asyncio.create_task(
                self.process_single_file(content, file.filename, file.content_type)
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
