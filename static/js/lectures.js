// My Lectures — browse + read saved transcripts.
//   GET    /sessions           -> list (id, title, preview, created_at)
//   GET    /sessions/{id}      -> full transcript
//   DELETE /sessions/{id}      -> remove

const listEl   = document.getElementById("lecturesList");
const detailEl = document.getElementById("lectureDetail");

function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s.replace(" ", "T") + "Z");   // stored as "YYYY-MM-DD HH:MM:SS" UTC
    return isNaN(d) ? s : d.toLocaleString([], {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
}

// ---- LIST ----
async function loadList() {
    detailEl.hidden = true;
    listEl.hidden = false;
    listEl.innerHTML = `<div class="lectures-empty">Loading…</div>`;
    let sessions = [];
    try {
        sessions = await (await fetch("/sessions")).json();
    } catch {
        listEl.innerHTML = `<div class="lectures-empty">Could not load lectures.</div>`;
        return;
    }
    if (!sessions.length) {
        listEl.innerHTML = `<div class="lectures-empty">No saved lectures yet — record one and hit 💾 Save.</div>`;
        return;
    }
    listEl.innerHTML = "";
    sessions.forEach((s) => {
        const card = document.createElement("div");
        card.className = "lecture-card";
        card.innerHTML = `
            <div class="lecture-card-main">
                <div class="lecture-card-title">${escapeHtml(s.title)}</div>
                <div class="lecture-card-date">${fmtDate(s.created_at)}</div>
                <div class="lecture-card-preview">${escapeHtml(s.preview || "")}…</div>
            </div>
            <button class="lecture-card-del" title="Delete">🗑️</button>`;
        card.querySelector(".lecture-card-main").addEventListener("click", () => openDetail(s.id));
        card.querySelector(".lecture-card-del").addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${s.title}"?`)) return;
            await fetch(`/sessions/${s.id}`, { method: "DELETE" });
            loadList();
        });
        listEl.appendChild(card);
    });
}

// ---- DETAIL ----
async function openDetail(id) {
    let s;
    try {
        const res = await fetch(`/sessions/${id}`);
        if (!res.ok) return;
        s = await res.json();
    } catch { return; }
    document.getElementById("detailTitle").textContent = s.title;
    document.getElementById("detailDate").textContent = fmtDate(s.created_at);
    document.getElementById("detailTranscript").textContent = s.transcript || "(empty)";
    listEl.hidden = true;
    detailEl.hidden = false;
    window.scrollTo(0, 0);
}

document.getElementById("lectureBack").addEventListener("click", loadList);

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

loadList();
