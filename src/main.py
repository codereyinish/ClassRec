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
import httpx
from logger import logger
from sqlalchemy import update           # for the atomic usage increment
from sqlalchemy.orm import Session       # the DB session TYPE (for the type hint)
from database import get_db, SessionLocal  # get_db for routes; SessionLocal for the WS handler
import repository as repo                  # our data operations (create/list/...)
from clerk_auth import (current_user, current_user_optional,
                        clerk_user_id_from_token, get_or_create_user, AuthError)
from models import User                    # for the usage write on the socket
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

# One thread per inference, so chunks are what run in parallel rather than the
# insides of a single inference. Torch otherwise takes a thread per core for one
# forward pass, which combined with the semaphore below would put four threads on
# two cores — each slower, no more throughput, and the event loop starved of the
# slices it needs to keep draining audio.
#
# Parallelism has to come from one place or the other. Across chunks is the
# better choice for a server: independent work needs no coordination, and nobody
# is waiting on a single chunk when they arrive ten seconds apart.
torch.set_num_threads(1)

sentry_sdk.init(
    dsn="https://f62227a4abc04cfda1165ef380cdc745@o4511040460488704.ingest.us.sentry.io/4511040467566592",
    send_default_pii=True,
)

# ======= SETUP =======
load_dotenv()
CLERK_PUBLISHABLE_KEY = os.getenv("CLERK_PUBLISHABLE_KEY", "pk_test_ZXRoaWNhbC1tYWNhdy00OS5jbGVyay5hY2NvdW50cy5kZXYk")

app = FastAPI()

# How many chunks may run the models at once. One per core: this is what can
# actually compute, and the machine is a 2 vCPU / 4 GB droplet.
#
# It is not a memory limit any more. Measured, a run peaks at ~159MB, so two is
# ~320MB of 4GB — comfortable. Cores are the binding constraint, which is why the
# number tracks vCPUs rather than RAM.
#
# Safe to run concurrently because the model is read-only during inference:
# loaded once with .eval(), called under torch.no_grad(), so a forward pass
# mutates nothing. Two threads share the weights and keep their own activations.
# Measured on this model: 0.19s sequential, 0.12s concurrent, identical results.
_pipeline_semaphore = asyncio.Semaphore(2)

# ======= MEMORY TRACKING =======
_process = psutil.Process(os.getpid())
_mem_baseline_mb: float = 0.0
_mem_after_models_mb: float = 0.0

BASE_DIR = Path(__file__).parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.globals["clerk_key"] = CLERK_PUBLISHABLE_KEY
# Cache-busting: changes whenever the server (re)starts, so browsers re-fetch
# CSS/JS after a change instead of serving a stale cached copy. Append to asset
# URLs as ?v={{ asset_version }}.
import time as _time
templates.env.globals["asset_version"] = str(int(_time.time()))
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

# ======= USAGE POLICY =======
# Every second of audio accepted here costs a Modal GPU call, so the ceiling is
# enforced on the server. The same numbers exist in static/js/tracker.js, which
# is a courtesy to the UI — clearing localStorage resets those, and nothing about
# them reaches this file.
FREE_LIVE_SECONDS  = 20 * 60      # a signed-in account, free plan
# Declared so the panel is told an allowance by the server rather than by the
# page. Nothing enforces it yet: users.upload_seconds is never incremented, so
# uploads are unmetered — the number below is the intent, not a ceiling in force.
FREE_UPLOAD_SECONDS = 30 * 60

# How many recordings one account may have open at once. Not a quota — the quota
# is shared and already correct across tabs. This bounds the SLACK in it: a socket
# learns the shared total when a chunk of its own is billed, so it can be up to
# CHUNK_DURATION seconds behind, and the worst-case overshoot is CHUNK_DURATION x
# this number — under a minute at five. It also leaves room for a phone, a laptop,
# and a reconnect racing a socket that has not finished closing.
MAX_SOCKETS_PER_USER = 5

# Recording requires an account. An anonymous allowance cannot be a real limit:
# with nobody to recognise, every reconnection starts a fresh count, so it is
# friction rather than a ceiling. Requiring identity is what makes the 20 minutes
# mean 20 minutes.


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
    voice_id: int | None = None      # for "use_saved_voice": which saved Voice to load
    # What the page is calling this lecture. The row is opened before any of the
    # transcript exists, so the name has to arrive with the opening message —
    # renaming later is a separate edit.
    title:      str = Field(default="", max_length=200)
    # The browser cannot put a header on a WebSocket handshake, so the token
    # arrives in the opening message instead. Deliberately not the query string:
    # URLs end up in access logs, proxies and error reports.
    token: str = ""


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
#
# An async client, so the ~1.7s wait costs no thread. With a blocking client the
# call had to be pushed to the executor purely to keep it off the event loop,
# which meant one pool thread asleep per request in flight, and a dropped
# connection left that thread stuck until Modal answered or the timeout fired.
# An await can simply be cancelled.
_modal_async: "httpx.AsyncClient | None" = None


