// My Lectures — browse + read saved transcripts.
//   GET    /sessions           -> list (id, title, preview, created_at)
//   GET    /sessions/{id}      -> full transcript
//   DELETE /sessions/{id}      -> remove

const listEl   = document.getElementById("lecturesList");
const detailEl = document.getElementById("lectureDetail");

/* Every call to our server goes through here so the token is attached in one
   place rather than at each call site. getToken() is asked each time rather than
   cached: Clerk's tokens last about a minute, and the SDK hands back the current
   one or quietly mints a fresh one from the session cookie.

   Without it these requests arrive anonymous, and a lecture list filtered by
   user_id is empty for everyone — which is what this page showed. */
async function authHeaders() {
    try {
        const t = window.Clerk && window.Clerk.session
            ? await window.Clerk.session.getToken() : null;
        return t ? { Authorization: 'Bearer ' + t } : {};
    } catch { return {}; }
}

async function api(path, opts = {}) {
    const auth = await authHeaders();
    return fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...auth } });
}

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
        sessions = await (await api("/sessions")).json();
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
            await api(`/sessions/${s.id}`, { method: "DELETE" });
            loadList();
        });
        listEl.appendChild(card);
    });
}

// ---- DETAIL ----
async function openDetail(id) {
    let s;
    try {
        const res = await api(`/sessions/${id}`);
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

/* That first call runs before Clerk has finished loading, so it goes out without
   a token and comes back empty — which is what this page showed. The load event
   waits for the async Clerk script, so the SDK is present by here, and its
   listener fires with the current state and again whenever the signed in user
   changes. load() is auth.js's to call; this only listens for the result.

   The detail view is left alone: re-running while someone is reading a lecture
   would throw them back to the list. */
window.addEventListener("load", () => {
    if (!window.Clerk) return;
    window.Clerk.addListener(() => { if (!listEl.hidden) loadList(); });
});
