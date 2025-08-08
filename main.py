import os

# Render-specific configuration
if "RENDER" in os.environ:
    TEMP_UPLOAD_DIR = "/opt/render/project/src/temp_uploads"
else:
    TEMP_UPLOAD_DIR = "temp_uploads"
    
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

import os
import uuid
import asyncio
import subprocess
import logging
import shutil
import time
import requests
from datetime import datetime
from urllib.parse import quote
from fastapi import FastAPI, UploadFile, HTTPException, Request, BackgroundTasks, Form, File
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Configuration
MAX_SIZE_GB = 2
MAX_DURATION = 1200  # 20 minutes
TEMP_UPLOAD_DIR = "temp_uploads"

# Create temp directory if not exists
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

# Pricing tiers (in cents)
PRICING_TIERS = {
    "gmail": {
        "base": 199,
        "tiers": {
            "under_3min": 199,
            "under_10min": 299,
            "under_20min": 449
        }
    },
    "outlook": {
        "base": 219,
        "tiers": {
            "under_3min": 219,
            "under_10min": 329,
            "under_20min": 499
        }
    },
    "other": {
        "base": 249,
        "tiers": {
            "under_3min": 249,
            "under_10min": 399,
            "under_20min": 549
        }
    }
}

UPSELLS = {
    "priority": 75,
    "transcript": 150
}

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/terms", response_class=HTMLResponse)
async def read_terms(request: Request):
    return templates.TemplateResponse("terms.html", {"request": request})

@app.post("/validate-video")
async def validate_video(file: UploadFile = File(...)):
    # Check file size
    max_size_bytes = MAX_SIZE_GB * 1024 * 1024 * 1024
    file_size = 0
    
    # Save temporarily to get size
    temp_path = os.path.join(TEMP_UPLOAD_DIR, f"temp_{uuid.uuid4()}")
    with open(temp_path, "wb") as f:
        while content := await file.read(1024 * 1024):  # 1MB chunks
            file_size += len(content)
            f.write(content)
            if file_size > max_size_bytes:
                os.remove(temp_path)
                raise HTTPException(400, "File exceeds 2GB limit")
    
    # Check duration (simulated for now)
    # In production, use: 
    # duration = get_video_duration(temp_path)
    duration = 0  # Replace with actual duration extraction
    
    if duration > MAX_DURATION:
        os.remove(temp_path)
        raise HTTPException(400, "Video exceeds 20 minute limit")
    
    # Cleanup
    os.remove(temp_path)
    
    return JSONResponse({
        "status": "valid",
        "file_name": file.filename,
        "file_size": file_size,
        "file_size_human": format_file_size(file_size),
        "duration": duration,
        "duration_human": format_duration(duration)
    })

@app.post("/create-payment-intent")
async def create_payment_intent(
    provider: str = Form(...),
    priority: bool = Form(False),
    transcript: bool = Form(False),
    duration: int = Form(...)
):
    # Validate provider
    if provider not in PRICING_TIERS:
        raise HTTPException(400, "Invalid provider")
    
    # Determine pricing tier based on duration
    if duration <= 180:  # 3 minutes
        tier = "under_3min"
    elif duration <= 600:  # 10 minutes
        tier = "under_10min"
    else:
        tier = "under_20min"
    
    # Calculate base price
    base_price = PRICING_TIERS[provider]["tiers"][tier]
    
    # Add upsells
    upsell_total = 0
    if priority:
        upsell_total += UPSELLS["priority"]
    if transcript:
        upsell_total += UPSELLS["transcript"]
    
    # Calculate total (in cents)
    total_amount = base_price + upsell_total
    
    # In production, this would create a Stripe PaymentIntent
    # For now, we'll simulate it
    return JSONResponse({
        "client_secret": f"pi_simulated_{uuid.uuid4()}",
        "amount": total_amount,
        "currency": "usd",
        "description": f"Video compression for {provider.capitalize()}"
    })

def format_file_size(bytes):
    if bytes < 1024:
        return f"{bytes} bytes"
    elif bytes < 1024 * 1024:
        return f"{bytes/1024:.1f} KB"
    elif bytes < 1024 * 1024 * 1024:
        return f"{bytes/(1024*1024):.1f} MB"
    else:
        return f"{bytes/(1024*1024*1024):.1f} GB"

def format_duration(seconds):
    mins = seconds // 60
    secs = seconds % 60
    return f"{mins}:{secs:02d} min"

# Background task for video processing
async def process_video_background(file_path: str, output_path: str):
    # Simulate processing time
    await asyncio.sleep(10)
    
    # In production, use FFmpeg:
    # command = f"ffmpeg -i {file_path} -vcodec libx264 -crf 28 {output_path}"
    # subprocess.run(command, shell=True, check=True)
    
    # For now, just copy the file
    shutil.copy(file_path, output_path)
    
    # Cleanup
    os.remove(file_path)

@app.post("/process-video")
async def process_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    payment_intent: str = Form(...)
):
    # Validate payment intent (simulated)
    if not payment_intent.startswith("pi_simulated_"):
        raise HTTPException(400, "Invalid payment intent")
    
    # Save file
    file_id = str(uuid.uuid4())
    file_ext = os.path.splitext(file.filename)[1]
    file_path = os.path.join(TEMP_UPLOAD_DIR, f"{file_id}{file_ext}")
    
    with open(file_path, "wb") as f:
        while content := await file.read(1024 * 1024):  # 1MB chunks
            f.write(content)
    
    # Create output path
    output_path = os.path.join(TEMP_UPLOAD_DIR, f"compressed_{file_id}.mp4")
    
    # Add background task
    background_tasks.add_task(
        process_video_background, 
        file_path, 
        output_path
    )
    
    return JSONResponse({
        "status": "processing",
        "file_id": file_id,
        "download_url": f"/download/{file_id}"
    })

@app.get("/download/{file_id}")
async def download_file(file_id: str):
    file_path = os.path.join(TEMP_UPLOAD_DIR, f"compressed_{file_id}.mp4")
    
    if not os.path.exists(file_path):
        raise HTTPException(404, "File not found")
    
    return FileResponse(
        file_path,
        filename=f"compressed_video_{file_id}.mp4",
        media_type="video/mp4"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)