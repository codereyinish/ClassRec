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

    // ---- selection capture ----
    // Only spans carrying timestamps count. A selection that hits none (the
    // plain-text fallback live.js uses when Whisper returns no words) can't be
    // anchored to a moment, so the bubble simply doesn't arm.
    function wireSelection() {
        const host = document.getElementById("transcriptContent");
        if (!host) return;

        host.addEventListener("mouseup", () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return;   // a plain click keeps what's held

            const words = Array.from(host.querySelectorAll("span.word"))
                .filter((w) => sel.containsNode(w, true));
            if (!words.length) return;

            held = {
                quote: (sel.toString().trim() || words.map((w) => w.textContent).join(" ")).trim(),
                t_start: parseFloat(words[0].dataset.start),
                t_end: parseFloat(words[words.length - 1].dataset.end),
            };
            bubble.classList.add("armed");
        });
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
        renderChip();
        render();
        input.focus();
    }
    function close() {
        panel.classList.remove("open");
        panel.setAttribute("aria-hidden", "true");
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
        bubble.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.8-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>
                <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.8c0 1.6-2.4 2.4-2.4 2.4"/>
                <line x1="12" y1="16.2" x2="12" y2="16.2"/>
            </svg>
            <span class="dp-bubble-dot"></span>`;
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

        // A saved transcript resets the page, so the doubts go with it.
        window.addEventListener("transcript:saved", () => {
            flags.length = 0;
            clearHeld();
            render();
        });

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
