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
# The load is part of a cold start, which measured 42.9s end to end against 1.0s
# warm. Most of that is booting the container and pulling a multi-GB CUDA image,
# not the model itself.
_model = None

@app.function(
    gpu="T4",
    scaledown_window=300,  # keep warm 5 min after last request
    timeout=60,
    # A cold container takes ~43s to answer, so one started to relieve a burst
    # arrives long after the warm container has cleared it — then bills for the
    # 300s scaledown window having done nothing. Requests past this ceiling queue
    # instead, at 1.0s per place in line. Two lets a genuinely sustained queue
    # (still there 43s later) buy a second container, which is the only case
    # where the cold start earns its cost.
    max_containers=2,
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
