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


#Load environment variables
load_dotenv()

#Initialize OpenAI Client
api_key = os.environ.get("OPENAI_API_KEY")
client = OpenAI()

#Initialize FastAPI
app = FastAPI()


BASE_DIR = Path(__file__).parent.parent  # goes up from src/ to ClassRec/

#Setup templates and static files

# Create an instance pointing to the templates folder
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")




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


@app.post("/transcribe")
async def transcribe_audio(
        file: UploadFile,
        validated_data: Tuple[bytes, str, float, str] = Depends(validate_audio_file)
):
    contents, mime, file_size_mb, correct_ext = validated_data

    try:
        #Create BytesIO with filename
        audio_file = io.BytesIO(contents) #make file like object for bytes
        audio_file.name = f"audio.{correct_ext}" #use generic audio name + proper extension

        #Call OpenAI Whisper API
        transcript = client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            language="en"
        ) #returns a transcription object

        return{
            "filename": file.filename,
            "transcription": transcript.text,
            "file_size_mb": round(file_size_mb, 2)
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription Failed: {str(e)}")



@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    await websocket.accept()

    audio_buffer = bytearray()
    chunk_duration = 3

    SAMPLE_RATE = 16000  # 16kHz
    BYTES_PER_SAMPLE = 2  # Int16
    BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE  # 32,000

    async def transcribe_chunk(chunk_data:bytes):
        "Process transcription in the background "
        try:
            # Convert raw PCM to WAV format using built-in wave module
            audio_file = io.BytesIO()

            # Create WAV file
            with wave.open(audio_file, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 2 bytes = 16-bit
                wav_file.setframerate(16000)  # 16kHz
                wav_file.writeframes(chunk_data)

            # Reset to beginning
            audio_file.seek(0)
            audio_file.name = "audio.wav"

            #transcribe
            transcript = client.audio.transcriptions.create(
                file = audio_file,
                model = "whisper-1",
                language = "en"
            )

            #Send result back to browser
            await websocket.send_json({
                "type": "transcription",
                "text": transcript.text
            })

        except Exception as e:
            await websocket.send_json({
            "type": "error",
            "message": str(e)
            })



    try:
        while True:
            # Receive audio chunk from browser
            data  = await websocket.receive_bytes()
            audio_buffer.extend(data)

            #When buffer reach 10 sec Transcribe it
            if len(audio_buffer) > BYTES_PER_SECOND * chunk_duration:

                chunk_to_process = bytes(audio_buffer)

                # Clear buffer IMMEDIATELY for next chunk
                audio_buffer.clear()

                asyncio.create_task(transcribe_chunk(chunk_to_process))
                #keep receiving audio from browser with asyncio

    except WebSocketDisconnect:
        print("Client Disconnected from Websocket")
    except Exception as e:
        print(f"Websocket error : {e}")
        try:
            await websocket.close()
        except:
            pass














