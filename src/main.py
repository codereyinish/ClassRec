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
from logger import logger
from pydantic import BaseModel, Field, field_validator
import sentry_sdk
import onnxruntime as ort
import numpy as np
import psutil
import tracemalloc

sentry_sdk.init(
    dsn="https://f62227a4abc04cfda1165ef380cdc745@o4511040460488704.ingest.us.sentry.io/4511040467566592",
    send_default_pii=True,
)

#=======SETUP========
load_dotenv()
CLERK_PUBLISHABLE_KEY = os.getenv("CLERK_PUBLISHABLE_KEY", "pk_test_ZXRoaWNhbC1tYWNhdy00OS5jbGVyay5hY2NvdW50cy5kZXYk")

api_key = os.environ.get("OPENAI_API_KEY")
client = OpenAI()
app = FastAPI()

# ======= MEMORY TRACKING =======
_process = psutil.Process(os.getpid())
_mem_baseline_mb: float = 0.0
_mem_after_models_mb: float = 0.0

BASE_DIR = Path(__file__).parent.parent  # goes up from src/ to ClassRec/
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.globals["clerk_key"] = CLERK_PUBLISHABLE_KEY
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


#=======CONSTANTS=========
SAMPLE_RATE = 16000  # 16kHz
BYTES_PER_SAMPLE = 2  # Int16
BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE  # 32,000
CHUNK_DURATION = 10
MAX_BUFFER_BYTES = BYTES_PER_SECOND * CHUNK_DURATION


#=======PYDANTIC DATA VALIDATION=========
VALID_TAGS = {"exam", "assignment", "important", "attendance", "classwork"}

class  TagConfig(BaseModel):
    tags: list[str] = []
    name: str= Field(default="",max_length= 50)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags):
        return [t for t in tags if t in VALID_TAGS]

class ContextMessage(BaseModel):
    type:str
    prompt:str =  Field(default="", max_length=300)
    tagConfig: TagConfig = Field(default_factory=TagConfig)



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
    return len(audio_buffer) >= MAX_BUFFER_BYTES



# ========TRANSCRIPTION=========
def call_whisper(audio_file: io.BytesIO,prompt: str="") -> str:
    """Send audio to Whisper API and return transcript text"""
    logger.debug(f"Prompt is {prompt}")
    transcript = client.audio.transcriptions.create(
        model = "whisper-1",
        file = audio_file,
        language = "en",
        prompt = prompt
    )
    return transcript.text


# ========TEXT ANALYSIS=========
def analyze_text(text: str, selected_tags:list, custom_name:str) -> list:
    """Detects keyword and return the list of tags"""
    text_lower = text.lower()
    tags = []

    keyword_map = {
        "exam": ["exam", "midterm", "final", "quiz", "test", "will be on"],
        "assignment": ["homework", "due", "submit", "assignment", "due date", "turn in"],
        "important": ["important", "remember this", "key concept", "pay attention"],
        "attendance": ["attendance", "sign in", "roll call", "present"],
        "classwork": ["classwork", "in class", "class activity"],
    }

    for tag, keywords in keyword_map.items():
       if tag in selected_tags and  any(kw in text_lower for kw in keywords ):
           tags.append(tag)

    if custom_name and custom_name.lower() in text_lower:
        tags.append("name")
    logger.debug(f"tags collected in this chunk are {tags} ")
    return tags



