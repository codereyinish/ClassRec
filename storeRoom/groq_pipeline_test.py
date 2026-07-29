"""
ClassRec pipeline test — Groq Whisper + Silero VAD + Segmentation + ECAPA-TDNN.

Same pipeline as main.py but runs standalone locally against an audio file or live mic.
Produces HTML output with per-chunk raw vs filtered comparison + reference.txt diff.

Usage:
    Live mic:   python groq_pipeline_test.py
    Audio file: python groq_pipeline_test.py path/to/audio.wav

Requires GROQ_API_KEY in environment or .env file.
"""
import numpy as np
import onnxruntime as ort
import sounddevice as sd
import soundfile as sf
import librosa, tempfile, os, sys, threading, difflib, html as htmllib
from dotenv import load_dotenv
from groq import Groq
import torch
import whisperx

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', 'ClassRec', '.env'))

MODELS_DIR      = '/Users/inishbista/aicode/ClassRec/models'
ECAPA_DIR       = '/Users/inishbista/aicode/ClassRec/models/ecapa_tdnn'
TRANSCRIPT_FILE = os.path.join(os.path.dirname(__file__), 'groq_pipeline_output.html')
REFERENCE_FILE  = os.path.join(os.path.dirname(__file__), 'reference.txt')
LOG_FILE        = os.path.join(os.path.dirname(__file__), 'groq_pipeline_output.log')

WHISPER_MODEL   = 'whisper-large-v3-turbo'
SAMPLE_RATE     = 16000
CHUNK_SEC       = 10
RECORD_SEC      = 12.0
ENROLL_SEC      = 15

# VAD
VAD_WINDOW_SIZE = 512
VAD_THRESHOLD   = 0.2
VAD_PAD_SEC     = 0.2

# Segmentation
SEG_THRESHOLD   = 0.3
MIN_REGION_SEC  = 1.5

# Embedding
MIN_SEGMENT_SEC = 0.5

# Similarity
SIMILARITY_THRESHOLD = 0.20

log_lines        = []
transcript_chunks = []


def log(msg):
    print(msg)
    log_lines.append(msg)

def save_log():
    with open(LOG_FILE, 'w') as f:
        f.write('\n'.join(log_lines))


# ── HTML output ───────────────────────────────────────────────────────────────

STATUS_COLOR = {
    'ok':           '#4ec94e',
    'no_professor': '#f44747',
    'no_vad':       '#ce9178',
    'no_words':     '#888888',
    'no_stitch':    '#f44747',
}
STATUS_LABEL = {
    'ok':           '✓ professor detected',
    'no_professor': '✗ no professor detected',
    'no_vad':       '✗ no speech (VAD)',
    'no_words':     '✗ no words (Whisper)',
    'no_stitch':    '✗ no words after stitch',
}

CSS = """
body  { font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 24px; line-height: 1.8; }
h1    { color: #569cd6; }
h2    { color: #9cdcfe; margin-top: 40px; }
.chunk { border-left: 3px solid #444; padding-left: 16px; margin-bottom: 28px; }
.label { color: #9cdcfe; }
.timing { color: #888; font-size: 0.85em; margin-left: 12px; }
.dropped  { color: #4ec94e; text-decoration: line-through; }
.matched  { color: #d4d4d4; }
.pip-extra { color: #ce9178; }
.ref-miss  { color: #f44747; text-decoration: underline; }
hr { border-color: #333; }
table { border-collapse: collapse; margin: 8px 0; }
td, th { padding: 3px 14px; border: 1px solid #444; font-size: 0.9em; }
th { color: #9cdcfe; }
"""