async def transcribe_with_timestamps(samples: np.ndarray) -> list[dict]:
    """
    Send audio to the Modal Whisper endpoint and return word-level timestamps.
    Returns list of {"word": str, "start": float, "end": float}.

    Why send the full chunk before any speaker filtering?
    Whisper needs full audio context to be accurate. We transcribe everything,
    then main.py filters by speaker timestamps using the local ECAPA-TDNN pipeline.

    Cold start: first request after idle spins up a T4 container. Measured at
    42.9s for a 10s chunk — container boot and image pull, not just model load.
    Warm requests: ~1-2s round-trip for the same chunk.
    """
    buf = io.BytesIO()
    sf.write(buf, samples, SAMPLE_RATE, format="WAV")     # ~1ms, fine on the loop
    wav_bytes = buf.getvalue()

    logger.debug(f"[whisper] calling Modal ({len(samples)/SAMPLE_RATE:.1f}s audio)")
    response = await _modal_async.post(
        MODAL_WHISPER_URL,
        content=wav_bytes,
        headers={"Content-Type": "audio/wav"},
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


# ======= TRANSCRIBE CHUNK (speaker filtering, Steps 2-7) =======
def _run_pipeline_sync(
    samples: np.ndarray,
    words: list[dict],
    lecture_prompt: str,
    selected_tags: list,
    custom_name: str,
    professor_embedding: np.ndarray | None,
    similarity_threshold: float,
    session_state: dict,
    chunk_offset: float,
) -> dict | None:
    """
    The model half of the pipeline: Steps 2-7, VAD through dedup.

    Whisper (Step 1) used to run in here too. It is a call to Modal, which means
    two of the two and a half seconds this took were spent waiting on a remote
    GPU — while holding the semaphore that exists to cap MEMORY. Every other
    chunk queued behind a thread that was using ~5MB and no CPU.

    Transcription now happens before this is called and outside the gate, so the
    limit guards only the part that actually allocates: VAD, segmentation and
    ECAPA.

    Runs in a thread pool via run_in_executor so the async event loop stays free
    to handle other users while models are running.
    Returns a JSON-ready dict to send, or None if nothing to send.
    """
    raw_transcript = ' '.join(w['word'] for w in words).strip()
    logger.debug(f"[raw whisper] {raw_transcript}")

    # Voice lock off — no speaker filtering, but the hallucination filter still
    # applies. It used to sit at Step 6, past this return, so an unlocked
    # recording — the common case — received "Thank you for watching" and the
    # rest of what Whisper emits over silence.
    #
    # The words are re-aligned as well as the text: the page renders the word
    # spans rather than the string, so trimming only the string would drop
    # nothing from what is actually displayed.
    if professor_embedding is None:
        transcript = filter_hallucinations(raw_transcript)
        if not transcript:
            logger.debug("[chunk] transcript empty after hallucination filter")
            return None
        final_words = words_for_transcript(transcript, words)
        # "Thank you for watching." filters down to "." — the phrase goes, its
        # punctuation stays. No words survive re-alignment in that case, so this
        # catches a chunk that was nothing but hallucination and would otherwise
        # reach the page as a block containing a full stop.
        if not final_words:
            logger.debug("[chunk] nothing but hallucination in this chunk")
            return None
        detected_tags = analyze_text(transcript, selected_tags, custom_name)
        word_list = [{"w": w["word"], "s": round(w["start"] + chunk_offset, 3), "e": round(w["end"] + chunk_offset, 3)} for w in final_words]
        return {"type": "transcription", "text": transcript, "tags": detected_tags, "words": word_list}

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
    session_id: int | None = None,
    chunk_idx: int = 0,
    user_id: int | None = None,
    usage_state: dict | None = None,
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

        # Step 1 — Whisper, on Modal. Network waiting, a few MB, no models: it is
        # deliberately OUTSIDE the semaphore so chunks can wait on the GPU
        # concurrently instead of single file. This was the whole bottleneck.
        samples = pcm_to_float(pcm_bytes)
        words = await transcribe_with_timestamps(samples)      # awaited, no thread

        # Billed here, and only here: Modal answered, so the thing the account
        # pays for was delivered. A call that times out or errors raises above
        # this line and costs nothing, which is the whole point — audio arriving
        # is not a transcript, and the meter used to run on the audio.
        #
        # An empty answer still counts. Silence, or speech the speaker filter
        # removes, is Modal having run and replied; what it said is the measure,
        # not what survived the pipeline afterwards.
        if usage_state is not None and user_id is not None:
            fresh = _add_live_seconds(user_id, CHUNK_DURATION)
            usage_state["this_ws"] += CHUNK_DURATION
            usage_state["total"] = (float(fresh) if fresh is not None
                                    else usage_state["total"] + CHUNK_DURATION)
            try:
                await websocket.send_json({
                    "type": "usage", "live_seconds": usage_state["total"]})
            except Exception:
                pass          # the page is gone; the account is still correct

        if not words:
            logger.debug("[chunk] no words from Whisper")
            return

        # Steps 2-7 — the models, and the only part that allocates (~159MB). The
        # gate belongs here.
        async with _pipeline_semaphore:
            result = await loop.run_in_executor(
                None,
                partial(
                    _run_pipeline_sync,
                    samples,
                    words,
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
                # Written down before it is sent, because the reason this row
                # exists is the browser not being there to receive it. A send that
                # fails must not be what decides whether the lecture was kept.
                if session_id is not None:
                    try:
                        with SessionLocal() as db:
                            repo.add_chunk(
                                db, session_id=session_id, idx=chunk_idx,
                                text=result.get("text", ""),
                                words=result.get("words"),
                            )
                    except Exception as e:
                        # Losing a chunk must not take the recording down with it,
                        # the same rule the usage write follows.
                        logger.error(f"[ws] could not store chunk {chunk_idx} "
                                     f"of session {session_id}: {e}")
                try:
                    await websocket.send_json(result)
                except Exception:
                    pass  # client disconnected while chunk was processing

    except Exception as e:
        logger.exception(f"transcribe_chunk error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": "Transcription failed. Please try again."
            })
        except Exception:
            pass  # client already disconnected


# ======= ROUTES =======
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    return templates.TemplateResponse("upload.html", {"request": request})

@app.get("/lectures", response_class=HTMLResponse)
async def lectures_page(request: Request):
    return templates.TemplateResponse("lectures.html", {"request": request})

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


# ======= VOICES (professor voice profiles = the Voice table) =======

def _embedding_bytes_from_audio(raw: bytes, filename: str) -> tuple[bytes, float] | None:
    """
    Decode an uploaded audio file into the professor voice EMBEDDING.

    Glue only: librosa decodes ANY format -> 16kHz mono float; we convert to the
    int16-PCM bytes the existing enrollment code expects, then reuse
    compute_professor_embedding (VAD + ECAPA). Returns (embedding_bytes, threshold)
    or None if no usable speech was found.
    """
    import tempfile
    import librosa

    suffix = Path(filename).suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(raw)
        tmp.flush()
        samples, _ = librosa.load(tmp.name, sr=SAMPLE_RATE, mono=True)   # -> float32 @16kHz

    pcm_bytes = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    emb, threshold = compute_professor_embedding(pcm_bytes)              # reuse existing ML
    if emb is None:
        return None
    return emb.astype("float32").tobytes(), threshold


def _unique_voice_name(db: Session, base: str, user_id: str | None) -> str:
    """Auto-suffix name collisions: pol_science, pol_science_2, pol_science_3, ..."""
    existing = {c.name for c in repo.list_voices(db, user_id=user_id)}
    if base not in existing:
        return base
    n = 2
    while f"{base}_{n}" in existing:
        n += 1
    return f"{base}_{n}"


VOICE_AUDIO_DIR = BASE_DIR / "data" / "voice_audio"


@app.post("/voices")
async def create_voice_route(
    name: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user = Depends(current_user),          # a voice is stored server-side, so it needs an owner
):
    """Enroll a professor from an audio file → compute + save the embedding as a Voice.
    The uploaded clip is also stored on disk so it can be played back later."""
    raw = await file.read()
    result = _embedding_bytes_from_audio(raw, file.filename or "voice.wav")
    if result is None:
        raise HTTPException(status_code=422, detail="No usable speech found in the audio.")
    embedding_bytes, threshold = result
    unique_name = _unique_voice_name(db, name, user_id=user.id)
    voice = repo.create_voice(db, name=unique_name, embedding=embedding_bytes,
                              threshold=threshold, user_id=user.id)

    # store the clip for playback: data/voice_audio/<id>.<ext>
    VOICE_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or "voice.wav").suffix or ".wav"
    audio_path = VOICE_AUDIO_DIR / f"{voice.id}{ext}"
    audio_path.write_bytes(raw)
    voice.audio_path = str(audio_path)
    db.commit()

    return {"id": voice.id, "name": voice.name, "use_count": voice.use_count, "has_audio": True}


@app.get("/voices")
def list_voices_route(db: Session = Depends(get_db),
                      user = Depends(current_user_optional)):
    """The Voice picker: top-4 most-used, non-hidden voices."""
    # Signed out: no voices to show. Not an error — a visitor can still record,
    # they just have nothing saved and nothing of anyone else's is offered.
    if user is None:
        return []
    return [
        {"id": v.id, "name": v.name, "use_count": v.use_count, "has_audio": bool(v.audio_path)}
        for v in repo.top_voices(db, user_id=user.id, limit=4)
    ]


@app.get("/voices/{voice_id}/audio")
def voice_audio_route(voice_id: int, db: Session = Depends(get_db),
                      user = Depends(current_user)):
    """Serve a Voice's stored enrollment clip (for click-to-play)."""
    voice = _own_voice_or_404(db, voice_id, user)
    if not voice.audio_path or not Path(voice.audio_path).exists():
        raise HTTPException(status_code=404, detail="No audio for this voice")
    return FileResponse(voice.audio_path)


class VoiceRename(BaseModel):
    name: str = Field(min_length=1, max_length=60)


def _own_voice_or_404(db: Session, voice_id: int, user):
    """The voice, if it is this user's. 404 otherwise — not 403, which would
    confirm the row exists to someone who has no business knowing."""
    voice = repo.get_voice(db, voice_id)
    if voice is None or voice.user_id != user.id:
        raise HTTPException(status_code=404, detail="Voice not found")
    return voice


@app.patch("/voices/{voice_id}")
def rename_voice_route(voice_id: int, payload: VoiceRename, db: Session = Depends(get_db),
                       user = Depends(current_user)):
    """Rename a Voice (double-click-to-edit)."""
    _own_voice_or_404(db, voice_id, user)
    voice = repo.rename_voice(db, voice_id, payload.name.strip())
    if voice is None:
        raise HTTPException(status_code=404, detail="Voice not found")
    return {"id": voice.id, "name": voice.name}


@app.delete("/voices/{voice_id}")
def hide_voice_route(voice_id: int, db: Session = Depends(get_db),
                     user = Depends(current_user)):
    """The 🗑️ in the picker: hide (or delete if it has no lectures)."""
    _own_voice_or_404(db, voice_id, user)
    repo.hide_voice(db, voice_id)
    return {"ok": True}


# ======= SESSIONS (saved lecture transcripts) =======

class FlagIn(BaseModel):
    """One flagged moment, as collected in the page during the lecture.

    Flags are raised live, before a Session row exists, so they ride along with
    the transcript on save rather than being written one at a time.
    """
    t_start:  float
    t_end:    float
    quote:    str
    question: str | None = None
    answer:   str | None = None


class SessionIn(BaseModel):
    """Request BODY for saving a transcript (long text/lists don't fit in a URL)."""
    title:      str
    transcript: str
    voice_id:   int | None = None      # which Voice was used (None = unlocked recording)
    words:      list | None = None
    audio_path: str | None = None
    flags:      list[FlagIn] | None = None


@app.post("/sessions")
def create_session_route(payload: SessionIn, db: Session = Depends(get_db),
                         user = Depends(current_user)):   # saving is what requires signing in
    """Save a finished transcript. Called by both live + upload when user hits 'save'."""
    s = repo.save_session(
        db, voice_id=payload.voice_id, user_id=user.id, title=payload.title,
        transcript=payload.transcript, words=payload.words, audio_path=payload.audio_path,
        flags=[f.model_dump() for f in payload.flags] if payload.flags else None,
    )
    return {"id": s.id, "title": s.title, "voice_id": s.voice_id, "flags": len(s.flags)}


@app.get("/sessions")
def list_sessions_route(db: Session = Depends(get_db),
                        user = Depends(current_user_optional)):
    """List saved lectures (lightweight — a short preview, not the full transcript)."""
    if user is None:
        return []           # signed out: nothing of your own, and nothing of anyone else's
    return [
        {"id": s.id, "title": s.title, "voice_id": s.voice_id,
         "preview": (s.transcript or "")[:200], "created_at": str(s.created_at)}
        for s in repo.list_sessions(db, user_id=user.id)
    ]


@app.get("/sessions/{session_id}")
def get_session_route(session_id: int, db: Session = Depends(get_db),
                      user = Depends(current_user)):
    """One full lecture (whole transcript + word timestamps)."""
    s = repo.get_session(db, session_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")

    # Normally the lecture is right here in the row. It is not only while the
    # recording is still running, or if the server died before it could fold the
    # chunks in — and those are exactly the lectures worth not losing, so they
    # are assembled on the way out instead.
    transcript, words = s.transcript, json.loads(s.words_json) if s.words_json else []
    if not transcript:
        transcript, words = repo.assemble_chunks(db, session_id)

    return {
        "id": s.id, "title": s.title, "voice_id": s.voice_id,
        "transcript": transcript, "summary": s.summary,
        "words": words,
        "flags": [
            {"id": f.id, "t_start": f.t_start, "t_end": f.t_end, "quote": f.quote,
             "question": f.question, "answer": f.answer, "resolved": f.resolved}
            for f in s.flags
        ],
        "created_at": str(s.created_at),
    }


@app.get("/me")
def me_route(user = Depends(current_user)):
    """Plan and usage, as the account has them.

    The page kept its own copy in localStorage, which meant the panel showed a
    number that had nothing to do with what the account had been charged — and
    clearing it looked like free minutes. Read once on load and again when the
    panel is opened; while a recording runs the socket sends the total as it
    changes, so there is nothing here to poll.
    """
    return {
        "plan": user.plan,
        "live_seconds": int(user.live_seconds),
        "upload_seconds": int(user.upload_seconds),
        "live_allowance": FREE_LIVE_SECONDS,
        "upload_allowance": FREE_UPLOAD_SECONDS,
    }


class SessionPatch(BaseModel):
    """What can be changed about a lecture after it exists. Only the name: the
    transcript is written by the recording that produced it, not by the page."""
    title:    str | None = None
    voice_id: int | None = None


@app.patch("/sessions/{session_id}")
def rename_session_route(session_id: int, payload: SessionPatch,
                         db: Session = Depends(get_db),
                         user = Depends(current_user)):
    """Name a lecture. The row already exists — it was opened when recording
    started and filled as the lecture went — so saving is a rename, and pressing
    it twice changes the same row twice instead of leaving two lectures."""
    s = repo.get_session(db, session_id)
    # Same check as the other by-id routes: a lecture that is not yours is not
    # found, so guessing a number edits nothing.
    if s is None or s.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.title is not None:
        s.title = payload.title.strip() or s.title
    if payload.voice_id is not None:
        s.voice_id = payload.voice_id
    db.commit(); db.refresh(s)
    return {"id": s.id, "title": s.title, "voice_id": s.voice_id}


class AskIn(BaseModel):
    """A doubt raised against a span of the transcript."""
    quote:    str                       # the selected words, verbatim
    question: str | None = None         # what the student typed; blank = "explain this"
    context:  str | None = None         # surrounding transcript, for the model to read
    t_start:  float | None = None
    t_end:    float | None = None


@app.post("/ask")
def ask_route(payload: AskIn):
    """Answer a doubt about a selected span of the lecture.

    Stubbed: returns a fixed placeholder so the panel can be built and used
    end-to-end. Swapping in a real model means replacing the body of this
    function only — the request and response shapes are already the ones a
    model call needs (quote + surrounding context + question).
    """
    asked = (payload.question or "").strip() or "Explain this"
    logger.info(f"[ask] {asked!r} on {payload.quote[:60]!r} @ {payload.t_start}")
    return {
        "answer": (
            f"(placeholder) You asked “{asked}” about “{payload.quote}”. "
            "Answers aren't wired to a model yet — this flag is saved with the "
            "lecture, so you can come back to it after class."
        ),
        "stub": True,
    }


@app.delete("/sessions/{session_id}")
def delete_session_route(session_id: int, db: Session = Depends(get_db),
                         user = Depends(current_user)):
    """Delete a lecture (its audio file + any orphaned hidden Voice are cleaned up)."""
    s = repo.get_session(db, session_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    repo.delete_session(db, session_id)
    return {"ok": True}


# ======= FILE UPLOAD (Modal Whisper — same large-v3 model as live pipeline) =======
@app.post("/transcribe")
async def transcribe_audio(
    file: UploadFile,
    validated_data: Tuple[bytes, str, float, str] = Depends(validate_audio_file),
    user = Depends(current_user),          # an allowance needs somebody to spend it
):
    """Transcribe an uploaded file, against the account's upload allowance.

    Metered on the same rule as a live chunk: the account is charged when Modal
    answers, not when text comes back, and not for bytes that were merely
    uploaded. A call that fails costs nothing.

    The ceiling is checked BEFORE the call, unlike the live path where the check
    can wait for the next chunk — one upload is one GPU call of unbounded length,
    so letting it through and billing afterwards would hand out the whole
    allowance again on every attempt.
    """
    contents, mime, file_size_mb, correct_ext = validated_data

    used = int(user.upload_seconds)
    if used >= FREE_UPLOAD_SECONDS:
        raise HTTPException(
            status_code=403,
            detail="You have used your free upload minutes.")

    try:
        response = await _modal_async.post(
            MODAL_WHISPER_URL,
            content=contents,
            headers={"Content-Type": mime},
            timeout=120,
        )
        response.raise_for_status()
        words = response.json()
    except Exception as e:
        # Nothing is charged: Modal did not answer, so nothing was delivered.
        raise HTTPException(status_code=500, detail=f"Transcription Failed: {str(e)}")

    # Modal answered. Billed for the audio it worked through, which the last word
    # marks the end of — an answer with no words at all is silence, and bills
    # nothing because there is no span to bill for.
    seconds = float(words[-1]["end"]) if words else 0.0
    fresh = _add_upload_seconds(user.id, seconds)
    logger.info(f"[upload] user {user.id} billed {seconds:.0f}s, "
                f"account now {fresh}/{FREE_UPLOAD_SECONDS}s")

    transcript = " ".join(w["word"] for w in words).strip()
    return {
        "filename": file.filename,
        "transcription": transcript,
        "file_size_mb": round(file_size_mb, 2),
        "upload_seconds": fresh,
    }


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
# Open recordings per user, for MAX_SOCKETS_PER_USER.
#
# ONE PROCESS ONLY. This dict belongs to this worker, so with `--workers 4` each
# worker counts only its own sockets and the real cap becomes 5 x 4 = 20, with
# nothing raising an error to tell you. Moving to several workers means moving
# this to shared storage — a table keyed (user_id, slot) with a unique
# constraint and a staleness timeout, or Redis. See SCALING.md, Level 2.
_open_sockets: dict[int, int] = {}


def _claim_socket(user_id: int) -> bool:
    """Take a slot for this user, or return False if they are at the limit."""
    if _open_sockets.get(user_id, 0) >= MAX_SOCKETS_PER_USER:
        return False
    _open_sockets[user_id] = _open_sockets.get(user_id, 0) + 1
    return True


def _release_socket(user_id: int | None) -> None:
    """Give the slot back. Called from a finally block, because sockets mostly
    end by being dropped rather than closed politely — and a slot that is never
    released locks the user out of their own account."""
    if user_id is None:
        return
    n = _open_sockets.get(user_id, 0) - 1
    if n > 0:
        _open_sockets[user_id] = n
    else:
        _open_sockets.pop(user_id, None)


def _add_live_seconds(user_id: int | None, delta: float) -> int | None:
    """Add this connection's new seconds to the account and return the fresh total.

    Adds rather than assigns, and does it in one UPDATE so the database performs
    the arithmetic. A device recording on a phone and a laptop at once would
    otherwise each read the same starting number, count separately, and write
    their own total — the last one winning and the rest of the usage vanishing.
    Reading the total back is also how each connection learns about the others:
    the ceiling is shared, so it has to be re-checked rather than assumed from
    whatever was true at connect.
    """
    if user_id is None or delta <= 0:
        return None
    try:
        with SessionLocal() as db:
            db.execute(
                update(User)
                .where(User.id == user_id)
                .values(live_seconds=User.live_seconds + int(delta))
            )
            db.commit()
            u = db.get(User, user_id)
            return int(u.live_seconds) if u else None
    except Exception as e:
        # Losing a usage write must not take the recording down with it.
        logger.error(f"[ws] could not persist usage for user {user_id}: {e}")
        return None


def _add_upload_seconds(user_id: int | None, delta: float) -> int | None:
    """The upload counterpart of _add_live_seconds, and additive for the same
    reason: two files transcribing at once must both land."""
    if user_id is None or delta <= 0:
        return None
    try:
        with SessionLocal() as db:
            db.execute(
                update(User)
                .where(User.id == user_id)
                .values(upload_seconds=User.upload_seconds + int(delta))
            )
            db.commit()
            u = db.get(User, user_id)
            return int(u.upload_seconds) if u else None
    except Exception as e:
        logger.error(f"[upload] could not persist usage for user {user_id}: {e}")
        return None


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

    # Who is on this socket, and what they are allowed to use. Both are settled
    # by the opening message; until then the connection is anonymous and its
    # smaller ceiling applies.
    ws_user_id: int | None = None
    # The row this recording is filling. Opened with the first context message,
    # collapsed into a finished lecture when the connection ends.
    ws_session_id: int | None = None
    seconds_allowed  = FREE_LIVE_SECONDS
    # What the account has been billed, shared with the chunk tasks that do the
    # billing — mutable for the same reason session_state is: transcribe_chunk
    # runs as its own task and has to be able to report back.
    usage_state = {"total": 0.0, "this_ws": 0.0}
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
                        # Once only. This branch does everything that admits a
                        # recording — verifies the token, charges a socket against
                        # the per-user cap, and opens the lecture's row — none of
                        # which is safe to repeat. A second one would hold two of
                        # the five slots, and point the rest of the lecture at a
                        # new row while leaving the first holding chunks that
                        # nothing will ever collapse. Changing the alerts
                        # mid-lecture is what the `alerts` message is for.
                        if ws_session_id is not None:
                            logger.info("[ws] ignoring a repeated context message")
                            continue

                        lecture_prompt = msg.prompt
                        selected_tags  = msg.tagConfig.tags
                        custom_name    = msg.tagConfig.name

                        # Every second accepted here costs a GPU call, so the
                        # allowance is decided from a verified identity rather
                        # than from anything the page claims about itself.
                        # Both refusals happen before a single byte of audio is
                        # read, so a connection that is not allowed to record
                        # costs nothing.
                        try:
                            clerk_id = clerk_user_id_from_token(msg.token)
                        except AuthError as e:
                            logger.info(f"[ws] refused: {e}")
                            await websocket.send_json({
                                "type": "error", "message": "Sign in to record."})
                            await websocket.close()
                            break

                        with SessionLocal() as db:
                            u = get_or_create_user(db, clerk_id)
                            ws_user_id    = u.id
                            usage_state["total"] = float(u.live_seconds)
                        logger.info(f"[ws] {clerk_id} -> user {ws_user_id}, "
                                    f"{usage_state['total']:.0f}/{seconds_allowed}s used")

                        if usage_state["total"] >= seconds_allowed:
                            await websocket.send_json({
                                "type": "error",
                                # named, so the page can answer a spent allowance with
                                # something other than a line of red text — matching on
                                # the sentence would break the moment anyone reworded it
                                "code": "live_limit",
                                "message": "You have used your free recording minutes."})
                            await websocket.close()
                            break

                        if not _claim_socket(ws_user_id):
                            logger.info(f"[ws] user {ws_user_id} already has "
                                        f"{MAX_SOCKETS_PER_USER} recordings open")
                            await websocket.send_json({
                                "type": "error",
                                "message": "Too many recordings open. Close one and try again."})
                            await websocket.close()
                            ws_user_id = None      # nothing claimed, nothing to release
                            break

                        # The lecture gets its row now, so the chunks arriving over
                        # the next hour have something to belong to. Opened only
                        # once every refusal above has passed, so a connection that
                        # is not allowed to record leaves nothing behind.
                        with SessionLocal() as db:
                            ws_session_id = repo.start_session(
                                db, user_id=ws_user_id, voice_id=None,
                                title=msg.title or "Untitled",
                            ).id
                        # The page is told which row it is filling, so Save can
                        # name that lecture rather than create another one.
                        await websocket.send_json({
                            "type": "session", "id": ws_session_id})

                    elif msg.type == "alerts":
                        # The menu stays open during a lecture, so what it says has
                        # to be what is tagged against. Chunks already in flight
                        # keep the old set, which is the set they were transcribed
                        # under; everything after this uses the new one.
                        selected_tags = msg.tagConfig.tags
                        custom_name   = msg.tagConfig.name
                        logger.info(f"[ws] alerts now {selected_tags}"
                                    + (f" name={custom_name!r}" if custom_name else ""))

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

                    elif msg.type == "use_saved_voice":
                        # Load a previously-saved Voice's embedding from the DB and
                        # lock onto it — same effect as enroll_end, no live audio needed.
                        with SessionLocal() as db:
                            voice = repo.get_voice(db, msg.voice_id) if msg.voice_id else None
                            # Someone else's voice is not yours to lock onto — the
                            # id is just a number in a message, and guessing it
                            # would otherwise work.
                            if voice is not None and voice.user_id != ws_user_id:
                                logger.info(f"[ws] user {ws_user_id} asked for voice "
                                            f"{msg.voice_id}, which is not theirs")
                                voice = None
                        if voice is not None and voice.embedding:
                            professor_embedding  = np.frombuffer(voice.embedding, dtype="float32")
                            similarity_threshold = voice.threshold
                            voice_lock_active    = True
                            session_state = {
                                'last_transcript': '',
                                'vad_h': np.zeros((2, 1, 64), dtype=np.float32),
                                'vad_c': np.zeros((2, 1, 64), dtype=np.float32),
                            }
                            # The row was opened before a voice was chosen, so the
                            # link is made here — it is what collapse_session
                            # counts as a use of this Voice.
                            if ws_session_id is not None:
                                with SessionLocal() as db:
                                    row = repo.get_session(db, ws_session_id)
                                    if row is not None:
                                        row.voice_id = msg.voice_id
                                        db.commit()
                            await websocket.send_json({"type": "enroll_success"})
                            logger.info(f"Saved voice locked (id={msg.voice_id}, "
                                        f"threshold={similarity_threshold:.3f})")
                        else:
                            await websocket.send_json({
                                "type": "enroll_failed",
                                "message": "Saved voice not found"
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
                    continue #continue COMPUTING Embeddign, and once enrolling is false, go to below section of code
                # Safety guard to check the size of the chunk
                if len(audio_buffer) > CHUNK_BYTES * 4:
                    await websocket.send_json({"type": "error", "message": "Audio limit exceeded"})
                    await websocket.close()
                    break

                # Nothing is metered here any more. Audio arriving is not a
                # transcript delivered: a chunk that Modal never answers costs the
                # account nothing, which it used to be charged for. The meter runs
                # in transcribe_chunk, the moment Modal does answer.

                # The ceiling is judged on what has actually been billed, which
                # usage_state carries back from those chunks.
                if usage_state["total"] >= seconds_allowed:
                    logger.info(f"[ws] user {ws_user_id} hit the limit at "
                                f"{usage_state['total']:.0f}s")
                    await websocket.send_json({
                        "type": "error",
                        "code": "live_limit",
                        "message": "You have used your free recording minutes."})
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
                        ws_session_id,
                        chunk_count - 1,     # the index this chunk was given above
                        ws_user_id,
                        usage_state,
                    ))

    except WebSocketDisconnect:
        print("Client disconnected from WebSocket")
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        # Nothing is owed at the end any more. Each chunk was billed the moment
        # Modal answered for it, so a connection that dies without warning leaves
        # no unwritten remainder to lose — the last chunk it was charged for is
        # already in the account.
        if ws_user_id is not None:
            logger.info(f"[ws] user {ws_user_id} was billed {usage_state['this_ws']:.0f}s here, "
                        f"account now {usage_state['total']:.0f}/{seconds_allowed}s")

        # The recording is over, whatever ended it — stopped, closed, crashed,
        # dropped. The chunks written along the way become the lecture here, and
        # a recording that produced nothing takes its empty row with it.
        if ws_session_id is not None:
            try:
                with SessionLocal() as db:
                    repo.collapse_session(db, ws_session_id)
            except Exception as e:
                # The chunks survive a failure here, and the read path assembles
                # from them, so the lecture is still readable.
                logger.error(f"[ws] could not collapse session {ws_session_id}: {e}")

        _release_socket(ws_user_id)


@app.on_event("shutdown")
async def shutdown_event():
    """Release the Modal connections. Without this the pool is torn down by
    garbage collection, which logs noisily and can leave sockets in TIME_WAIT."""
    global _modal_async
    if _modal_async is not None:
        await _modal_async.aclose()
        _modal_async = None


# ======= STARTUP =======
@app.on_event("startup")
async def startup_event():
    global _mem_baseline_mb, _mem_after_models_mb
    global _vad_session, _seg_session, _ecapa_model, _modal_async

    tracemalloc.start()
    _mem_baseline_mb = _process.memory_info().rss / 1024 / 1024
    logger.info(f"Startup baseline memory: {_mem_baseline_mb:.1f} MB")

    # Stated every boot, because the assumption is invisible in the code that
    # depends on it and the flag that breaks it is typed somewhere else entirely.
    logger.info(f"Socket cap is {MAX_SOCKETS_PER_USER} per user, counted PER PROCESS. "
                f"Running --workers N multiplies it by N — see SCALING.md, Level 2.")

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

    # Whisper runs on Modal. One client for the process, reusing connections;
    # the timeout is generous because a cold container takes a few seconds.
    _modal_async = httpx.AsyncClient(timeout=httpx.Timeout(90.0))
    if MODAL_WHISPER_URL:
        logger.info(f"Modal Whisper endpoint configured: {MODAL_WHISPER_URL}")
    else:
        logger.warning("MODAL_WHISPER_URL not set — transcription will fail")

    _mem_after_models_mb = _process.memory_info().rss / 1024 / 1024
    logger.info(f"Memory after all models loaded: {_mem_after_models_mb:.1f} MB")
