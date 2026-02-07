from fastapi import FastAPI,  File, UploadFile, HTTPException, Depends
from fastapi.responses import HTMLResponse
from openai import OpenAI
import os
from dotenv import load_dotenv
import io
from typing import Tuple
from validators import validate_audio_file



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






