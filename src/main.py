from fastapi import FastAPI,  File, UploadFile, HTTPException, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
import os
from dotenv import load_dotenv
import io
from typing import Tuple
from validators import validate_audio_file



#Load environment variables
load_dotenv()

#Initialize OpenAI Client
api_key = os.environ.get("OPENAI_API_KEY")
client = OpenAI()

#Initialize FastAPI
app = FastAPI()


# Setup templates and static files

# Create an instance pointing to the templates folder
templates = Jinja2Templates(directory="../templates")

app.mount("/static", StaticFiles(directory="../static"), name="static")


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


    #Save transcripts to the file