def _word_diff_html(a_words, b_words, a_extra_cls, b_extra_cls, equal_cls='matched'):
    sm = difflib.SequenceMatcher(None, a_words, b_words, autojunk=False)
    a_parts, b_parts = [], []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for w in a_words[i1:i2]:
                a_parts.append(f'<span class="{equal_cls}">{htmllib.escape(w)} </span>')
            for w in b_words[j1:j2]:
                b_parts.append(f'<span class="{equal_cls}">{htmllib.escape(w)} </span>')
        elif tag == 'delete':
            for w in a_words[i1:i2]:
                a_parts.append(f'<span class="{a_extra_cls}">{htmllib.escape(w)} </span>')
        elif tag == 'insert':
            for w in b_words[j1:j2]:
                b_parts.append(f'<span class="{b_extra_cls}">{htmllib.escape(w)} </span>')
        elif tag == 'replace':
            for w in a_words[i1:i2]:
                a_parts.append(f'<span class="{a_extra_cls}">{htmllib.escape(w)} </span>')
            for w in b_words[j1:j2]:
                b_parts.append(f'<span class="{b_extra_cls}">{htmllib.escape(w)} </span>')
    return ''.join(a_parts), ''.join(b_parts)


def save_transcript():
    chunks_html = []
    for c in transcript_chunks:
        idx          = c['idx']
        raw_words    = c['raw_words']
        kept_words   = c['kept_words']
        transcript   = c['transcript']
        stitch_kept  = c['stitch_kept']
        stitch_total = c['stitch_total']
        status       = c['status']
        timings      = c['timings']

        status_col   = STATUS_COLOR.get(status, '#888')
        status_label = STATUS_LABEL.get(status, status)

        timing_html = ''

        if kept_words:
            sm = difflib.SequenceMatcher(None, raw_words, kept_words, autojunk=False)
            raw_parts = []
            for tag, i1, i2, j1, j2 in sm.get_opcodes():
                if tag == 'equal':
                    for w in raw_words[i1:i2]:
                        raw_parts.append(f'<span class="matched">{htmllib.escape(w)} </span>')
                elif tag in ('delete', 'replace'):
                    for w in raw_words[i1:i2]:
                        raw_parts.append(f'<span class="dropped">{htmllib.escape(w)} </span>')
                    if tag == 'replace':
                        for w in kept_words[j1:j2]:
                            raw_parts.append(f'<span class="matched">{htmllib.escape(w)} </span>')
            raw_html = ''.join(raw_parts)
        else:
            raw_html = ''.join(
                f'<span class="dropped">{htmllib.escape(w)} </span>' for w in raw_words
            )

        filtered_line = (
            f'&ldquo;{htmllib.escape(transcript)}&rdquo;'
            if transcript else
            f'<span style="color:{status_col}">{status_label}</span>'
        )

        chunks_html.append(
            f'<div class="chunk">'
            f'<h2>Chunk {idx} <span style="color:{status_col};font-size:0.75em">{status_label}</span></h2>'
            + timing_html +
            f'<p><span class="label">[raw whisper]</span> &ldquo;{raw_html}&rdquo;</p>'
            f'<p><span class="label">[stitch]</span> {stitch_kept}/{stitch_total} words kept</p>'
            f'<p><span class="label">[filtered]</span> {filtered_line}</p>'
            f'</div>'
        )

    full_whisper = ' '.join(' '.join(c['raw_words']) for c in transcript_chunks).strip()

    ref_section = ''
    if os.path.exists(REFERENCE_FILE):
        with open(REFERENCE_FILE) as f:
            reference = f.read().strip()
        whisper_words = full_whisper.split()
        ref_words     = reference.split()
        whisper_html, ref_html = _word_diff_html(
            whisper_words, ref_words, a_extra_cls='pip-extra', b_extra_cls='ref-miss'
        )
        ref_section = (
            f'<h2>Full Comparison — Whisper vs Reference</h2>'
            f'<p><span class="label">[whisper]</span> {whisper_html}</p>'
            f'<p><span class="label">[reference]</span> {ref_html}</p>'
            f'<p style="color:#888;font-size:0.9em">'
            f'<span style="color:#ce9178">■</span> whisper has, reference doesn\'t &nbsp;'
            f'<span style="color:#f44747">■</span> reference has, whisper missed &nbsp;'
            f'<span class="dropped">■ strikethrough</span> filtered out by speaker filter'
            f'</p>'
        )
    else:
        ref_section = f'<h2>Full Whisper Output</h2><p>{htmllib.escape(full_whisper)}</p>'

    html_doc = (
        f'<!DOCTYPE html><html><head><meta charset="utf-8">'
        f'<title>Groq Pipeline Output</title>'
        f'<style>{CSS}</style></head><body>'
        f'<h1>ClassRec Pipeline — Groq {WHISPER_MODEL}</h1>'
        + ''.join(chunks_html)
        + '<hr>' + ref_section
        + '</body></html>'
    )

    with open(TRANSCRIPT_FILE, 'w') as f:
        f.write(html_doc)
    log(f'\nTranscript saved → {TRANSCRIPT_FILE}')


