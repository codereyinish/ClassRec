// Doubt panel — flag a moment in the lecture you didn't follow, and ask about it.
//
// The flow is deliberately two-step:
//   1. select transcript text  -> the selection is REMEMBERED, nothing opens
//   2. click the floating bubble -> the panel opens with that selection pinned
//
// Selecting never opens the panel on its own; mid-lecture you shouldn't lose the
// screen to a sidebar you didn't ask for. The bubble's dot is the only hint that
// a selection is being held.
//
// Timestamps come from the word spans live.js already renders
// (<span class="word" data-start data-end>), so a doubt is anchored to the exact
// second of the recording. Flags live in memory during the lecture and are
// written to the DB with the transcript on save — see save-transcript.js.

const DoubtPanel = (() => {
    const flags = [];            // raised this session, in the order they were raised
    let held = null;             // the remembered selection, or null
    let bubble, panel, body, chip, chipTime, chipText, input, flagBtn;

    const CONTEXT_WORDS = 40;    // words either side of the selection sent as context

    build();
    wireSelection();

    // ---- time helpers ----
    function fmt(sec) {
        if (sec == null || Number.isNaN(sec)) return "--:--";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
    }

    // ---- selection capture: press and hold, then drag ----
    //
    // A short click on a word already means "seek the audio there"
    // (audio-playback.js listens on document). So selecting can't use a plain
    // drag — it would end in a click and the audio would jump. Instead:
    //
    //   tap/click           -> untouched, audio seeks as before
    //   hold HOLD_MS, drag  -> sweeps a range of words, then arms the icon
    //
    // The range is painted by hand rather than using native text selection:
    // native selection can't be started reliably part-way through a gesture,
    // and doing it manually behaves identically under touch, which is where
    // press-and-hold is the natural idiom anyway.
    const HOLD_MS = 400;
    const MOVE_TOLERANCE = 8;      // px of drift allowed before the hold is treated as a scroll

    let holdTimer = null;
    let anchor = null;             // the word the press started on
    let selecting = false;
    let justSelected = false;      // set on release, so the click that follows can be swallowed
    let startX = 0, startY = 0;

    function wireSelection() {
        const host = document.getElementById("transcriptContent");
        if (!host) return;

        host.addEventListener("pointerdown", (e) => {
            justSelected = false;
            const span = e.target.closest("span.word");
            if (!span) return;
            anchor = span;
            startX = e.clientX;
            startY = e.clientY;
            holdTimer = setTimeout(() => {
                selecting = true;
                host.classList.add("dp-selecting-mode");
                paintRange(anchor, anchor);
            }, HOLD_MS);
        });

        host.addEventListener("pointermove", (e) => {
            // Moved before the hold registered? That's a scroll or a sloppy
            // click, not a press — drop the timer.
            if (!selecting) {
                if (holdTimer && (Math.abs(e.clientX - startX) > MOVE_TOLERANCE ||
                                  Math.abs(e.clientY - startY) > MOVE_TOLERANCE)) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
                return;
            }
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const span = el && el.closest && el.closest("span.word");
            if (span) paintRange(anchor, span);
            e.preventDefault();          // don't scroll the page mid-sweep
        });

        window.addEventListener("pointerup", () => {
            clearTimeout(holdTimer);
            holdTimer = null;
            if (!selecting) { anchor = null; return; }
            commitSelection();
            selecting = false;
            justSelected = true;
            host.classList.remove("dp-selecting-mode");
        });

        // Capture phase, so this runs BEFORE audio-playback.js's document-level
        // click listener and can stop the seek that would otherwise follow a
        // press-and-drag. audio-playback.js itself is left alone.
        document.addEventListener("click", (e) => {
            if (!justSelected) return;
            justSelected = false;
            e.stopPropagation();
            e.preventDefault();
        }, true);
    }

    // Tint every word between the two ends, in document order.
    function paintRange(from, to) {
        const all = Array.from(document.querySelectorAll("#transcriptContent span.word"));
        let a = all.indexOf(from), b = all.indexOf(to);
        if (a === -1 || b === -1) return;
        if (a > b) [a, b] = [b, a];
        all.forEach((w, i) => w.classList.toggle("dp-selecting", i >= a && i <= b));
    }

    function commitSelection() {
        const picked = Array.from(document.querySelectorAll("#transcriptContent span.word.dp-selecting"));
        picked.forEach((w) => w.classList.remove("dp-selecting"));
        if (!picked.length) return;

        held = {
            quote: picked.map((w) => w.textContent).join(" ").trim(),
            t_start: parseFloat(picked[0].dataset.start),
            t_end: parseFloat(picked[picked.length - 1].dataset.end),
        };
        bubble.classList.add("armed");
    }

    // The transcript either side of the selection, so an answer can be given in
    // context rather than off a bare phrase.
    function contextAround(t_start, t_end) {
        const all = Array.from(document.querySelectorAll("#transcriptContent span.word"));
        if (!all.length) return "";
        const first = all.findIndex((w) => parseFloat(w.dataset.end) >= t_start);
        const last = all.findIndex((w) => parseFloat(w.dataset.start) >= t_end);
        const from = Math.max(0, (first === -1 ? 0 : first) - CONTEXT_WORDS);
        const to = Math.min(all.length, (last === -1 ? all.length : last) + CONTEXT_WORDS);
        return all.slice(from, to).map((w) => w.textContent).join(" ");
    }

    // ---- panel open / close ----
    function open() {
        panel.classList.add("open");
        panel.setAttribute("aria-hidden", "false");
        bubble.classList.add("open");            // icon stays lit while the panel shows
        bubble.setAttribute("aria-expanded", "true");
        renderChip();
        render();
        input.focus();
    }
    function close() {
        panel.classList.remove("open");
        panel.setAttribute("aria-hidden", "true");
        bubble.classList.remove("open");
        bubble.setAttribute("aria-expanded", "false");
    }

    function clearHeld() {
        held = null;
        bubble.classList.remove("armed");
        renderChip();
    }

    function renderChip() {
        if (!held) { chip.hidden = true; flagBtn.disabled = true; input.placeholder = "Ask about this lecture…"; return; }
        chip.hidden = false;
        flagBtn.disabled = false;
        chipTime.textContent = fmt(held.t_start);
        chipText.textContent = held.quote;
        input.placeholder = "What didn't make sense?";
    }

    // ---- raising a doubt ----
    function addFlag(question) {
        if (!held) return null;
        const flag = {
            t_start: held.t_start,
            t_end: held.t_end,
            quote: held.quote,
            question: question || null,
            answer: null,
        };
        flags.push(flag);
        markTranscript(flag);
        clearHeld();
        return flag;
    }

    // Paint the flagged words back in the transcript, so the lecture itself
    // shows where you got lost.
    function markTranscript(flag) {
        document.querySelectorAll("#transcriptContent span.word").forEach((w) => {
            const s = parseFloat(w.dataset.start);
            if (s >= flag.t_start && s <= flag.t_end) w.classList.add("dp-flagged");
        });
    }

    async function send() {
        const question = input.value.trim();
        if (!held && !question) return;

        // No selection: still worth asking, but there's nothing to anchor it to,
        // so it isn't kept as a flag.
        if (!held) {
            input.value = "";
            const card = { t_start: null, t_end: null, quote: "", question, answer: null, transient: true };
            flags.push(card);
            render();
            await answer(card, "");
            return;
        }

        const ctx = contextAround(held.t_start, held.t_end);
        const flag = addFlag(question);
        input.value = "";
        render();
        await answer(flag, ctx);
    }

    async function answer(flag, ctx) {
        flag.pending = true;
        render();
        try {
            const res = await fetch("/ask", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    quote: flag.quote,
                    question: flag.question,
                    context: ctx,
                    t_start: flag.t_start,
                    t_end: flag.t_end,
                }),
            });
            const data = await res.json();
            flag.answer = res.ok ? data.answer : "Couldn't get an answer. The flag is saved — try again after class.";
        } catch {
            flag.answer = "Couldn't reach the server. The flag is saved.";
        }
        flag.pending = false;
        render();
    }

    // ---- render the list ----
    function render() {
        if (!flags.length) {
            body.innerHTML = `
                <div class="dp-empty">
                    Select anything in the transcript, then come back here.
                    <br><br>
                    Your doubts stay pinned to the second they happened, and
                    <b>save with the lecture</b>.
                </div>
                <div class="dp-suggestions">
                    <button class="dp-suggestion" type="button">Explain this simply</button>
                    <button class="dp-suggestion" type="button">Why does this matter?</button>
                    <button class="dp-suggestion" type="button">Give me an example</button>
                </div>`;
            body.querySelectorAll(".dp-suggestion").forEach((b) =>
                b.addEventListener("click", () => { input.value = b.textContent; input.focus(); })
            );
            return;
        }

        body.innerHTML = "";
        flags.forEach((f) => {
            const card = document.createElement("div");
            card.className = "dp-card";

            const parts = [];
            if (f.t_start != null) parts.push(`<div class="dp-card-time">▸ ${fmt(f.t_start)}</div>`);
            if (f.quote) parts.push(`<div class="dp-card-quote">${escapeHtml(f.quote)}</div>`);
            if (f.question) parts.push(`<div class="dp-card-q">${escapeHtml(f.question)}</div>`);
            if (f.pending) parts.push(`<div class="dp-card-a pending">Thinking…</div>`);
            else if (f.answer) parts.push(`<div class="dp-card-a">${escapeHtml(f.answer)}</div>`);
            card.innerHTML = parts.join("");

            const time = card.querySelector(".dp-card-time");
            if (time) time.addEventListener("click", () => jumpTo(f.t_start));
            body.appendChild(card);
        });
        body.scrollTop = body.scrollHeight;
    }

    // Scroll the transcript back to the flagged moment and flash it.
    function jumpTo(t) {
        const target = Array.from(document.querySelectorAll("#transcriptContent span.word"))
            .find((w) => parseFloat(w.dataset.start) >= t);
        if (!target) return;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.classList.add("dp-jump");
        setTimeout(() => target.classList.remove("dp-jump"), 1200);
    }

    // ---- DOM ----
    function build() {
        bubble = document.createElement("button");
        bubble.className = "dp-bubble";
        bubble.id = "dpBubble";
        bubble.type = "button";
        bubble.setAttribute("aria-label", "Ask about this lecture");
        bubble.setAttribute("aria-expanded", "false");
        bubble.setAttribute("aria-controls", "dpPanel");
        // A speech bubble with a question in it — "ask about this". Thin strokes
        // so it stays legible at 20px and sits quietly next to the mic control.
        bubble.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20.5 12.2a7.7 7.7 0 0 1-8.3 7.7 8.2 8.2 0 0 1-3.2-.7l-4.6 1.3 1.4-4.3a7.7 7.7 0 0 1-1.3-4.3 7.9 7.9 0 0 1 8-7.6 7.8 7.8 0 0 1 8 7.9z"/>
                <path d="M10.1 9.7a2.1 2.1 0 0 1 4-.5c.3 1.3-.7 1.8-1.5 2.3a1.6 1.6 0 0 0-.7 1.3"/>
                <circle cx="11.9" cy="15.6" r="0.55" fill="currentColor" stroke="none"/>
            </svg>`;
        document.body.appendChild(bubble);

        panel = document.createElement("aside");
        panel.className = "dp-panel";
        panel.id = "dpPanel";
        panel.setAttribute("aria-hidden", "true");
        panel.setAttribute("aria-label", "Doubts");
        panel.innerHTML = `
            <header class="dp-head">
                <span class="dp-title">Doubts</span>
                <button class="dp-close" type="button" aria-label="Close">✕</button>
            </header>
            <div class="dp-body"></div>
            <div class="dp-compose">
                <div class="dp-chip" hidden>
                    <span class="dp-chip-time"></span>
                    <span class="dp-chip-text"></span>
                    <button class="dp-chip-clear" type="button" aria-label="Clear selection">✕</button>
                </div>
                <textarea class="dp-input" rows="3" placeholder="Ask about this lecture…"></textarea>
                <div class="dp-actions">
                    <span class="dp-hint">⏎ to send</span>
                    <div class="dp-btns">
                        <button class="dp-flag-btn" type="button" disabled>⚑ Flag only</button>
                        <button class="btn-primary dp-send" type="button">Ask</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(panel);

        body     = panel.querySelector(".dp-body");
        chip     = panel.querySelector(".dp-chip");
        chipTime = panel.querySelector(".dp-chip-time");
        chipText = panel.querySelector(".dp-chip-text");
        input    = panel.querySelector(".dp-input");
        flagBtn  = panel.querySelector(".dp-flag-btn");

        bubble.addEventListener("click", () => (panel.classList.contains("open") ? close() : open()));
        panel.querySelector(".dp-close").addEventListener("click", close);
        panel.querySelector(".dp-chip-clear").addEventListener("click", clearHeld);
        panel.querySelector(".dp-send").addEventListener("click", send);
        flagBtn.addEventListener("click", () => { addFlag(input.value.trim() || null); input.value = ""; render(); });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && panel.classList.contains("open")) close();
        });

        // It's a popup now, so clicking away should dismiss it — but not while
        // you're sweeping a selection in the transcript underneath.
        document.addEventListener("pointerdown", (e) => {
            if (!panel.classList.contains("open")) return;
            if (panel.contains(e.target) || bubble.contains(e.target)) return;
            close();
        });

        // Saving or discarding both end the lecture, so the doubts go with it.
        // On save they've already been written to the DB and show up in My
        // Lectures; on discard they're dropped along with the transcript.
        const reset = () => { flags.length = 0; clearHeld(); render(); };
        window.addEventListener("transcript:saved", reset);
        window.addEventListener("transcript:discarded", reset);

        render();
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
    }

    // save-transcript.js reads this when writing the lecture. Transient asks (no
    // selection) aren't anchored to a moment, so they aren't persisted.
    return {
        getFlags: () => flags
            .filter((f) => !f.transient && f.t_start != null)
            .map(({ t_start, t_end, quote, question, answer }) => ({ t_start, t_end, quote, question, answer })),
        open,
        close,
    };
})();

window.DoubtPanel = DoubtPanel;
