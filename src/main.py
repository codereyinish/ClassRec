from fastapi import FastAPI, File, UploadFile, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
import os
from dotenv import load_dotenv
import asyncio
from functools import partial
import soundfile as sf
from typing import Tuple
from validators import validate_audio_file
from pathlib import Path
import json
import io
import requests
from logger import logger
from pydantic import BaseModel, Field, field_validator
import sentry_sdk
import onnxruntime as ort
import numpy as np
import psutil
import tracemalloc
import torch
import warnings
warnings.filterwarnings("ignore")
torch.backends.nnpack.enabled = False

sentry_sdk.init(
    dsn="https://f62227a4abc04cfda1165ef380cdc745@o4511040460488704.ingest.us.sentry.io/4511040467566592",
    send_default_pii=True,
)

# ======= SETUP =======
load_dotenv()
CLERK_PUBLISHABLE_KEY = os.getenv("CLERK_PUBLISHABLE_KEY", "pk_test_ZXRoaWNhbC1tYWNhdy00OS5jbGVyay5hY2NvdW50cy5kZXYk")

app = FastAPI()

# Limit concurrent heavy pipeline runs to avoid OOM on a 2GB server.
# Each run peaks at ~350MB; 2 slots keeps us under the safe threshold.
_pipeline_semaphore = asyncio.Semaphore(1)

# ======= MEMORY TRACKING =======
_process = psutil.Process(os.getpid())
_mem_baseline_mb: float = 0.0
_mem_after_models_mb: float = 0.0

BASE_DIR = Path(__file__).parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.globals["clerk_key"] = CLERK_PUBLISHABLE_KEY
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


# ======= CONSTANTS =======
SAMPLE_RATE       = 16000
BYTES_PER_SAMPLE  = 2
BYTES_PER_SECOND  = SAMPLE_RATE * BYTES_PER_SAMPLE  # 32,000
CHUNK_DURATION    = 10
CHUNK_BYTES       = BYTES_PER_SECOND * CHUNK_DURATION   # 10s advance per chunk

MODAL_WHISPER_URL = os.getenv("MODAL_WHISPER_URL", "")  # set after: modal deploy modal_whisper.py

# VAD
VAD_WINDOW_SIZE   = 512
VAD_THRESHOLD     = 0.2
VAD_PAD_SEC       = 0.2

# Segmentation
SEG_THRESHOLD     = 0.3
MIN_REGION_SEC    = 1.5

# Embedding
MIN_SEGMENT_SEC   = 0.5

# Similarity
SIMILARITY_THRESHOLD = 0.20


# ======= PYDANTIC DATA VALIDATION =======
VALID_TAGS = {"exam", "assignment", "important", "attendance", "classwork"}

class TagConfig(BaseModel):
    tags: list[str] = []
    name: str = Field(default="", max_length=50)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags):
        return [t for t in tags if t in VALID_TAGS]

class ContextMessage(BaseModel):
    type: str
    prompt: str = Field(default="", max_length=300)
    tagConfig: TagConfig = Field(default_factory=TagConfig)


# ======= AUDIO HELPERS =======
def pcm_to_float(pcm_bytes: bytes) -> np.ndarray:
    """
    Convert raw PCM int16 bytes → float32 numpy array.
    Browser sends 16-bit PCM. Models expect float32 in [-1, 1].
    """
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if np.abs(samples).max() > 0:
        samples = samples / np.abs(samples).max()
    return samples


# ======= STEP 1: WHISPER VIA MODAL (faster-whisper large-v3 + stable-ts on T4 GPU) =======
# Transcription runs remotely on Modal — no GPU or Whisper model on this server.
# _modal_session is a requests.Session for connection reuse across chunks.
_modal_session: requests.Session | None = None


def transcribe_with_timestamps(samples: np.ndarray) -> list[dict]:
    """
    Send audio to the Modal Whisper endpoint and return word-level timestamps.
    Returns list of {"word": str, "start": float, "end": float}.

    Why send the full chunk before any speaker filtering?
    Whisper needs full audio context to be accurate. We transcribe everything,
    then main.py filters by speaker timestamps using the local ECAPA-TDNN pipeline.

    Cold start: first request after idle spins up a T4 container (~3-5s).
    Warm requests: ~1-2s round-trip for a 10s chunk.
    """
    buf = io.BytesIO()
    sf.write(buf, samples, SAMPLE_RATE, format="WAV")
    wav_bytes = buf.getvalue()

    logger.debug(f"[whisper] calling Modal ({len(samples)/SAMPLE_RATE:.1f}s audio)")
    response = _modal_session.post(
        MODAL_WHISPER_URL,
        data=wav_bytes,
        headers={"Content-Type": "audio/wav"},
        timeout=90,  # generous: first warm-up can take ~20s
    )
    response.raise_for_status()
    words = response.json()

    logger.debug(f"[whisper] {len(words)} words transcribed")
    return words


