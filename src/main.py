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
CHUNK_DURATION = 15


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

def call_whisper(audio_file: io.BytesIO) -> str:
    """Send audio to Whisper API and return transcript text"""
    transcript = client.audio.transcriptions.create(
        model = "whisper-1",
        file = audio_file,
        language = "en"
    )
    return transcript.text


def call_diarize(audio_file: io.BytesIO) -> list:
    """Send audio to diarization API and return list of segments with speaker labels"""
    transcript = client.audio.transcriptions.create(
        model="gpt-4o-transcribe-diarize",
        file=audio_file,
        response_format="diarized_json"
    )
    return transcript.segments if hasattr(transcript, 'segments') else []



#======LIVE TRANSCRIPTION's HELPER FUNCTION
async def transcribe_chunk(chunk_data:bytes, websocket: WebSocket):
    """Convert audio chunk to WAV, transcribe, and send result to browser via websocket"""
    try:
        audio_file_wav = convert_pcm_to_wav(chunk_data)
        segments = call_diarize(audio_file_wav)

        for segment in segments:
            if segment.text.strip():
                await websocket.send_json({
                    "type": "transcription",
                    "speaker": segment.speaker,
                    "text": segment.text
                })
                print("Step 6d: sent to browser ✅")

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

    try:
        while True:
            # Receive audio chunk from browser
            data  = await websocket.receive_bytes()
            print(f"Step 5: received {len(data)} bytes, buffer: {len(audio_buffer)}")
            audio_buffer.extend(data)

            if is_buffer_full(audio_buffer):
                chunk_to_process = bytes(audio_buffer)

                # Clear buffer IMMEDIATELY for next chunk
                audio_buffer.clear()

                asyncio.create_task(transcribe_chunk(chunk_to_process, websocket))
                # keep receiving audio from browser with asyncio

    except WebSocketDisconnect:
        print("Client Disconnected from Websocket")
    except Exception as e:
        print(f"Websocket error : {e}")
        try:
            await websocket.close()
        except:
            pass