# ── Audio helpers ─────────────────────────────────────────────────────────────

def pcm_normalize(samples: np.ndarray) -> np.ndarray:
    if np.abs(samples).max() > 0:
        samples = samples / np.abs(samples).max()
    return samples

MIC_DEVICE = 3  # MacBook Pro Microphone

def record_mic(duration_sec) -> np.ndarray:
    log(f'  [mic] recording {duration_sec}s...')
    audio = sd.rec(int(duration_sec * SAMPLE_RATE), samplerate=SAMPLE_RATE,
                   channels=1, dtype='float32', device=MIC_DEVICE)
    sd.wait()
    return pcm_normalize(audio.squeeze())


# ── Step 1: Whisper via Groq ──────────────────────────────────────────────────

def transcribe_with_timestamps(samples: np.ndarray) -> list[dict]:
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        sf.write(f.name, samples, SAMPLE_RATE)
        tmp_path = f.name
    log(f'  [groq] POST /audio/transcriptions ({len(samples)/SAMPLE_RATE:.1f}s audio)')
    with open(tmp_path, 'rb') as f:
        response = groq_client.audio.transcriptions.create(
            file=("audio.wav", f, "audio/wav"),
            model=WHISPER_MODEL,
            response_format="verbose_json",
            timestamp_granularities=["word"],
            language="en",
        )

    words = []
    if response.words:
        for w in response.words:
            if isinstance(w, dict):
                words.append({'word': w['word'], 'start': w['start'], 'end': w['end']})
            else:
                words.append({'word': w.word, 'start': w.start, 'end': w.end})
    log(f'  [whisper] {len(words)} words transcribed')

    # Refine timestamps with wav2vec2 forced alignment
    if words:
        try:
            aligned = whisperx.align(
                [{'words': words, 'text': ' '.join(w['word'] for w in words),
                  'start': words[0]['start'], 'end': words[-1]['end']}],
                align_model, align_metadata, samples, device="cpu"
            )
            refined = aligned.get('word_segments', [])
            if refined:
                words = [{'word': w['word'], 'start': w.get('start', 0), 'end': w.get('end', 0)} for w in refined]
                log(f'  [align] timestamps refined via wav2vec2')
        except Exception as e:
            log(f'  [align] failed, using Groq timestamps: {e}')

    os.unlink(tmp_path)
    return words


# ── Step 2: Silero VAD ────────────────────────────────────────────────────────

_vad_h = np.zeros((2, 1, 64), dtype=np.float32)
_vad_c = np.zeros((2, 1, 64), dtype=np.float32)

def get_vad_regions(samples: np.ndarray) -> tuple[list, list]:
    global _vad_h, _vad_c
    h  = _vad_h.copy()
    c  = _vad_c.copy()
    sr = np.array(SAMPLE_RATE, dtype=np.int64)

    frame_times, frame_scores, frame_states = [], [], []
    for i in range(0, len(samples) - VAD_WINDOW_SIZE + 1, VAD_WINDOW_SIZE):
        w    = samples[i: i + VAD_WINDOW_SIZE].reshape(1, VAD_WINDOW_SIZE)
        outs = vad_session.run(None, {'input': w, 'sr': sr, 'h': h, 'c': c})
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

    def state_at(t):
        idx = min(range(len(frame_times)), key=lambda i: abs(frame_times[i] - t))
        return frame_states[idx]

    region_end_states = [state_at(e) for (_, e) in merged]
    return merged, region_end_states


