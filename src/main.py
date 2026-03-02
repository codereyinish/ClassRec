from fastapi import FastAPI,  File, UploadFile, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
import os
from dotenv import load_dotenv
import io
import asyncio
import array
import wave
from typing import Tuple
from validators import validate_audio_file
from pathlib import Path
import json


#=======SETUP========
load_dotenv()

api_key = os.environ.get("OPENAI_API_KEY")
client = OpenAI()
app = FastAPI()

BASE_DIR = Path(__file__).parent.parent  # goes up from src/ to ClassRec/
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


#=======CONSTANTS=========
SAMPLE_RATE = 16000  # 16kHz
BYTES_PER_SAMPLE = 2  # Int16
BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE  # 32,000
CHUNK_DURATION = 5


#=========AUDIO HELPERS =========
def convert_pcm_to_wav(pcm_data: bytes) -> io.BytesIO:
    """Convert raw PCM bytes to WAV format"""
    audio_file = io.BytesIO()
    with wave.open(audio_file, "wb") as wav_file:
        wav_file.setnchannels(1)# Mono
        wav_file.setsampwidth(2)# 2 bytes = 16-bit
        wav_file.setframerate(16000) # 16kHz
        wav_file.writeframes(pcm_data)
        audio_file.seek(0)
        audio_file.name = "audio.wav"
        return audio_file


def is_buffer_full(audio_buffer: bytearray) -> bool:
    """Check if audio buffer has reached chunk duration"""
    return len(audio_buffer) >= BYTES_PER_SECOND * CHUNK_DURATION



# ========TRANSCRIPTION=========
def call_whisper(audio_file: io.BytesIO,prompt: str="") -> str:
    """Send audio to Whisper API and return transcript text"""
    transcript = client.audio.transcriptions.create(
        model = "whisper-1",
        file = audio_file,
        language = "en",
        prompt = prompt
    )
    return transcript.text


async def transcribe_chunk(chunk_data:bytes, websocket: WebSocket, lecture_prompt:str):
    """Convert audio chunk to WAV, transcribe, and send result to browser via websocket"""
    try:
        audio_file_wav = convert_pcm_to_wav(chunk_data)
        transcripted_text = call_whisper(audio_file_wav, lecture_prompt)
        if transcripted_text.strip(): # don't send empty transcriptions
            await websocket.send_json({
                "type": "transcription",
                "text": transcripted_text
            })

    except Exception as e:
        await websocket.send_json({
        "type": "error",
        "message": str(e)
        })




# ========== ROUTES ==========
@app.get("/", response_class = HTMLResponse)
async def home(request: Request):
    """Homepage - Choose transcription method"""
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/upload", response_class = HTMLResponse)
async def upload_page(request: Request):
    """File Upload transcription page"""
    return templates.TemplateResponse("upload.html", {"request":request})


@app.get("/live", response_class= HTMLResponse)
async def live_page(request:Request):
    """Live Recording Transcription Page"""
    return templates.TemplateResponse("live.html", {"request": request})

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse("static/favicon.ico")


@app.get("/health")
def health():
    """Health check endpoint"""
    return {"status": "healthy", "service": "transcription"}


#========FILE UPLOAD TRANSCRIPTION===========
@app.post("/transcribe")
async def transcribe_audio(
        file: UploadFile,
        validated_data: Tuple[bytes, str, float, str] = Depends(validate_audio_file)
):
    contents, mime, file_size_mb, correct_ext = validated_data
    try:
        audio_file = io.BytesIO(contents) #make file like object for bytes
        audio_file.name = f"audio.{correct_ext}" #use generic audio name + proper extension

        transcripted_text = call_whisper(audio_file)
        return{
            "filename": file.filename,
            "transcription": transcripted_text,
            "file_size_mb": round(file_size_mb, 2)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription Failed: {str(e)}")


#========LIVE TRANSCRIPTION========
@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    """ Collect the audio into audio_buffer via websocket, transcribe it after fillup"""
    await websocket.accept()
    audio_buffer = bytearray()
    lecture_prompt = "University lecture."

    try:
        while True:
            # Receive audio chunk from browser
            data  = await websocket.receive()

            if "text" in data:
                msg = json.loads(data["text"])
                if msg.get("type") == "context":
                    topic = msg.get("prompt", "")
                    lecture_prompt = topic if topic else ""

            elif "bytes" in data:
                audio_buffer.extend(data["bytes"])
                if is_buffer_full(audio_buffer):
                    chunk_to_process = bytes(audio_buffer)

                    # Clear buffer IMMEDIATELY for next chunk
                    audio_buffer.clear()

                    asyncio.create_task(transcribe_chunk(chunk_to_process, websocket, lecture_prompt))
                    # keep receiving audio from browser with asyncio

    except WebSocketDisconnect:
        print("Client Disconnected from Websocket")
    except Exception as e:
        print(f"Websocket error : {e}")















