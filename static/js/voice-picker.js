// Voice Picker — a self-contained, minimal popup component.
//
// Backend routes:
//   GET    /voices            -> top-4 voices (list)
//   POST   /voices?name=..    -> enroll a professor from an uploaded file
//   DELETE /voices/{id}       -> remove a voice
//
// Usage:  VoicePicker.open(onPick)   // onPick(voice) fires when a voice is chosen
// Backfill rule: after a delete, RE-FETCH the list (never just drop the DOM row).

const VoicePicker = (() => {
    let overlay, listEl, fileInput, addBtn, addForm, nameInput, fnameEl, statusEl;
    let onPickCallback = null;
    let selectedId = null;

    // small traditional trash icon (feather "trash-2"), styled red via CSS
    const TRASH_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;

    function ensureBuilt() {
        if (overlay) return;
        overlay = document.createElement("div");
        overlay.className = "vp-overlay";
        overlay.innerHTML = `
            <div class="vp-panel" role="dialog" aria-label="Pick a voice">
                <div class="vp-title">Pick a Voice</div>
                <div class="vp-list"></div>

                <div class="vp-add">
                    <button class="vp-add-btn" type="button">＋ Add new voice</button>
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

        // "Add new voice" -> pick a file first
        addBtn.addEventListener("click", () => fileInput.click());
        // file chosen -> reveal the editable name form (prefilled from filename)
        fileInput.addEventListener("change", () => {
            const f = fileInput.files[0];
            if (!f) return;
            nameInput.value = f.name.replace(/\.[^.]+$/, "");   // drop extension -> editable name
            fnameEl.textContent = f.name;
            addBtn.hidden = true;
            addForm.hidden = false;
            setStatus("");
            nameInput.focus();
        });
        overlay.querySelector(".vp-add-cancel").addEventListener("click", resetAdd);
        overlay.querySelector(".vp-add-save").addEventListener("click", uploadVoice);
    }

    // GET /voices -> render list (on open AND after every delete)
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
            item.innerHTML = `
                <span class="vp-item-name">${escapeHtml(v.name)}</span>
                <button class="vp-trash" title="Remove">${TRASH_SVG}</button>`;
            item.addEventListener("click", (e) => {
                if (e.target.closest(".vp-trash")) return;
                selectedId = v.id;
                if (onPickCallback) onPickCallback(v);
                close();
            });
            item.querySelector(".vp-trash").addEventListener("click", async (e) => {
                e.stopPropagation();
                await fetch(`/voices/${v.id}`, { method: "DELETE" });
                await refresh();                          // backfill
            });
            listEl.appendChild(item);
        });
    }

    // POST /voices -> enroll from the chosen file with the (edited) name
    async function uploadVoice() {
        const file = fileInput.files[0];
        const name = (nameInput.value || "").trim();
        if (!file) return;
        if (!name) { setStatus("Enter a name.", "error"); return; }
        setStatus("Adding voice…");
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

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
    }

    return { open, close };
})();

window.VoicePicker = VoicePicker;
