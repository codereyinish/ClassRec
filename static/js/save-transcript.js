// Save Transcript — self-contained module for the live page.
//
// Saves the current lecture transcript to POST /sessions. We don't auto-save;
// we prompt at the moment the transcript would be lost:
//   • starting a NEW recording  -> a "Save this transcript?" modal
//   • refreshing / leaving       -> the browser's native "unsaved" warning
//
// Reads the transcript straight from the DOM (#transcriptContent .transcript-text),
// so live.js stays lean. live.js only calls two tiny hooks:
//   window.SaveTranscript.markDirty()       // when new transcript text arrives
//   window.SaveTranscript.onNewRecording()  // when a new recording is about to start
//
// Uses window.selectedVoiceId (set by voice-picker.js) as the session's voice_id.

const SaveTranscript = (() => {
    let dirty = false;           // is there transcript text not yet saved?
    let overlay = null;

    injectStyles();

    // ---- read the accumulated transcript from the page ----
    function currentText() {
        const parts = document.querySelectorAll("#transcriptContent .transcript-text");
        return Array.from(parts).map((el) => el.textContent.trim()).filter(Boolean).join(" ").trim();
    }

    // Word-level timestamps, straight off the spans live.js already renders.
    // Same {w,s,e} shape the server sends, so it round-trips through words_json
    // unchanged. Empty when a recording fell back to plain text.
    function currentWords() {
        const spans = document.querySelectorAll("#transcriptContent .transcript-text span.word");
        return Array.from(spans).map((el) => ({
            w: el.textContent,
            s: parseFloat(el.dataset.start),
            e: parseFloat(el.dataset.end),
        })).filter((w) => !Number.isNaN(w.s) && !Number.isNaN(w.e));
    }

    function markDirty() { dirty = true; }

    // Called when a new recording is about to start: if there's an unsaved
    // transcript, offer to save it before it's lost.
    function onNewRecording() {
        if (dirty && currentText()) openModal();
    }

    // ---- the "Save this transcript?" modal ----
    function openModal() {
        const text = currentText();
        if (!overlay) buildModal();
        overlay.querySelector(".st-title-input").value =
            "Lecture — " + new Date().toLocaleDateString();
        setStatus("");
        overlay.classList.add("open");
    }
    function closeModal() { if (overlay) overlay.classList.remove("open"); }

    function buildModal() {
        overlay = document.createElement("div");
        overlay.className = "st-overlay";
        overlay.innerHTML = `
            <div class="st-panel" role="dialog" aria-label="Save transcript">
                <div class="st-title">Save this transcript?</div>
                <input class="st-title-input" type="text" placeholder="Lecture title">
                <div class="st-status"></div>
                <div class="st-actions">
                    <button class="st-discard" type="button">Discard</button>
                    <button class="btn-primary st-save" type="button">Save</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
        overlay.querySelector(".st-discard").addEventListener("click", () => {
            dirty = false;        // user chose to let it go
            closeModal();
            // Same reset as a save: the transcript and any doubts raised against
            // it are gone. Without this they'd leak into the next recording.
            window.dispatchEvent(new Event("transcript:discarded"));
        });
        overlay.querySelector(".st-save").addEventListener("click", doSave);
    }

    async function doSave() {
        const title = overlay.querySelector(".st-title-input").value.trim() || "Untitled Lecture";
        const transcript = currentText();
        if (!transcript) { closeModal(); return; }
        setStatus("Saving…");
        try {
            const res = await fetch("/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title,
                    transcript,
                    voice_id: window.selectedVoiceId || null,
                    words: currentWords(),
                    flags: window.DoubtPanel?.getFlags() || [],
                }),
            });
            if (!res.ok) { setStatus("Save failed.", "error"); return; }
            dirty = false;
            closeModal();
            // tell live.js to reset the page to its fresh, empty state
            window.dispatchEvent(new Event("transcript:saved"));
        } catch {
            setStatus("Save failed.", "error");
        }
    }

    function setStatus(msg, kind = "") {
        const el = overlay && overlay.querySelector(".st-status");
        if (el) { el.textContent = msg; el.className = "st-status" + (kind ? " " + kind : ""); }
    }

    // ---- native warning on refresh / close while unsaved ----
    window.addEventListener("beforeunload", (e) => {
        if (dirty && currentText()) { e.preventDefault(); e.returnValue = ""; }
    });

    // scoped styles, injected once (keeps this a single portable file)
    function injectStyles() {
        const css = `
        .st-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);
            display:flex;align-items:center;justify-content:center;z-index:1100;opacity:0;
            pointer-events:none;transition:opacity .2s}
        .st-overlay.open{opacity:1;pointer-events:auto}
        .st-panel{width:360px;max-width:calc(100vw - 40px);background:var(--bg-surface);
            border:1px solid var(--border);border-radius:14px;padding:20px;
            box-shadow:0 20px 60px rgba(0,0,0,.5);transform:translateY(12px) scale(.98);transition:transform .2s}
        .st-overlay.open .st-panel{transform:none}
        .st-title{font-family:'DM Serif Display',serif;font-size:18px;color:var(--text);margin-bottom:14px}
        .st-title-input{width:100%;background:var(--bg-elevated);border:1px solid var(--border);
            border-radius:7px;padding:9px 12px;color:var(--text);font-family:'DM Mono',monospace;font-size:12px}
        .st-title-input:focus{outline:none;border-color:var(--accent)}
        .st-status{font-size:11px;color:var(--text-muted);min-height:0;margin-top:8px}
        .st-status.error{color:var(--red)}
        .st-status:empty{display:none}
        .st-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
        .st-discard{background:none;border:1px solid var(--border);color:var(--text-muted);
            border-radius:7px;padding:8px 16px;font-family:'DM Mono',monospace;font-size:12px;cursor:pointer}
        .st-discard:hover{color:var(--red);border-color:var(--red)}`;
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
    }

    // Auto-wire the "💾 Save" button if the page has one.
    (function wireSaveButton() {
        const btn = document.getElementById("saveTranscriptBtn");
        if (btn) btn.addEventListener("click", () => {
            if (currentText()) openModal();     // nothing to save if empty
        });
    })();

    return { markDirty, onNewRecording, promptSave: openModal };
})();

window.SaveTranscript = SaveTranscript;
