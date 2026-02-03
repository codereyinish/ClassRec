from fastapi import FastAPI,  File, UploadFile
from fastapi.responses import HTMLResponse

app = FastAPI()

@app.get("/")
def home():
    return HTMLResponse("<h1> Lecture Transcription System - Stage 1 </h1>")

@app.get("/health")
def health():
    return {"status": "working"}

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile= File(...)): #get the file from File()
    """
        This endpoint receives an audio file upload
    """
    return {
        "filename": file.filename,
        "content_type": file.content_type,
        "message": "File recieved successfully!"
    }
