"""
Evaluate ClassRec (Groq pipeline) transcript quality vs reference.txt

Usage:
    python evaluate.py reference.txt log_file [output.html]

    Save server output first:
        uvicorn main:app --port 8080 2>&1 | tee session.log
    Then:
        python evaluate.py ../TestModel/reference.txt session.log

Produces an HTML file with:
  1. Per-chunk: raw whisper with filtered-out words struck through (orange)
  2. Full session: filtered vs reference — matched (white), extra (orange), missing (red underline)
"""
import sys, re, os, html as html_lib

CSS = """
body       { font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 24px; line-height: 1.8; }
h1         { color: #569cd6; }
h2         { color: #9cdcfe; margin-top: 40px; }
.chunk     { border-left: 3px solid #444; padding-left: 16px; margin-bottom: 28px; }
.label     { color: #9cdcfe; }
.dropped   { color: #4ec94e; text-decoration: line-through; }
.matched   { color: #d4d4d4; }
.pip-extra { color: #ce9178; }
.ref-miss  { color: #f44747; text-decoration: underline; }
hr         { border-color: #333; margin: 40px 0; }
.legend    { color: #888; margin-top: 20px; }
"""


def normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_chunks(log_path: str) -> list[tuple[str, str | None]]:
    """
    Parse log for (raw_whisper, filtered) pairs.
    filtered=None when no professor detected or all words removed.
    """
    chunks = []
    raw = None
    with open(log_path) as f:
        for line in f:
            m = re.search(r'\[raw whisper\] (.+)', line)
            if m:
                raw = m.group(1).strip()
                continue

            if raw is None:
                continue

            m2 = re.search(r'\[filtered\] (.+)', line)
            if m2:
                chunks.append((raw, m2.group(1).strip()))
                raw = None
                continue

            if re.search(r'\[chunk\] no professor|no words remained|transcript empty after', line):
                chunks.append((raw, None))
                raw = None

    return chunks


def render_raw(raw: str, filtered: str | None) -> str:
    """
    Highlight raw whisper words:
      - white             = made it into filtered output
      - green strikethrough = dropped by speaker filter

    Uses SequenceMatcher for positional diff so duplicate words are handled correctly.
    """
    import difflib

    if filtered is None:
        words = raw.split()
        return " ".join(f'<span class="dropped">{html_lib.escape(w)}</span>' for w in words)

    raw_words  = raw.split()
    kept_words = filtered.split()
    raw_norm   = [normalize(w) for w in raw_words]
    kept_norm  = [normalize(w) for w in kept_words]

    sm     = difflib.SequenceMatcher(None, raw_norm, kept_norm, autojunk=False)
    result = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for w in raw_words[i1:i2]:
                result.append(f'<span class="matched">{html_lib.escape(w)}</span>')
        elif tag in ("replace", "delete"):
            for w in raw_words[i1:i2]:
                result.append(f'<span class="dropped">{html_lib.escape(w)}</span>')
            if tag == "replace":
                for w in kept_words[j1:j2]:
                    result.append(f'<span class="matched">{html_lib.escape(w)}</span>')
        elif tag == "insert":
            for w in kept_words[j1:j2]:
                result.append(f'<span class="matched">{html_lib.escape(w)}</span>')
    return " ".join(result)