# ======= TEXT ANALYSIS =======
def analyze_text(text: str, selected_tags: list, custom_name: str) -> list:
    """Detect keywords and return matching tag list."""
    text_lower = text.lower()
    tags = []
    keyword_map = {
        "exam":       ["exam", "midterm", "final", "quiz", "test", "will be on"],
        "assignment": ["homework", "due", "submit", "assignment", "due date", "turn in"],
        "important":  ["important", "remember this", "key concept", "pay attention"],
        "attendance": ["attendance", "sign in", "roll call", "present"],
        "classwork":  ["classwork", "in class", "class activity"],
    }
    for tag, keywords in keyword_map.items():
        if tag in selected_tags and any(kw in text_lower for kw in keywords):
            tags.append(tag)
    if custom_name and custom_name.lower() in text_lower:
        tags.append("name")
    logger.debug(f"tags collected: {tags}")
    return tags


# ======= TRANSCRIBE CHUNK (full pipeline from VAD to dedup) =======
def _run_pipeline_sync(
    pcm_bytes: bytes,
    lecture_prompt: str,
    selected_tags: list,
    custom_name: str,
    professor_embedding: np.ndarray | None,
    similarity_threshold: float,
    session_state: dict,
    chunk_offset: float,
) -> dict | None:
    """
    CPU-bound pipeline: Steps 1-7 (all model inference).
    Runs in a thread pool via run_in_executor so the async event loop
    stays free to handle other users while models are running.
    Returns a JSON-ready dict to send, or None if nothing to send.
    """
    samples = pcm_to_float(pcm_bytes)

    # Step 1: Whisper — always runs on full chunk for best accuracy
    words = transcribe_with_timestamps(samples)
    if not words:
        logger.debug("[chunk] no words from Whisper")
        return None

    raw_transcript = ' '.join(w['word'] for w in words).strip()
    logger.debug(f"[raw whisper] {raw_transcript}")

    # Voice lock off — send raw transcript without speaker filtering
    if professor_embedding is None:
        detected_tags = analyze_text(raw_transcript, selected_tags, custom_name)
        word_list = [{"w": w["word"], "s": round(w["start"] + chunk_offset, 3), "e": round(w["end"] + chunk_offset, 3)} for w in words]
        return {"type": "transcription", "text": raw_transcript, "tags": detected_tags, "words": word_list}

    # Step 2: VAD — find speech regions, filter silence
    vad_h = session_state.get('vad_h', np.zeros((2, 1, 64), dtype=np.float32))
    vad_c = session_state.get('vad_c', np.zeros((2, 1, 64), dtype=np.float32))
    vad_regions, region_end_states = get_vad_regions(samples, vad_h, vad_c)
    logger.debug(f"[vad] {len(vad_regions)} regions: {[(round(s,1), round(e,1)) for s,e in vad_regions]}")
    if not vad_regions:
        logger.debug("[chunk] no speech regions detected by VAD")
        return None

    # Step 3: Segmentation — split VAD regions at speaker change points
    segments = get_segments(samples, vad_regions)

    # Step 4: ECAPA-TDNN — compare each segment vs professor embedding
    professor_segments, sim_scores = get_professor_segments(
        samples, segments, professor_embedding, similarity_threshold
    )

    if not professor_segments:
        logger.debug("[chunk] no professor detected in this chunk")
        # Reset so dedup doesn't fire on the next chunk — if professor was absent
        # here, the tail of last_transcript could false-match and silently drop
        # valid words at the start of the next professor chunk.
        session_state['last_transcript'] = ''
        return None

    # Save VAD state from the last confident professor region so the next
    # chunk starts warm. Guard: sim >= 0.40 to avoid saving state from a
    # borderline detection that could be a non-professor speaker.
    VAD_STATE_MIN_SIM = 0.40
    last_sim = sim_scores[-1] if sim_scores else 0.0
    if last_sim >= VAD_STATE_MIN_SIM and region_end_states:
        last_prof_end = professor_segments[-1][1]
        for idx, (vs, ve) in enumerate(vad_regions):
            if vs <= last_prof_end <= ve + 0.5:
                h, c = region_end_states[idx]
                session_state['vad_h'] = h
                session_state['vad_c'] = c
                break

    # Step 5: Word stitch — keep words whose midpoint falls in a professor segment
    transcript, kept_words = stitch_professor_words(words, professor_segments, vad_regions)
    if not transcript:
        logger.debug("[chunk] no words remained after stitch")
        return None

    # Step 6: Hallucination filter
    transcript = filter_hallucinations(transcript)
    if not transcript:
        logger.debug("[chunk] transcript empty after hallucination filter")
        return None

    # Step 7: Dedup — remove words repeated at the 2s chunk overlap boundary
    transcript = deduplicate_overlap(session_state.get('last_transcript', ''), transcript)
    session_state['last_transcript'] = transcript

    if not transcript.strip():
        return None

    # Re-align word dicts to match filtered transcript, then apply chunk offset
    final_words = words_for_transcript(transcript, kept_words)
    word_list = [{"w": w["word"], "s": round(w["start"] + chunk_offset, 3), "e": round(w["end"] + chunk_offset, 3)} for w in final_words]

    detected_tags = analyze_text(transcript, selected_tags, custom_name)
    logger.debug(f"[filtered] {transcript}")
    return {"type": "transcription", "text": transcript, "tags": detected_tags, "words": word_list}