# ── Step 3: Segmentation ──────────────────────────────────────────────────────

def split_by_speaker_change(region_samples: np.ndarray, region_start: float) -> list:
    duration      = len(region_samples) / SAMPLE_RATE
    inp           = region_samples.reshape(1, 1, -1).astype(np.float32)
    output        = seg_session.run(None, {'input_values': inp})
    seg           = output[0].squeeze(0)
    seg           = 1.0 / (1.0 + np.exp(-seg))

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
            seg_start, in_speech, prev_dominant = t, True, dominant
        elif is_speech and in_speech:
            if dominant != prev_dominant:
                sub_segments.append((region_start + seg_start, region_start + t))
                seg_start, prev_dominant = t, dominant
        elif not is_speech and in_speech:
            sub_segments.append((region_start + seg_start, region_start + t))
            in_speech = False

    if in_speech:
        sub_segments.append((region_start + seg_start, region_start + duration))

    return sub_segments if sub_segments else [(region_start, region_start + duration)]


def get_segments(samples: np.ndarray, vad_regions: list) -> list:
    final_segments = []
    for (start, end) in vad_regions:
        duration = end - start
        if duration < MIN_SEGMENT_SEC:
            continue
        if duration >= MIN_REGION_SEC:
            region_samples = samples[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
            sub = split_by_speaker_change(region_samples, region_start=start)
            log(f'  [seg] region {start:.1f}s-{end:.1f}s → {len(sub)} sub-segments')
            final_segments.extend(sub)
        else:
            final_segments.append((start, end))
    log(f'  [segments] {len(final_segments)}: {[(f"{s:.1f}", f"{e:.1f}") for s,e in final_segments]}')
    return final_segments


# ── Step 4: ECAPA-TDNN ────────────────────────────────────────────────────────

def get_embedding(samples: np.ndarray) -> np.ndarray | None:
    if len(samples) < int(SAMPLE_RATE * MIN_SEGMENT_SEC):
        return None
    tensor = torch.tensor(samples).unsqueeze(0)
    with torch.no_grad():
        emb = ecapa_model.encode_batch(tensor).squeeze().numpy()
    return emb / np.linalg.norm(emb)


def get_professor_segments(samples: np.ndarray, segments: list) -> tuple[list, list]:
    professor_segments = []
    sim_scores         = []
    for (start, end) in segments:
        if (end - start) < MIN_SEGMENT_SEC:
            continue
        chunk = samples[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
        emb   = get_embedding(chunk)
        if emb is None:
            continue
        sim     = float(np.dot(emb, enrolled_centroid))
        is_prof = sim >= SIMILARITY_THRESHOLD
        log(f'  [emb] {start:.1f}s-{end:.1f}s sim={sim:.3f} → {"PROFESSOR" if is_prof else "other"}')
        if is_prof:
            professor_segments.append((start, end))
            sim_scores.append(sim)
    log(f'  [professor] {[(f"{s:.1f}", f"{e:.1f}") for s,e in professor_segments]}')
    return professor_segments, sim_scores


# ── Step 5: Word stitch ───────────────────────────────────────────────────────

def stitch_professor_words(words: list, professor_segments: list, vad_regions: list) -> tuple[str, list]:
    first_vad_start = vad_regions[0][0] if vad_regions else 0.0
    kept = []
    for w in words:
        mid = (w['start'] + w['end']) / 2.0
        for i, (seg_start, seg_end) in enumerate(professor_segments):
            effective_start = first_vad_start if i == 0 else seg_start
            if effective_start <= mid <= seg_end + 0.5:
                kept.append(w['word'])
                break
    transcript = ' '.join(kept).strip()
    log(f'  [stitch] {len(kept)}/{len(words)} words kept')
    return transcript, kept


# ── Step 5b: Hallucination filter ────────────────────────────────────────────

WHISPER_HALLUCINATIONS = {
    "thanks for watching", "thank you for watching", "please subscribe",
    "like and subscribe", "subscribe to", "don't forget to subscribe",
    "see you in the next", "see you next time", "thanks for listening",
    "thank you for listening", "i'll see you in the next video",
}

def filter_hallucinations(transcript: str) -> str:
    lower = transcript.lower()
    for phrase in WHISPER_HALLUCINATIONS:
        idx = lower.find(phrase)
        if idx != -1:
            transcript = (transcript[:idx] + transcript[idx + len(phrase):]).strip()
            lower = transcript.lower()
            log(f'  [hallucination] removed: "{phrase}"')
    return transcript


# ── Step 6: Dedup ─────────────────────────────────────────────────────────────

def deduplicate_overlap(prev_transcript: str, curr_transcript: str, overlap_words: int = 8) -> str:
    if not prev_transcript:
        return curr_transcript
    prev_words = prev_transcript.lower().split()
    curr_words = curr_transcript.split()
    curr_lower = curr_transcript.lower().split()
    max_check  = min(overlap_words, len(prev_words), len(curr_words))
    for n in range(max_check, 1, -1):
        if prev_words[-n:] == curr_lower[:n]:
            log(f'  [dedup] removed {n} repeated words')
            return ' '.join(curr_words[n:]).strip()
    return curr_transcript


# ── Chunk processing ──────────────────────────────────────────────────────────

last_transcript = ''
transcript_lock = threading.Lock()

def process_chunk(samples: np.ndarray, chunk_idx: int):
    global last_transcript, _vad_h, _vad_c
    import time

    log(f'\n--- Chunk {chunk_idx} ({len(samples)/SAMPLE_RATE:.1f}s) ---')
    chunk_data = {
        'idx': chunk_idx, 'status': 'ok',
        'raw_words': [], 'kept_words': [], 'transcript': '',
        'stitch_kept': 0, 'stitch_total': 0, 'timings': {},
    }

    # Step 1: Groq Whisper
    t0    = time.time()
    words = transcribe_with_timestamps(samples)
    chunk_data['timings']['whisper'] = round(time.time() - t0, 2)
    raw_word_list  = [w['word'] for w in words]
    raw_transcript = ' '.join(raw_word_list).strip()
    chunk_data['raw_words']    = raw_word_list
    chunk_data['stitch_total'] = len(words)
    log(f'  [raw whisper] "{raw_transcript}"')

    if not words:
        chunk_data['status'] = 'no_words'
        with transcript_lock: transcript_chunks.append(chunk_data)
        return

    # Step 2: VAD
    t0 = time.time()
    vad_regions, region_end_states = get_vad_regions(samples)
    chunk_data['timings']['vad'] = round(time.time() - t0, 2)
    log(f'  [vad] {len(vad_regions)} regions: {[(f"{s:.1f}", f"{e:.1f}") for s,e in vad_regions]}')

    if not vad_regions:
        chunk_data['status'] = 'no_vad'
        with transcript_lock: transcript_chunks.append(chunk_data)
        return

    # Step 3: Segmentation
    t0       = time.time()
    segments = get_segments(samples, vad_regions)
    chunk_data['timings']['seg'] = round(time.time() - t0, 2)

    # Step 4: ECAPA-TDNN
    t0 = time.time()
    professor_segments, sim_scores = get_professor_segments(samples, segments)
    chunk_data['timings']['emb'] = round(time.time() - t0, 2)

    # Carry VAD state from last confident professor region
    VAD_STATE_MIN_SIM = 0.40
    if professor_segments and sim_scores and sim_scores[-1] >= VAD_STATE_MIN_SIM and region_end_states:
        last_prof_end = professor_segments[-1][1]
        for idx, (vs, ve) in enumerate(vad_regions):
            if vs <= last_prof_end <= ve + 0.5:
                _vad_h, _vad_c = region_end_states[idx]
                break

    if not professor_segments:
        chunk_data['status'] = 'no_professor'
        last_transcript = ''
        with transcript_lock: transcript_chunks.append(chunk_data)
        print(f'\n[raw]      {raw_transcript}')
        print(f'[filtered] (no professor detected)')
        return

    # Step 5: Stitch
    transcript, kept_words = stitch_professor_words(words, professor_segments, vad_regions)
    transcript = filter_hallucinations(transcript)
    if not transcript:
        chunk_data['status'] = 'no_stitch'
        with transcript_lock: transcript_chunks.append(chunk_data)
        return

    # Step 6: Dedup
    transcript      = deduplicate_overlap(last_transcript, transcript)
    last_transcript = transcript

    chunk_data['kept_words']  = kept_words
    chunk_data['transcript']  = transcript
    chunk_data['stitch_kept'] = len(kept_words)

    log(f'  Transcript: "{transcript}"')
    with transcript_lock: transcript_chunks.append(chunk_data)
    print(f'\n[raw]      {raw_transcript}')
    print(f'[filtered] {transcript}')


# ── Load models ───────────────────────────────────────────────────────────────

log('Loading models...')
vad_session = ort.InferenceSession(f'{MODELS_DIR}/silero_vad.onnx')
log('  Silero VAD loaded')
seg_session = ort.InferenceSession(f'{MODELS_DIR}/segmentation.onnx')
log('  Segmentation model loaded')

import warnings
warnings.filterwarnings('ignore')
torch.backends.nnpack.enabled = False
from speechbrain.inference.speaker import EncoderClassifier
ecapa_model = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=ECAPA_DIR,
    run_opts={"device": "cpu"}
)
ecapa_model.eval()
log('  ECAPA-TDNN loaded')

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
log(f'  Groq client initialized ({WHISPER_MODEL})')

align_model, align_metadata = whisperx.load_align_model(language_code="en", device="cpu")
log('  wav2vec2 alignment model loaded')


# ── Enroll ────────────────────────────────────────────────────────────────────

log(f'\n=== ENROLL: Speak for {ENROLL_SEC} seconds ===')
input('Press Enter to start enrollment...')
log('  Recording — speak now...')
enroll_samples = record_mic(ENROLL_SEC)
log('  Enrollment done.')

enroll_vad, _ = get_vad_regions(enroll_samples)
if not enroll_vad:
    log('ERROR: No speech detected during enrollment')
    save_log()
    sys.exit(1)
log(f'  Enrollment VAD: {len(enroll_vad)} regions')

voiced_chunks = [enroll_samples[int(s * SAMPLE_RATE): int(e * SAMPLE_RATE)] for s, e in enroll_vad]
voiced        = np.concatenate(voiced_chunks)
enrolled_centroid = get_embedding(voiced)
if enrolled_centroid is None:
    log('ERROR: Could not compute enrollment embedding')
    save_log()
    sys.exit(1)
log(f'  Enrolled: {len(voiced)/SAMPLE_RATE:.1f}s voiced audio, threshold={SIMILARITY_THRESHOLD}')


# ── Run ───────────────────────────────────────────────────────────────────────

if len(sys.argv) > 1:
    input_path = sys.argv[1]
    log(f'\n=== FILE MODE: {input_path} ===')
    audio, sr = sf.read(input_path, dtype='float32')
    if audio.ndim > 1:
        audio = audio[:, 0]
    if sr != SAMPLE_RATE:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=SAMPLE_RATE)
    audio = pcm_normalize(audio)
    log(f'  Audio length: {len(audio)/SAMPLE_RATE:.1f}s')

    chunk_samples  = int(CHUNK_SEC  * SAMPLE_RATE)
    record_samples = int(RECORD_SEC * SAMPLE_RATE)
    for idx, start in enumerate(range(0, len(audio), chunk_samples)):
        process_chunk(audio[start: start + record_samples], idx + 1)
else:
    log('\n=== LIVE MODE (Ctrl+C to stop) ===')
    chunk_idx = 1
    try:
        while True:
            chunk = record_mic(RECORD_SEC)
            t = threading.Thread(target=process_chunk, args=(chunk, chunk_idx), daemon=True)
            t.start()
            chunk_idx += 1
    except KeyboardInterrupt:
        log('\nStopped.')

save_log()
if transcript_chunks:
    save_transcript()
    print(f'\nOpen in browser: file://{TRANSCRIPT_FILE}')