async def transcribe_chunk(chunk_data:bytes, websocket: WebSocket, lecture_prompt:str, selected_tags:list,
                           custom_name:str):
    """Convert audio chunk to WAV, transcribe, and send result to browser via websocket"""
    try:
        audio_file_wav = convert_pcm_to_wav(chunk_data)
        transcripted_text = call_whisper(audio_file_wav, lecture_prompt)
        logger.debug("Got Transcript ")
        if transcripted_text.strip(): # don't send empty transcriptions
            detected_tags = analyze_text(transcripted_text, selected_tags, custom_name)
            await websocket.send_json({
                "type": "transcription",
                "text": transcripted_text,
                "tags": detected_tags
            })
            logger.debug("Transcript + tags sent to Frontend")

    except Exception as e:
        logger.exception(f"transcribe_chunk error: {e}")
        await websocket.send_json({
        "type": "error",
        "message": "Transcription failed. Please try again."
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
    """Health check endpoint with live memory breakdown"""
    current_mb = _process.memory_info().rss / 1024 / 1024

    breakdown = []
    if tracemalloc.is_tracing():
        snapshot = tracemalloc.take_snapshot()
        for stat in snapshot.statistics("filename")[:5]:
            filename = stat.traceback[0].filename if stat.traceback else "unknown"
            breakdown.append({
                "file": filename.split("/")[-1],
                "size_mb": round(stat.size / 1024 / 1024, 2),
            })

    return {
        "status": "healthy",
        "memory": {
            "current_mb": round(current_mb, 1),
            "baseline_mb": round(_mem_baseline_mb, 1),
            "growth_mb": round(current_mb - _mem_baseline_mb, 1),
            "after_models_load_mb": round(_mem_after_models_mb, 1),
            "limit_mb": 512,
            "used_percent": round(current_mb / 512 * 100, 1),
        },
        "top_allocators": breakdown,
    }


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


# ======= VAD (enrollment only — filters silence from professor capture) =======
VAD_MODEL_PATH = BASE_DIR/"models"/"silero_vad.onnx"
VAD_WINDOW_SIZE = 512
VAD_THRESHOLD = 0.5
_vad_session = None

def contains_speech(pcm_bytes: bytes) -> bool:
    """Returns True if the audio chunk likely contains human speech."""
    global _vad_session
    if _vad_session is None:
        if not VAD_MODEL_PATH.exists():
            logger.warning("VAD model not found")
            return True
        _vad_session = ort.InferenceSession(str(VAD_MODEL_PATH))
        logger.info("Silero VAD model loaded")

    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    h = np.zeros((2, 1, 64), dtype=np.float32)
    c = np.zeros((2, 1, 64), dtype=np.float32)
    sr = np.array(SAMPLE_RATE, dtype=np.int64)
    max_score = 0.0

    for i in range(0, len(samples) - VAD_WINDOW_SIZE + 1, VAD_WINDOW_SIZE):
        window = samples[i : i + VAD_WINDOW_SIZE].reshape(1, VAD_WINDOW_SIZE)
        outs = _vad_session.run(None, {"input": window, "sr": sr, "h": h, "c": c})
        score = float(outs[0].squeeze())
        h, c = outs[1], outs[2]
        if score > max_score:
            max_score = score
        if max_score >= VAD_THRESHOLD:
            break

    return max_score >= VAD_THRESHOLD


#======== SPEAKER DIARIZATION=========
SEG_MODEL_PATH = BASE_DIR/"models"/"segmentation.onnx"
EMB_MODEL_PATH = BASE_DIR/"models"/"embedding.onnx"
_seg_session = None
_emb_session = None



ENROLL_WINDOW_BYTES = BYTES_PER_SECOND * 1

def compute_professor_embedding(pcm_bytes: bytes) -> np.ndarray | None:
    """Split enrollment audio into 1s windows, embed each, return average."""
    logger.info(f"Enrollment buffer: {len(pcm_bytes)} bytes ({len(pcm_bytes)/BYTES_PER_SECOND:.1f}s)")
    if len(pcm_bytes) < ENROLL_WINDOW_BYTES:
        logger.warning(f"Enrollment audio too short: need {ENROLL_WINDOW_BYTES} bytes, got {len(pcm_bytes)}")
        return None
    embeddings = []
    for i in range(0, len(pcm_bytes)-ENROLL_WINDOW_BYTES+1, ENROLL_WINDOW_BYTES):
        window = pcm_bytes[i: i + ENROLL_WINDOW_BYTES]
        emb = get_embedding(window)
        if emb is not None:
            embeddings.append(emb)

    if not embeddings:
        return None

    avg = np.mean(embeddings, axis = 0)
    avg = avg/ np.linalg.norm(avg)
    return avg

def get_embedding(pcm_bytes:bytes) -> np.ndarray | None:
    """Run audio through embedding model, return 256-number speaker vector."""
    if _emb_session is None:
        logger.warning("Embedding model not loaded")
        return None

    import librosa

    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    mel_spec = librosa.feature.melspectrogram(y=samples, sr=SAMPLE_RATE, n_fft=512, hop_length=160, win_length=400, n_mels=80)
    mel_spec = librosa.power_to_db(mel_spec)

    features = mel_spec.T[np.newaxis, :, :]
    outputs = _emb_session.run(None, {"input_features": features})
    embedding = outputs[0].squeeze()
    return embedding


SIMILARITY_THRESHOLD = 0.75
MIN_SEGMENT_DURATION =0.5 #0.5 sec of segment size at least for bettte embedding
def filter_to_professor(pcm_bytes: bytes,professor_embedding: np.ndarray):
    """Segment audio, keep only professor voice, return filtered audio + leftover."""
    if _seg_session is None:
        logger.warning("Segmentation model not loaded, skipping Filter")
        return pcm_bytes, b""

    # Step 1 Run segmentation model
    samples = np.frombuffer(pcm_bytes, dtype = np.int16).astype(np.float32)/32768.0
    samples = samples.reshape(1, -1) #batch, samples
    output = _seg_session.run(None, {"input_values" : samples})
    segmentation = output[0].squeeze(0) # shape: [num_frames, frame_array]

    # Step 2 : Convert Frames to Time Segments
    num_frames = segmentation.shape[0]
    duration = len(pcm_bytes)/ BYTES_PER_SECOND
    frame_duration = duration/ num_frames

    segments = []
    in_speech = False
    seg_start = 0.0

    for i , frame in enumerate(segmentation):
        is_speech = frame.max() > 0.5 #0.5 is confidence score
        if is_speech and not in_speech:
            seg_start = i * frame_duration
            in_speech = True
        # so for next frame --> It is already in speech and if that frame is also is speech, then 1st conditon wont run
        #2nd condtion also doesnt run, In fact we have to do nothing, we only need to know start and end timestamp of
        elif not is_speech and in_speech:
            segments.append((seg_start,i*frame_duration))
            in_speech = False

        #for last frame 293, we dont have next frame,and append only happens when silence detected in next frame,
        # we dont have next frame lol
    if in_speech:
        segments.append((seg_start, duration))

    #filter segments by professor similarity
    professor_audio = b""
    leftover = b""

    for index, (start,end) in enumerate(segments):
        seg_duration = end - start
        is_last = index == len(segments) - 1

        if seg_duration < MIN_SEGMENT_DURATION and is_last:
            leftover = pcm_bytes[int(start * BYTES_PER_SECOND): ]
            continue

        if seg_duration < MIN_SEGMENT_DURATION:
            continue

        start_byte  = int(start * BYTES_PER_SECOND)
        end_byte = int(end * BYTES_PER_SECOND)
        seg_bytes = pcm_bytes[start_byte:end_byte]

        #Now we got the segment where speaker is speaking, we extracted original audio becasue we cant conitnue with
        # numpy segment from the segmentation model in different format
        emb = get_embedding(seg_bytes)
        if emb is None:
            continue

        similarity = np.dot(emb, professor_embedding) #Cosine dot multiplication
        logger.debug(f"Segment {start:.1f}s-{end:.1f}s similarity: {similarity:.3f}")

        if similarity >= SIMILARITY_THRESHOLD:
            professor_audio += seg_bytes
    return professor_audio , leftover




def show_Graphical_Audio_Progress(filled):
    total = BYTES_PER_SECOND * CHUNK_DURATION
    percent = int((filled / total) * 100)
    bar = '█' * (percent // 10) + '░' * (10 - percent // 10)

    # \r overwrites the same line — no spam
    print(f"\r  🎙️ Audio Buffer  [{bar}] {percent}%  ({filled}/{total} bytes)", end='', flush=True)




#========LIVE TRANSCRIPTION========
@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    """ Collect the audio into audio_buffer via websocket, transcribe it after fillup"""
    await websocket.accept()
    audio_buffer = bytearray()
    lecture_prompt = ""
    selected_tags = []
    custom_name = ""
    leftover = b"" #bytes zero bytes
    enrolling = False
    enrollment_buffer = bytearray()
    professor_embedding = None
    voice_lock_active = False

    try:
        while True:
            # Receive audio chunk from browser
            data  = await websocket.receive()

            if data.get("type") == "websocket.disconnect":
                break

            if "text" in data:
                try:
                    raw = json.loads(data["text"])
                    msg = ContextMessage(**raw)
                    logger.debug("Data Received: Text")
                    if msg.type== "context":
                        lecture_prompt = msg.prompt
                        selected_tags = msg.tagConfig.tags
                        custom_name = msg.tagConfig.name

                    elif msg.type=="enroll_start":
                        enrolling = True
                        enrollment_buffer.clear()
                        logger.info("Enrollment started")

                    elif msg.type=="enroll_end":
                        enrolling = False
                        try:
                            professor_embedding = compute_professor_embedding(bytes(enrollment_buffer))
                        except Exception as emb_err:
                            logger.error(f"Embedding error: {emb_err}")
                            professor_embedding = None
                        if professor_embedding is not None:
                            voice_lock_active = True
                            await websocket.send_json({"type": "enroll_success"})
                            logger.info("Professor voice Locked")
                        else:
                            await websocket.send_json({"type": "enroll_failed", "message": "Not enough audio captured"})
                            enrollment_buffer.clear()

                    elif msg.type == "voice_lock_off":
                        voice_lock_active = False
                        professor_embedding = None
                        enrollment_buffer.clear()
                        logger.info("Voice lock disabled")




                except WebSocketDisconnect:
                    raise
                except (json.JSONDecodeError, ValueError) as e:
                    logger.debug(f"Message parse error: {e}")
                    await websocket.send_json({"type": "error", "message": "Invalid message format"})
                    continue


            elif "bytes" in data:
                packet = data["bytes"]

                if enrolling:
                    if contains_speech(packet):
                        enrollment_buffer.extend(packet)
                        logger.debug("Added packet to enrollment_buffer");
                    continue

                # In case of buffer overflow due to external reasons
                if len(audio_buffer) > MAX_BUFFER_BYTES:
                    await websocket.send_json({"type": "error", "message": "Audio limit exceeded"})
                    await websocket.close()
                    break
                audio_buffer.extend(packet)
                filled = len(audio_buffer)

                show_Graphical_Audio_Progress(filled)

                if is_buffer_full(audio_buffer):
                    logger.debug("Audio_buffer Full. Sending to Pyannote")
                    chunk_to_process = leftover + bytes(audio_buffer)
                    audio_buffer.clear()
                    if voice_lock_active and professor_embedding is not None:
                        logger.debug("Filtering ")
                        chunk_to_process, leftover = filter_to_professor(chunk_to_process, professor_embedding)

                    else:
                        logger.debug("Not Using Professor VOice Lock Featrue  ")
                        leftover = b""
                    if chunk_to_process:
                        asyncio.create_task(transcribe_chunk(chunk_to_process, websocket, lecture_prompt, selected_tags,
                                                         custom_name))

    except WebSocketDisconnect:
        print("Client Disconnected from Websocket")
    except Exception as e:
        print(f"Websocket error : {e}")


# ======= STARTUP =======
@app.on_event("startup")
async def startup_event():
    global _mem_baseline_mb, _mem_after_models_mb, _vad_session, _seg_session, _emb_session

    tracemalloc.start()
    _mem_baseline_mb = _process.memory_info().rss / 1024 / 1024
    logger.info(f"Startup baseline memory: {_mem_baseline_mb:.1f} MB")

    if VAD_MODEL_PATH.exists():
        _vad_session = ort.InferenceSession(str(VAD_MODEL_PATH))
        logger.info("VAD model loaded (enrollment only)")
    else:
        logger.warning("VAD model not found at startup")

    if SEG_MODEL_PATH.exists():
        _seg_session = ort.InferenceSession(str(SEG_MODEL_PATH))
        logger.info("Segmentation Model Loaded")
    else:
        logger.warning("Segmentation model not found at startup")


    if EMB_MODEL_PATH.exists():
        _emb_session = ort.InferenceSession(str(EMB_MODEL_PATH))
        logger.info("Embedding model loaded")
    else:
        logger.warning("Embedding model not found at startup")



    _mem_after_models_mb = _process.memory_info().rss / 1024 / 1024
    logger.info(f"Memory after all models loaded: {_mem_after_models_mb:.1f} MB")



















