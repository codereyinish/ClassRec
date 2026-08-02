# Class materials → summaries and flashcards

Deferred feature. Nothing here is built; this records the design and the reasoning
so the decision does not have to be made again from scratch.

## What it is

A class holds reference material — slides, a chapter, a syllabus, notes pasted as
text. Sessions belonging to that class can then be turned into a summary or a set
of flashcards that are grounded in the material rather than in the transcript
alone.

The trigger is explicit and after the fact: the user opens a saved session and
asks for a summary or flashcards. It never runs during a lecture.

## Why the material is attached to the class, not the session

Slides and a chapter apply to the whole course, not to one lecture, and a student
sitting down as the professor starts talking will not upload anything. Attaching
once per class means every session inherits it with no work at the moment it would
be most disruptive.

This is also the first real job the class entity has beyond being a label — it is
currently a name and nothing else.

## Two uses, two shapes

The same word "context" covers two jobs that need entirely different inputs.

**Transcription.** Whisper accepts an `initial_prompt`, capped near 224 tokens,
which biases spelling and vocabulary. It cannot take a document, and overfilling
it makes the model hallucinate and repeat. What helps is a short glossary — the
professor's name, course jargon, symbols, unusual proper nouns. The gain is real
but small: it fixes the words ASR reliably mangles.

**Summaries and flashcards.** Here the full material matters. A raw transcript is
noisy, omits everything that was only on the slide, and carries no structure.
Grounding the output in the actual chapter is what separates a record of what was
said from something worth revising. This is the larger payoff by a wide margin,
and it runs after the lecture, where latency does not matter and a bad result
costs nothing.

If only one gets built, build this one.

## Existing hook

`lecture_prompt` is already carried from the page to `_run_pipeline_sync`
(`src/main.py`) and then dropped — `transcribe_with_timestamps` takes samples
only. The wire format needs no change to start feeding Whisper a glossary; the
parameter just has to reach the Modal call.

On the page, the context dialog, `askContext()` and the `prompt` field on the
context message are still in `templates/live_v2.html`. Only the calls that opened
the dialog were removed, so reviving it is small.

## Rough shape of the work

- Storage for uploaded files per class, plus text extraction (PDF, slides).
- A term list derived from that text, passed as Whisper's `initial_prompt`.
- Summary and flashcard generation over the session transcript plus the material.
- Retrieval — chunking and embeddings — only once documents outgrow a single
  prompt. Passing the extracted text straight through is enough to start.

All of it is backend work and a project of its own, not part of the frontend
redesign.
