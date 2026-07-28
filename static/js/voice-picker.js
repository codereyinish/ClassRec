// Voice Picker — self-contained popup + dropdown-trigger component.
//
// Backend routes:
//   GET    /voices              -> top-4 voices (each: {id, name, use_count, has_audio})
//   POST   /voices?name=..      -> enroll a professor from an uploaded file (stores audio)
//   PATCH  /voices/{id}         -> rename
//   DELETE /voices/{id}         -> remove
//   GET    /voices/{id}/audio   -> the stored clip (for click-to-play)
//
// Item interactions (both popup rows and the dropdown trigger):
//   • click the NAME        -> play the voice audio (name turns green while playing)
//   • double-click the NAME -> edit it inline (PATCH)
//   • click the ARROW       -> (popup) select/lock the voice · (trigger) open the popup

const VoicePicker = (() => {
    let overlay, listEl, fileInput, addBtn, addForm, nameInput, fnameEl, statusEl;
    let onPickCallback = null;
    let selectedId = null;

    const TRASH_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;

    // ---------- audio playback (shared across all name elements) ----------
    let audioEl = null, playingEl = null;
    function stopPlaying() {
        if (playingEl) playingEl.classList.remove("playing");
        playingEl = null;
    }
    function togglePlay(voice, nameEl) {
        if (!voice || !voice.has_audio) return;
        if (!audioEl) {
            audioEl = new Audio();
            audioEl.addEventListener("ended", stopPlaying);
            audioEl.addEventListener("pause", stopPlaying);
        }
        if (playingEl === nameEl) { audioEl.pause(); return; }   // click again -> stop
        stopPlaying();
        audioEl.src = `/voices/${voice.id}/audio`;
        audioEl.play().catch(() => {});
        nameEl.classList.add("playing");
        playingEl = nameEl;
    }

    // ---------- inline rename (contenteditable keeps the element + its id) ----------
    function startRename(voice, nameEl, onDone) {
        stopPlaying();
        nameEl.contentEditable = "true";
        nameEl.classList.add("editing");
        nameEl.focus();
        const range = document.createRange(); range.selectNodeContents(nameEl);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);

        let done = false;
        const finish = async (save) => {
            if (done) return; done = true;
            nameEl.contentEditable = "false";
            nameEl.classList.remove("editing");
            const nn = nameEl.textContent.trim();
            if (save && nn && nn !== voice.name) {
                try {
                    await fetch(`/voices/${voice.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: nn }),
                    });
                    voice.name = nn;
                } catch {}
            }
            nameEl.textContent = voice.name;
            if (onDone) onDone(voice);
        };
        nameEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { finish(false); }
        });
        nameEl.addEventListener("blur", () => finish(true), { once: true });
    }

    // single-click = play, double-click = rename (with disambiguation timer)
    function bindName(nameEl, voice, onRenamed) {
        let t = null;
        nameEl.addEventListener("click", (e) => {
            e.stopPropagation();
            if (nameEl.isContentEditable) return;
            if (t) return;
            t = setTimeout(() => { t = null; togglePlay(voice, nameEl); }, 220);
        });
        nameEl.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            clearTimeout(t); t = null;
            startRename(voice, nameEl, onRenamed);
        });
    }

    function ensureBuilt() {
        if (overlay) return;
        overlay = document.createElement("div");
        overlay.className = "vp-overlay";
        overlay.innerHTML = `
            <div class="vp-panel" role="dialog" aria-label="Pick a voice">
                <div class="vp-title">Pick a Voice</div>
                <div class="vp-list"></div>

                <div class="vp-add">
                    <button class="vp-add-btn" type="button" title="Add a voice">+</button>
                    <div class="vp-add-form" hidden>
                        <div class="vp-fname"></div>
                        <input class="vp-input vp-name" type="text" placeholder="Voice name">
                        <div class="vp-add-actions">
                            <button class="vp-add-cancel" type="button">Cancel</button>
                            <button class="btn-primary vp-add-save" type="button">Add</button>
                        </div>
                    </div>
                    <input class="vp-file" type="file" accept="audio/*" hidden>
                    <div class="vp-status"></div>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        listEl    = overlay.querySelector(".vp-list");
        fileInput = overlay.querySelector(".vp-file");
        addBtn    = overlay.querySelector(".vp-add-btn");
        addForm   = overlay.querySelector(".vp-add-form");
        nameInput = overlay.querySelector(".vp-name");
        fnameEl   = overlay.querySelector(".vp-fname");
        statusEl  = overlay.querySelector(".vp-status");

        overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
        addBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => {
            const f = fileInput.files[0];
            if (!f) return;
            nameInput.value = f.name.replace(/\.[^.]+$/, "");
            fnameEl.textContent = f.name;
            addBtn.hidden = true;
            addForm.hidden = false;
            setStatus("");
            nameInput.focus();
        });
        overlay.querySelector(".vp-add-cancel").addEventListener("click", resetAdd);
        overlay.querySelector(".vp-add-save").addEventListener("click", uploadVoice);
    }

    async function refresh() {
        listEl.innerHTML = `<div class="vp-empty">Loading…</div>`;
        try {
            const voices = await (await fetch("/voices")).json();
            render(voices);
        } catch {
            listEl.innerHTML = `<div class="vp-empty">Could not load voices.</div>`;
        }
    }

    function render(voices) {
        if (!voices.length) {
            listEl.innerHTML = `<div class="vp-empty">No voices yet.</div>`;
            return;
        }
        listEl.innerHTML = "";
        voices.forEach((v) => {
            const item = document.createElement("div");
            item.className = "vp-item" + (v.id === selectedId ? " selected" : "");

            const nameEl = document.createElement("span");
            nameEl.className = "vp-item-name";
            nameEl.textContent = v.name;
            bindName(nameEl, v, refresh);       // dblclick -> rename -> refresh
            item.appendChild(nameEl);

            const arrow = document.createElement("button");
            arrow.className = "vp-item-arrow";
            arrow.title = "Use this voice";
            arrow.textContent = "▾";
            arrow.addEventListener("click", (e) => {
                e.stopPropagation();
                selectedId = v.id;
                if (onPickCallback) onPickCallback(v);
                close();
            });
            item.appendChild(arrow);

            const trash = document.createElement("button");
            trash.className = "vp-trash";
            trash.title = "Remove";
            trash.innerHTML = TRASH_SVG;
            trash.addEventListener("click", async (e) => {
                e.stopPropagation();
                await fetch(`/voices/${v.id}`, { method: "DELETE" });
                await refresh();
            });
            item.appendChild(trash);

            listEl.appendChild(item);
        });
    }

    async function uploadVoice() {
        const file = fileInput.files[0];
        const name = (nameInput.value || "").trim();
        if (!file) return;
        if (!name) { setStatus("Enter a name.", "error"); return; }

        const saveBtn = overlay.querySelector(".vp-add-save");
        const cancelBtn = overlay.querySelector(".vp-add-cancel");
        saveBtn.disabled = true; cancelBtn.disabled = true;
        saveBtn.textContent = "Adding…";
        setStatus("Analyzing voice… (a few seconds)");

        const fd = new FormData();
        fd.append("file", file);
        try {
            const res = await fetch(`/voices?name=${encodeURIComponent(name)}`, { method: "POST", body: fd });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setStatus(err.detail || "Failed.", "error");
                return;
            }
            resetAdd();
            await refresh();
        } catch {
            setStatus("Failed.", "error");
        } finally {
            saveBtn.disabled = false; cancelBtn.disabled = false;
            saveBtn.textContent = "Add";
        }
    }

    function resetAdd() {
        fileInput.value = "";
        nameInput.value = "";
        fnameEl.textContent = "";
        addForm.hidden = true;
        addBtn.hidden = false;
        setStatus("");
    }

    function setStatus(msg, kind = "") {
        statusEl.textContent = msg;
        statusEl.className = "vp-status" + (kind ? " " + kind : "");
    }

    function open(onPick) {
        ensureBuilt();
        onPickCallback = onPick || null;
        resetAdd();
        overlay.classList.add("open");
        refresh();
    }
    function close() { if (overlay) overlay.classList.remove("open"); }

    // expose the play + rename helpers so the dropdown trigger can reuse them
    return { open, close, play: togglePlay, rename: startRename };
})();

window.VoicePicker = VoicePicker;

// ---------- Dropdown trigger (#pickVoiceBtn) on the live page ----------
// name click = play · caret click = open popup · double-click name = rename
(function wireDropdown() {
    const trigger = document.getElementById("pickVoiceBtn");
    if (!trigger) return;
    const label = document.getElementById("selectedVoice");
    let current = null;   // the currently-selected voice object
    let t = null;

    function openPicker() {
        VoicePicker.open((voice) => {
            current = voice;
            window.selectedVoiceId = voice.id;
            if (label) { label.textContent = voice.name; label.classList.add("has-voice"); }
            window.onVoicePicked?.(voice);
        });
    }

    trigger.addEventListener("click", (e) => {
        if (label && label.isContentEditable) return;
        // caret, or nothing picked yet -> open the picker
        if (!current || e.target.closest(".voice-dropdown-caret")) { openPicker(); return; }
        // name clicked -> play (single-click, disambiguated from dblclick)
        if (label && (e.target === label || label.contains(e.target))) {
            if (t) return;
            t = setTimeout(() => { t = null; VoicePicker.play(current, label); }, 220);
        }
    });
    trigger.addEventListener("dblclick", (e) => {
        if (!current || !label) return;
        if (e.target === label || label.contains(e.target)) {
            clearTimeout(t); t = null;
            VoicePicker.rename(current, label, (v) => { current = v; });
        }
    });
})();