async def transcribe_chunk(
    pcm_bytes: bytes,
    websocket: WebSocket,
    lecture_prompt: str,
    selected_tags: list,
    custom_name: str,
    professor_embedding: np.ndarray | None,
    similarity_threshold: float,
    session_state: dict,
    chunk_offset: float,
):
    """
    Full per-chunk pipeline:

      Steps 1-7 — CPU-bound model inference, runs in a thread pool so the
                  event loop stays free to handle other WebSocket connections.
      Step 8    — Send result to browser on the main async loop.

    When voice lock is off (professor_embedding is None), skip steps 2-7 and send raw Whisper output.
    """
    try:
        loop = asyncio.get_event_loop()
        async with _pipeline_semaphore:
            result = await loop.run_in_executor(
                None,
                partial(
                    _run_pipeline_sync,
                    pcm_bytes,
                    lecture_prompt,
                    selected_tags,
                    custom_name,
                    professor_embedding,
                    similarity_threshold,
                    session_state,
                    chunk_offset,
                )
            )

            # Step 8: Send to browser — must happen on the async loop, not in the thread
            if result is not None:
                await websocket.send_json(result)

    except Exception as e:
        logger.exception(f"transcribe_chunk error: {e}")
        await websocket.send_json({
            "type": "error",
            "message": "Transcription failed. Please try again."
        })


# ======= ROUTES =======
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    return templates.TemplateResponse("upload.html", {"request": request})

@app.get("/live", response_class=HTMLResponse)
async def live_page(request: Request):
    return templates.TemplateResponse("live.html", {"request": request})

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse("static/favicon.ico")

@app.get("/health")
def health():
    """Health check with live memory breakdown."""
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
            "limit_mb": 2048,
            "used_percent": round(current_mb / 2048 * 100, 1),
        },
        "top_allocators": breakdown,
    }


