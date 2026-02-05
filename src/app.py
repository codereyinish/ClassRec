from fastapi import FastAPI,  File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse
from openai import OpenAI
import os
from dotenv import load_dotenv
import io


#Load environment variables
load_dotenv()

api_key = os.environ.get("OPENAI_API_KEY")

app = FastAPI()
client = OpenAI()



@app.get("/", response_class = HTMLResponse)
def home():
    html = """
    <!DOCTYPE html>
    <html>
        <head>
            <title>Lecture Transcription </title>
            <style>
                body { 
                font-family: Arial; 
                max-width: 700px; 
                margin: 50px auto; 
                padding: 20px; 
            }
            h1 { color: #333; }
            .upload-box { 
                border: 2px dashed #667eea; 
                padding: 40px; 
                text-align: center; 
                border-radius: 10px; 
                background: #f8f9ff;
            }
            button { 
                background: #667eea; 
                color: white; 
                padding: 12px 35px; 
                border: none; 
                border-radius: 5px; 
                cursor: pointer; 
                font-size: 16px; 
                margin-top: 20px; 
            }
            button:hover { background: #5568d3; }
            button:disabled { background: #ccc; cursor: not-allowed; }
            #result { 
                margin-top: 30px; 
                padding: 20px; 
                background: #f0f0f0; 
                border-radius: 5px; 
                display: none; 
                white-space: pre-wrap;
                line-height: 1.6;
            }
            .loading { color: #667eea; font-weight: bold; }
            
            </style>
        </head>
        
        <body>
            <h1>📚Lecture Transcription System </h1>
            <p> Upload an audio file and get AI-powered transcription</p>
            <div class ="upload-box">
                <input type ="file" id="audioFile" accept="audio/*">
                <br>
                <button id="uploadBtn">Transcribe Audio</button>
            </div>
            
            <div id="result"> </div>
            
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                async function uploadFile() {
                    const fileInput = document.getElementById('audioFile');
                    const resultDiv = document.getElementById('result');
                    const uploadBtn = document.getElementById('uploadBtn');
                    
                    
                    if(!fileInput.files[0]) {
                        alert('PLease select a file first!');
                        return;
                    }
                    //Use formData to do manual submission for better UX
                    const formData = new FormData()
                    formData.append('file', fileInput.files[0]);
                    
                    // Disable button and show loading
                    uploadBtn.disabled = true;
                    resultDiv.innerHTML = '<p class= "loading"> ⏳Transcribing ...This may take 10-30 seconds </p>';
                    resultDiv.style.display= 'block';
                    
                    try {
                        const response = await fetch('/transcribe', {
                            method:'POST',
                            body: formData
                            //header only required for application/json, header for formdata is automatically handled by browser
                        });
                    
                        const data = await response.json();
                    
                        if(response.ok){
                            resultDiv.innerHTML=
                                '<strong> ✅Transcription Complete! </strong><br> <br>' +
                                '<strong>File:</strong>' + data.filename + '<br><br>' + 
                                '<strong>Text:</strong><br>' + data.transcription;
                        }
                        else {
                        resultDiv.innerHTML = '<strong> ❌Error: </strong> ' + data.detail;
                        }
                    }
                    
                    catch (error){
                        resultDiv.innerHTML = '<strong> ❌ Error: </strong>' + error.message;
                    }
                    finally{
                        uploadBtn.disabled = false;
                    }
                }
                // ⬇️ ADD THIS LINE - attach function to button
                document.getElementById('uploadBtn').addEventListener('click', uploadFile);
                });
            </script>
                     
        </body>
        
    </html>
    """
    return HTMLResponse(content=html)

@app.get("/health")
def health():
    return {"status": "working"}

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile= File(...)): #get the file from File()
    """
       Transcribe the audio using OpenAI Whisper API
    """
    # Validate file type
    allowed_type = ["audio/mpeg", "audio/mp3","audio/wav", "audio/ma",  "audio/x-wav",
                    "audio/mp4", "audio/x-m4a", "audio/webm", "audio/flac"]

    if file.content_type not in allowed_type:
        raise HTTPException(
            status_code=404,
            detail=f"Invalid file type: {file.content_type}. Please upload an audio file")

    #Check file size( Whisper API limit is 25MB)
    MAX_SIZE_MB = 25

    #Method 1 Try file.size first
    if file.size:
        file_size_mb = file.size/(1024*1024)
    else:
        #Size not available in content_header then- read and check
        contents = await file.read()
        file_size_mb = len(contents)/(1024*1024)
        await file.seek(0) #to read the file again later for whisper api

    if file_size_mb > MAX_SIZE_MB:
        raise HTTPException(
            status_code=404,
            detail= f"File too large ({file_size_mb:.1f}MB). Maximum is {MAX_SIZE_MB}MB"
        )

    try:
        #Read the file-content
        contents = await file.read()

        #Create BytesIO with filename
        audio_file = io.BytesIO(contents) #make file like object for bytes
        audio_file.name = file.filename


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






