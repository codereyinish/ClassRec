"""
ClassRec — Modal Serverless Whisper Endpoint
=============================================
Deploys faster-whisper large-v3 + stable-ts on a T4 GPU.

The model is baked into the container image (run_function at build time),
so cold start is ~3-5s container spin-up, not 30s+ model download.

Deploy:
    modal deploy modal_whisper.py

After deploy, Modal prints the web endpoint URL. Add it to .env:
    MODAL_WHISPER_URL=https://...

Call:
    POST <URL>
    Content-Type: audio/wav
    Body: raw WAV bytes

Response:
    JSON array: [{"word": str, "start": float, "end": float}, ...]
"""

import modal
from starlette.requests import Request

MODEL_DIR = "/models/whisper"
MODEL_NAME = "large-v3"

# ======= IMAGE =======
# Bake the model into the image layer so it's cached across cold starts.
# run_function() executes _download_model() once during image build, not at runtime.
def _download_model():
    from faster_whisper import WhisperModel
    WhisperModel(MODEL_NAME, device="cuda", compute_type="float16", download_root=MODEL_DIR)


image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("ffmpeg")
    .pip_install(
        "faster-whisper==1.1.1",
        "stable-ts==2.19.1",
        "soundfile",
        "numpy",
        "fastapi[standard]",
    )
    .run_function(_download_model, gpu="T4")
)

app = modal.App("classrec-whisper", image=image)

# ======= TRANSCRIBE FUNCTION =======
# Module-level variable — loaded once per container, reused across warm requests.
# First request on a cold container triggers the load (~5s). Warm requests skip it.
_model = None

@app.function(
    gpu="T4",
    scaledown_window=300,  # keep warm 5 min after last request
    timeout=60,
)
@modal.fastapi_endpoint(method="POST")
async def transcribe(request: Request):
    """
    Receive raw WAV bytes, return word-level timestamps as JSON.

    Input:  POST body = raw WAV bytes
    Output: [{"word": str, "start": float, "end": float}, ...]

    Why transcribe the full chunk before any filtering?
    Whisper needs full audio context for accurate transcription.
    Filtering by speaker happens in main.py after this returns.
    """
    import tempfile
    import os
    import stable_whisper

    global _model
    if _model is None:
        _model = stable_whisper.load_faster_whisper(
            MODEL_NAME,
            device="cuda",
            compute_type="float16",
            download_root=MODEL_DIR,
        )

    audio_bytes = await request.body()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        result = _model.transcribe(
            tmp_path,
            language="en",
            word_timestamps=True,
            regroup=False,
        )
    finally:
        os.unlink(tmp_path)

    words = []
    for segment in result.segments:
        for w in segment.words:
            words.append({
                "word": w.word.strip(),
                "start": float(w.start),
                "end": float(w.end),
            })

    return words