# ======= FILE UPLOAD (Modal Whisper — same large-v3 model as live pipeline) =======
@app.post("/transcribe")
async def transcribe_audio(
    file: UploadFile,
    validated_data: Tuple[bytes, str, float, str] = Depends(validate_audio_file)
):
    contents, mime, file_size_mb, correct_ext = validated_data
    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: _modal_session.post(
                MODAL_WHISPER_URL,
                data=contents,
                headers={"Content-Type": mime},
                timeout=120,
            )
        )
        response.raise_for_status()
        words = response.json()
        transcript = " ".join(w["word"] for w in words).strip()

        return {
            "filename": file.filename,
            "transcription": transcript,
            "file_size_mb": round(file_size_mb, 2)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription Failed: {str(e)}")


# ======= VAD =======
VAD_MODEL_PATH = BASE_DIR / "models" / "silero_vad.onnx"
_vad_session = None


def get_vad_regions(
    samples: np.ndarray,
    init_h: np.ndarray,
    init_c: np.ndarray,
) -> tuple[list[tuple[float, float]], list[tuple]]:
    """
    Slide VAD across the full chunk, return (regions, region_end_states).

    init_h / init_c: LSTM state carried from the previous chunk's last
    professor region — avoids cold-start (zeros) which causes low scores
    for the first 0.3-0.5s and drops leading words after a speaker change.
    """
    h  = init_h.copy()
    c  = init_c.copy()
    sr = np.array(SAMPLE_RATE, dtype=np.int64)

    frame_times, frame_scores, frame_states = [], [], []
    for i in range(0, len(samples) - VAD_WINDOW_SIZE + 1, VAD_WINDOW_SIZE):
        w    = samples[i: i + VAD_WINDOW_SIZE].reshape(1, VAD_WINDOW_SIZE)
        outs = _vad_session.run(None, {'input': w, 'sr': sr, 'h': h, 'c': c})
        h, c = outs[1], outs[2]
        frame_times.append(i / SAMPLE_RATE)
        frame_scores.append(float(outs[0].squeeze()))
        frame_states.append((h.copy(), c.copy()))

    raw_regions, in_speech, start = [], False, 0.0
    for t, score in zip(frame_times, frame_scores):
        if score >= VAD_THRESHOLD and not in_speech:
            start, in_speech = t, True
        elif score < VAD_THRESHOLD and in_speech:
            raw_regions.append((start, t))
            in_speech = False
    if in_speech:
        raw_regions.append((start, len(samples) / SAMPLE_RATE))

    if not raw_regions:
        return [], []

    total  = len(samples) / SAMPLE_RATE
    padded = [(max(0.0, s - VAD_PAD_SEC), min(total, e + VAD_PAD_SEC)) for s, e in raw_regions]

    merged = [padded[0]]
    for (s, e) in padded[1:]:
        prev_s, prev_e = merged[-1]
        if s <= prev_e:
            merged[-1] = (prev_s, max(prev_e, e))
        else:
            merged.append((s, e))

    def state_at(t: float):
        idx = min(range(len(frame_times)), key=lambda i: abs(frame_times[i] - t))
        return frame_states[idx]

    region_end_states = [state_at(e) for (_, e) in merged]
    return merged, region_end_states


# ======= SEGMENTATION =======
SEG_MODEL_PATH = BASE_DIR / "models" / "segmentation.onnx"
_seg_session   = None

def split_by_speaker_change(region_samples: np.ndarray, region_start: float) -> list[tuple[float, float]]:
    """
    Run pyannote segmentation ONNX on a VAD region.
    The model outputs per-frame probabilities across speaker channels.
    When the dominant channel (argmax) switches, that's a speaker change.
    Returns list of (start_sec, end_sec) sub-segments.

    Why do we need this?
    A single VAD region may contain both professor and student speech.
    Segmentation splits it so we can embed each piece separately and
    identify which piece belongs to the professor.
    """
    duration   = len(region_samples) / SAMPLE_RATE
    inp        = region_samples.reshape(1, 1, -1).astype(np.float32)
    output     = _seg_session.run(None, {'input_values': inp})
    seg        = output[0].squeeze(0)
    seg        = 1.0 / (1.0 + np.exp(-seg))  # sigmoid: logits → probabilities

    num_frames    = seg.shape[0]
    frame_dur     = duration / num_frames
    sub_segments  = []
    in_speech     = False
    seg_start     = 0.0
    prev_dominant = -1

    for i, frame in enumerate(seg):
        t         = i * frame_dur
        is_speech = float(frame.max()) > SEG_THRESHOLD
        dominant  = int(np.argmax(frame))

        if is_speech and not in_speech:
            seg_start     = t
            in_speech     = True
            prev_dominant = dominant
        elif is_speech and in_speech:
            if dominant != prev_dominant:  # speaker changed
                sub_segments.append((region_start + seg_start, region_start + t))
                seg_start     = t
                prev_dominant = dominant
        elif not is_speech and in_speech:
            sub_segments.append((region_start + seg_start, region_start + t))
            in_speech = False

    if in_speech:
        sub_segments.append((region_start + seg_start, region_start + duration))

    return sub_segments if sub_segments else [(region_start, region_start + duration)]


def get_segments(samples: np.ndarray, vad_regions: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Run segmentation on each VAD region, collect all sub-segments."""
    final_segments = []
    for (start, end) in vad_regions:
        duration = end - start
        if duration < MIN_SEGMENT_SEC:
            continue
        if duration >= MIN_REGION_SEC:
            region_samples = samples[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
            sub = split_by_speaker_change(region_samples, region_start=start)
            logger.debug(f"[seg] region {start:.1f}s-{end:.1f}s → {len(sub)} sub-segments")
            final_segments.extend(sub)
        else:
            final_segments.append((start, end))
    logger.debug(f"[segments] {len(final_segments)}: {[(f'{s:.1f}', f'{e:.1f}') for s,e in final_segments]}")
    return final_segments


# ======= ECAPA-TDNN EMBEDDING =======
_ecapa_model = None

def get_embedding(samples: np.ndarray) -> np.ndarray | None:
    """
    Run audio samples through ECAPA-TDNN model.
    Returns normalized 192-dimensional speaker embedding vector.
    """
    if len(samples) < int(SAMPLE_RATE * MIN_SEGMENT_SEC):
        return None
    tensor = torch.tensor(samples).unsqueeze(0)
    with torch.no_grad():
        emb = _ecapa_model.encode_batch(tensor).squeeze().numpy()
    return emb / np.linalg.norm(emb)


def compute_professor_embedding(pcm_bytes: bytes) -> tuple[np.ndarray, float] | tuple[None, None]:
    """
    Process enrollment audio into a single embedding.
    Concatenates all VAD speech regions → single ECAPA-TDNN embedding.
    Returns (professor_embedding, similarity_threshold).
    """
    samples     = pcm_to_float(pcm_bytes)
    init_h = np.zeros((2, 1, 64), dtype=np.float32)
    init_c = np.zeros((2, 1, 64), dtype=np.float32)
    vad_regions, _ = get_vad_regions(samples, init_h, init_c)

    if not vad_regions:
        logger.warning("[enroll] no speech detected during enrollment")
        return None, None

    voiced_chunks = [samples[int(s * SAMPLE_RATE): int(e * SAMPLE_RATE)] for s, e in vad_regions]
    voiced        = np.concatenate(voiced_chunks)
    emb           = get_embedding(voiced)

    if emb is None:
        logger.warning(f"[enroll] could not extract embedding from {len(voiced)/SAMPLE_RATE:.1f}s voiced audio")
        return None, None

    logger.info(f"[enroll] embedding computed from {len(voiced)/SAMPLE_RATE:.1f}s voiced audio, threshold={SIMILARITY_THRESHOLD}")
    return emb, SIMILARITY_THRESHOLD


def get_professor_segments(
    samples: np.ndarray,
    segments: list[tuple[float, float]],
    professor_embedding: np.ndarray,
    similarity_threshold: float,
) -> tuple[list[tuple[float, float]], list[float]]:
    """
    For each segment, embed it and compare against the single professor embedding.
    Returns (professor_segments, sim_scores) — sim_scores parallel to professor_segments.
    """
    professor_segments = []
    sim_scores         = []
    for (start, end) in segments:
        if (end - start) < MIN_SEGMENT_SEC:
            continue
        chunk = samples[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
        emb   = get_embedding(chunk)
        if emb is None:
            continue
        sim     = float(np.dot(emb, professor_embedding))
        is_prof = sim >= similarity_threshold
        logger.debug(f"[emb] {start:.1f}s-{end:.1f}s sim={sim:.3f} → {'PROFESSOR' if is_prof else 'other'}")
        if is_prof:
            professor_segments.append((start, end))
            sim_scores.append(sim)
    logger.debug(f"[professor] {[(f'{s:.1f}', f'{e:.1f}') for s,e in professor_segments]}")
    return professor_segments, sim_scores


# ======= WORD STITCH =======
def stitch_professor_words(
    words: list[dict],
    professor_segments: list[tuple[float, float]],
    vad_regions: list[tuple[float, float]],
) -> tuple[str, list[dict]]:
    """
    Keep only words whose midpoint timestamp falls inside a professor segment.
    0.5s buffer on segment end to catch words slightly past the boundary.

    For the first professor segment, effective_start is stretched back to the
    first VAD region start — covers words in short leading VAD regions that
    were dropped before segmentation (VAD/segmentation cold-start latency).
    Returns (joined_text, list_of_word_dicts) — full dicts so timestamps survive.
    """
    first_vad_start = vad_regions[0][0] if vad_regions else 0.0
    kept = []
    for w in words:
        mid = (w['start'] + w['end']) / 2.0
        for i, (seg_start, seg_end) in enumerate(professor_segments):
            effective_start = first_vad_start if i == 0 else seg_start
            if effective_start <= mid <= seg_end + 0.5:
                kept.append(w)
                break
    logger.debug(f"[stitch] {len(kept)}/{len(words)} words kept")
    return ' '.join(w['word'] for w in kept).strip(), kept


def words_for_transcript(transcript: str, word_dicts: list[dict]) -> list[dict]:
    """
    After hallucination filter / dedup trim the transcript string, re-align the
    word dict list to match only what's actually in the final text.
    Greedy left-to-right scan — works because filtering never reorders words.
    """
    result = []
    wi = 0
    for tw in transcript.split():
        while wi < len(word_dicts):
            if word_dicts[wi]['word'].strip().lower() == tw.lower():
                result.append(word_dicts[wi])
                wi += 1
                break
            wi += 1
    return result


# ======= HALLUCINATION FILTER =======
WHISPER_HALLUCINATIONS = {
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "like and subscribe",
    "subscribe to",
    "don't forget to subscribe",
    "see you in the next",
    "see you next time",
    "thanks for listening",
    "thank you for listening",
    "i'll see you in the next video",
    "thank you very much",
}

def filter_hallucinations(transcript: str) -> str:
    """Remove known Whisper hallucination phrases that appear in silent/low-energy audio."""
    lower = transcript.lower()
    for phrase in WHISPER_HALLUCINATIONS:
        idx = lower.find(phrase)
        if idx != -1:
            transcript = (transcript[:idx] + transcript[idx + len(phrase):]).strip()
            lower = transcript.lower()
            logger.debug(f"[hallucination] removed: '{phrase}'")
    return transcript


# ======= DEDUP =======
def deduplicate_overlap(prev_transcript: str, curr_transcript: str, overlap_words: int = 8) -> str:
    """
    Remove words at the start of curr_transcript that also appear at the end of prev_transcript.

    Why needed? Audio buffer is not cleared fully each chunk — leftover bytes from the previous
    chunk can cause the same words to appear at the start of the next transcript.
    """
    if not prev_transcript:
        return curr_transcript
    prev_words = prev_transcript.lower().split()
    curr_words = curr_transcript.split()
    curr_lower = curr_transcript.lower().split()
    max_check  = min(overlap_words, len(prev_words), len(curr_words))
    for n in range(max_check, 1, -1):
        if prev_words[-n:] == curr_lower[:n]:
            logger.debug(f"[dedup] removed {n} repeated words from chunk start")
            return ' '.join(curr_words[n:]).strip()
    return curr_transcript


def show_Graphical_Audio_Progress(filled):
    total   = CHUNK_BYTES
    percent = int((filled / total) * 100)
    bar     = '█' * (percent // 10) + '░' * (10 - percent // 10)
    print(f"\r  🎙️ Audio Buffer  [{bar}] {percent}%  ({filled}/{total} bytes)", end='', flush=True)


# ======= WEBSOCKET =======
@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    """
    WebSocket handler — one connection per recording session.
    Session state is kept in local variables (not global) so multiple
    users can record simultaneously without interfering.
    """
    await websocket.accept()

    audio_buffer      = bytearray()
    lecture_prompt    = ""
    selected_tags     = []
    custom_name       = ""
    enrolling         = False
    enrollment_buffer = bytearray()
    chunk_count       = 0

    # Per-session speaker state
    professor_embedding: np.ndarray | None = None
    similarity_threshold = SIMILARITY_THRESHOLD
    voice_lock_active    = False
    session_state        = {
        'last_transcript': '',
        'vad_h': np.zeros((2, 1, 64), dtype=np.float32),
        'vad_c': np.zeros((2, 1, 64), dtype=np.float32),
    }

    try:
        while True:
            data = await websocket.receive()

            if data.get("type") == "websocket.disconnect":
                break

            if "text" in data:
                try:
                    raw = json.loads(data["text"])
                    msg = ContextMessage(**raw)

                    if msg.type == "context":
                        lecture_prompt = msg.prompt
                        selected_tags  = msg.tagConfig.tags
                        custom_name    = msg.tagConfig.name

                    elif msg.type == "enroll_start":
                        enrolling = True
                        enrollment_buffer.clear()
                        logger.info("Enrollment started")

                    elif msg.type == "enroll_end":
                        enrolling = False
                        try:
                            professor_embedding, similarity_threshold = compute_professor_embedding(
                                bytes(enrollment_buffer)
                            )
                        except Exception as emb_err:
                            logger.error(f"Embedding error: {emb_err}")
                            professor_embedding  = None


                        if professor_embedding is not None:
                            voice_lock_active = True
                            # initiate fresh session_state
                            session_state     = {
                                'last_transcript': '',
                                'vad_h': np.zeros((2, 1, 64), dtype=np.float32),
                                'vad_c': np.zeros((2, 1, 64), dtype=np.float32),
                            }
                            await websocket.send_json({"type": "enroll_success"})
                            logger.info(f"Professor voice locked (threshold={similarity_threshold:.3f})")
                        else:
                            await websocket.send_json({
                                "type": "enroll_failed",
                                "message": "Not enough audio captured"
                            })

                    elif msg.type == "voice_lock_off":
                        voice_lock_active   = False
                        professor_embedding = None
                        enrollment_buffer.clear()
                        # Reset session_state
                        session_state       = {
                            'last_transcript': '',
                            'vad_h': np.zeros((2, 1, 64), dtype=np.float32),
                            'vad_c': np.zeros((2, 1, 64), dtype=np.float32),
                        }
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
                    enrollment_buffer.extend(packet)
                    continue
                # Safety guard to check the size of the chunk
                if len(audio_buffer) > CHUNK_BYTES * 4:
                    await websocket.send_json({"type": "error", "message": "Audio limit exceeded"})
                    await websocket.close()
                    break

                audio_buffer.extend(packet)

                if len(audio_buffer) >= CHUNK_BYTES:
                    chunk_to_process = bytes(audio_buffer)
                    del audio_buffer[:CHUNK_BYTES]

                    chunk_offset = chunk_count * CHUNK_DURATION
                    chunk_count += 1

                    asyncio.create_task(transcribe_chunk(
                        chunk_to_process, websocket,
                        lecture_prompt, selected_tags, custom_name,
                        professor_embedding if voice_lock_active else None,
                        similarity_threshold,
                        session_state,
                        chunk_offset,
                    ))

    except WebSocketDisconnect:
        print("Client disconnected from WebSocket")
    except Exception as e:
        print(f"WebSocket error: {e}")


# ======= STARTUP =======
@app.on_event("startup")
async def startup_event():
    global _mem_baseline_mb, _mem_after_models_mb
    global _vad_session, _seg_session, _ecapa_model, _modal_session

    tracemalloc.start()
    _mem_baseline_mb = _process.memory_info().rss / 1024 / 1024
    logger.info(f"Startup baseline memory: {_mem_baseline_mb:.1f} MB")

    if VAD_MODEL_PATH.exists():
        _vad_session = ort.InferenceSession(str(VAD_MODEL_PATH))
        logger.info("VAD model loaded")
    else:
        logger.warning("VAD model not found")

    if SEG_MODEL_PATH.exists():
        _seg_session = ort.InferenceSession(str(SEG_MODEL_PATH))
        logger.info("Segmentation model loaded")
    else:
        logger.warning("Segmentation model not found")

    from speechbrain.inference.speaker import EncoderClassifier
    _ecapa_model = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(BASE_DIR / "models" / "ecapa_tdnn"),
        run_opts={"device": "cpu"}
    )
    _ecapa_model.eval()
    logger.info("ECAPA-TDNN embedding model loaded")

    # Whisper runs on Modal — just init an HTTP session for connection reuse
    _modal_session = requests.Session()
    if MODAL_WHISPER_URL:
        logger.info(f"Modal Whisper endpoint configured: {MODAL_WHISPER_URL}")
    else:
        logger.warning("MODAL_WHISPER_URL not set — transcription will fail")

    _mem_after_models_mb = _process.memory_info().rss / 1024 / 1024
    logger.info(f"Memory after all models loaded: {_mem_after_models_mb:.1f} MB")