def render_reference_comparison(hypothesis: str, reference: str) -> tuple[str, float | None]:
    """
    Word-level diff of hypothesis vs reference.
    Returns (html_string, wer_score).
    """
    try:
        from jiwer import wer, process_words
    except ImportError:
        return '<p style="color:#f44747">Install jiwer: pip install jiwer</p>', None

    ref_norm = normalize(reference)
    hyp_norm = normalize(hypothesis)

    score  = wer(ref_norm, hyp_norm)
    output = process_words(ref_norm, hyp_norm)

    ref_words = ref_norm.split()
    hyp_words = hyp_norm.split()

    result = []
    for chunk in output.alignments[0]:
        if chunk.type == "equal":
            for w in hyp_words[chunk.hyp_start_idx:chunk.hyp_end_idx]:
                result.append(f'<span class="matched">{html_lib.escape(w)}</span>')
        elif chunk.type == "substitute":
            for w in hyp_words[chunk.hyp_start_idx:chunk.hyp_end_idx]:
                result.append(f'<span class="pip-extra">{html_lib.escape(w)}</span>')
            for w in ref_words[chunk.ref_start_idx:chunk.ref_end_idx]:
                result.append(f'<span class="ref-miss">[{html_lib.escape(w)}]</span>')
        elif chunk.type == "insert":
            for w in hyp_words[chunk.hyp_start_idx:chunk.hyp_end_idx]:
                result.append(f'<span class="pip-extra">{html_lib.escape(w)}</span>')
        elif chunk.type == "delete":
            for w in ref_words[chunk.ref_start_idx:chunk.ref_end_idx]:
                result.append(f'<span class="ref-miss">[{html_lib.escape(w)}]</span>')

    return " ".join(result), score


def build_html(chunks: list, reference: str) -> str:
    parts = [
        '<!DOCTYPE html><html><head><meta charset="utf-8">',
        '<title>ClassRec Evaluation</title>',
        f'<style>{CSS}</style></head><body>',
        '<h1>ClassRec Transcript Evaluation</h1>',
    ]

    hypothesis_parts = []

    for i, (raw, filtered) in enumerate(chunks):
        total = len(raw.split())
        kept  = len(filtered.split()) if filtered else 0

        parts.append(f'<div class="chunk"><h2>Chunk {i + 1}</h2>')
        parts.append(
            f'<p><span class="label">[raw whisper]</span> &ldquo;{render_raw(raw, filtered)}&rdquo;</p>'
        )
        parts.append(f'<p><span class="label">[stitch]</span> {kept}/{total} words kept</p>')

        if filtered:
            parts.append(
                f'<p><span class="label">[filtered]</span> &ldquo;{html_lib.escape(filtered)}&rdquo;</p>'
            )
            hypothesis_parts.append(filtered)
        else:
            parts.append(
                '<p><span class="label">[filtered]</span> '
                '<em style="color:#666">no professor detected</em></p>'
            )

        parts.append('</div>')

    # Full transcript vs reference
    parts.append('<hr><h2>Full Transcript vs Reference</h2>')
    hypothesis = " ".join(hypothesis_parts)

    comparison_html, score = render_reference_comparison(hypothesis, reference)

    if score is not None:
        parts.append(
            f'<p><span class="label">WER:</span> {score * 100:.1f}%'
            ' &nbsp; <span style="color:#888">(lower is better, 0% = perfect)</span></p>'
        )

    parts.append(f'<p>{comparison_html}</p>')
    parts.append(
        '<p class="legend">Legend: '
        '<span class="matched">matched</span> &nbsp;·&nbsp; '
        '<span class="pip-extra">pipeline extra / substituted</span> &nbsp;·&nbsp; '
        '<span class="ref-miss">[reference word missing]</span></p>'
    )
    parts.append('</body></html>')

    return "\n".join(parts)


# ── Main ──────────────────────────────────────────────────────────────────────

if len(sys.argv) < 3:
    print("Usage: python evaluate.py reference.txt log_file [output.html]")
    sys.exit(1)

ref_path = sys.argv[1]
log_path = sys.argv[2]
out_path = sys.argv[3] if len(sys.argv) > 3 else "evaluation.html"

with open(ref_path) as f:
    reference = f.read().strip()

chunks = extract_chunks(log_path)
if not chunks:
    print(f"No [raw whisper] lines found in {log_path}")
    sys.exit(1)

print(f"Found {len(chunks)} chunks")

html_content = build_html(chunks, reference)
with open(out_path, "w") as f:
    f.write(html_content)

print(f"Saved → {out_path}")

hypothesis = " ".join(f for _, f in chunks if f)
try:
    from jiwer import wer
    score = wer(normalize(reference), normalize(hypothesis))
    print(f"WER: {score * 100:.1f}%")
except ImportError:
    print("Install jiwer for WER: pip install jiwer")
