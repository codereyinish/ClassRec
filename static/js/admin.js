// Admin dashboard — reads /admin/data and draws it.
//
// The page is served to anyone who types /admin; only the data behind it is
// gated. So the frame stays hidden until the fetch comes back 200, and a 404 —
// which is what a non-admin gets — shows the same "nothing here" a wrong URL
// would. Nothing about what the page contains is decided in the browser.

const $ = (id) => document.getElementById(id);

/* Same shape as lectures.js: the token is attached in one place rather than at
   each call site, and getToken() is asked each time because Clerk's tokens last
   about a minute and the SDK mints a fresh one from the session cookie. */
async function authHeaders() {
    try {
        const t = window.Clerk && window.Clerk.session
            ? await window.Clerk.session.getToken() : null;
        return t ? { Authorization: 'Bearer ' + t } : {};
    } catch { return {}; }
}

// ===== FORMATTING =====

/* Durations read as hours and minutes past an hour, and as minutes and seconds
   below one. "0h 4m" is how a machine says four minutes. */
function dur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60)    return sec + "s";
    if (sec < 3600)  return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h + "h " + m + "m";
}

function hours(sec) {
    const h = (sec || 0) / 3600;
    return h >= 10 ? Math.round(h) + "h" : h >= 1 ? h.toFixed(1) + "h" : Math.round((sec || 0) / 60) + "m";
}

// Stored as "YYYY-MM-DD HH:MM:SS" UTC, same as everywhere else in the app.
function parseTs(s) {
    if (!s) return null;
    const d = new Date(s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z"));
    return isNaN(d) ? null : d;
}

function ago(s) {
    const d = parseTs(s);
    if (!d) return "";
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1)     return "just now";
    if (mins < 60)    return mins + "m ago";
    if (mins < 1440)  return Math.round(mins / 60) + "h ago";
    const days = Math.round(mins / 1440);
    return days < 30 ? days + "d ago" : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function shortDate(s) {
    const d = parseTs(s);
    return d ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : "—";
}

function dayLabel(iso) {
    const d = new Date(iso + "T00:00:00Z");
    return isNaN(d) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ===== TOOLTIP =====

const tip = $("tip");
function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.style.left = x + "px";
    tip.style.top  = y + "px";
    tip.classList.add("on");
}
const hideTip = () => tip.classList.remove("on");
/* Fixed to the viewport, so scrolling moves the chart out from under it and
   leaves it hanging over whatever arrives next. mouseleave does not fire for a
   pointer that never moved. */
addEventListener("scroll", hideTip, { passive: true });

// ===== ACTIVITY: 30 days, two series, stacked =====

/* Stacked rather than side by side. Both series count the same thing — events —
   so the stack has a meaning the pair of bars would not, and at 30 days a pair
   of bars is two 4px slivers. The 2px gap between segments is what keeps the
   stack legible when both are 1.

   Drawn as SVG rather than divs because the axis and the gridlines have to line
   up with the bars, and a viewBox does that arithmetic once. */
function drawActivity(series) {
    const wrap = $("activityWrap");
    const total = series.reduce((a, d) => a + d.signup + d.upgrade, 0);

    if (!total) {
        wrap.innerHTML = '<div class="empty">Nothing in the last 30 days.<br>' +
                         'A new account or a Pro request will show up here.</div>';
        return;
    }

    // padR exists so the last column's bar has somewhere to sit. Without it the
    // thirtieth bar is centred on the viewBox edge and loses its right half.
    const W = 560, H = 186, padL = 26, padR = 8, padB = 22, padT = 8;
    const plotW = W - padL - padR, plotH = H - padB - padT;
    const peak  = Math.max(1, ...series.map((d) => d.signup + d.upgrade));
    // A whole number of rows, so the gridline labels are never "1.5 events".
    const top   = Math.max(1, Math.ceil(peak));
    const step  = plotW / series.length;
    const barW  = Math.min(13, step - 3);
    const y     = (v) => padT + plotH - (v / top) * plotH;

    const ticks = top <= 4 ? Array.from({ length: top + 1 }, (_, i) => i)
                           : [0, Math.round(top / 2), top];

    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Accounts created and Pro requests per day, last 30 days">`;

    // recessive grid, drawn under everything
    svg += `<g class="axis">`;
    for (const t of ticks) {
        svg += `<line class="grid-line" x1="${padL}" y1="${y(t)}" x2="${W - padR}" y2="${y(t)}"/>`
             + `<text x="${padL - 7}" y="${y(t) + 3.5}" text-anchor="end">${t}</text>`;
    }
    svg += `</g>`;

    series.forEach((d, i) => {
        const x  = padL + i * step + (step - barW) / 2;
        const gap = (d.signup && d.upgrade) ? 2 : 0;   // surface gap between fills
        let cursor = padT + plotH;

        // upgrade sits on top of signup, so it keeps the rounded end
        const segs = [
            { v: d.signup,  c: "var(--s-signup)"  },
            { v: d.upgrade, c: "var(--s-upgrade)" },
        ].filter((s) => s.v > 0);

        svg += `<g class="col">`;
        segs.forEach((s, si) => {
            const h = (s.v / top) * plotH - (si ? gap : 0);
            const yy = cursor - h;
            cursor = yy - (si === 0 ? gap : 0);
            const isTop = si === segs.length - 1;
            svg += `<rect class="bar" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" `
                 + `width="${barW.toFixed(1)}" height="${Math.max(2, h).toFixed(1)}" `
                 + `rx="${isTop ? 4 : 0}" fill="${s.c}"/>`;
        });
        // hit target spans the full column height, so the tooltip is reachable
        // on a day with one event without aiming at a 3px bar
        svg += `<rect class="hit" x="${(padL + i * step).toFixed(1)}" y="${padT}" `
             + `width="${step.toFixed(1)}" height="${plotH}" `
             + `data-i="${i}"/></g>`;
    });

    // month ends, not every day — 30 labels would collide
    svg += `<g class="axis">`;
    [0, Math.floor(series.length / 2), series.length - 1].forEach((i) => {
        const anchor = i === 0 ? "start" : i === series.length - 1 ? "end" : "middle";
        const x = padL + i * step + step / 2;
        svg += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${dayLabel(series[i].day)}</text>`;
    });
    svg += `</g></svg>`;

    wrap.innerHTML = svg;

    wrap.querySelectorAll(".hit").forEach((el) => {
        el.addEventListener("mousemove", (ev) => {
            const d = series[+el.dataset.i];
            const rows = [
                ["var(--s-signup)",  "New account",  d.signup],
                ["var(--s-upgrade)", "Asked for Pro", d.upgrade],
            ].filter(([, , v]) => v > 0);
            const body = rows.length
                ? rows.map(([c, k, v]) =>
                    `<span class="tr"><i class="sw" style="background:${c}"></i>${k}<b>${v}</b></span>`).join("")
                : `<span class="tr">Nothing</span>`;
            showTip(`<span class="td">${dayLabel(d.day)}</span>${body}`, ev.clientX, ev.clientY);
        });
        el.addEventListener("mouseleave", hideTip);
    });
}

// ===== RECORDED TIME, BY ACCOUNT =====

/* One series, so no legend — the panel title names it. Built from HTML rather
   than SVG because every row carries a Clerk id that has to truncate, wrap and
   be selectable, and text in SVG does none of those. */
function drawRank(people) {
    const wrap = $("rankWrap");
    const rows = people
        .map((p) => ({ ...p, total: p.live_seconds + p.upload_seconds }))
        .filter((p) => p.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);

    if (!rows.length) {
        wrap.innerHTML = '<div class="empty">No recorded time yet.</div>';
        return;
    }

    const peak = Math.max(...rows.map((r) => r.total));
    wrap.innerHTML = '<div class="rank">' + rows.map((r) => `
        <div>
          <div class="rk-top">
            <span class="rk-id" title="${esc(r.clerk_user_id)}">${esc((r.clerk_user_id || "").slice(0, 18))}…</span>
            <span class="rk-v">${dur(r.total)}</span>
          </div>
          <div class="rk-track"><div class="rk-fill" style="width:${Math.max(2, (r.total / peak) * 100).toFixed(1)}%"></div></div>
        </div>`).join("") + "</div>";
}

// ===== TABLE + FEED =====

function drawPeople(people) {
    const body = $("peopleBody");
    if (!people.length) {
        body.innerHTML = '<tr><td colspan="6" style="color:var(--g6)">No accounts yet.</td></tr>';
        return;
    }
    body.innerHTML = people.map((p) => `
        <tr>
          <td><span class="rk-id" title="${esc(p.clerk_user_id)}">${esc(p.clerk_user_id)}</span></td>
          <td><span class="pill${p.plan === "free" ? "" : " pro"}">${esc(p.plan)}</span></td>
          <td class="t-num n">${dur(p.live_seconds)}</td>
          <td class="t-num n">${dur(p.upload_seconds)}</td>
          <td class="t-num n">${p.lectures}</td>
          <td class="t-num n">${shortDate(p.created_at)}</td>
        </tr>`).join("");
}

function drawFeed(feed) {
    const el = $("feed");
    if (!feed.length) {
        el.innerHTML = '<li style="color:var(--g6);font-size:13.5px">Nothing yet.</li>';
        return;
    }
    el.innerHTML = feed.map((s) => {
        const isPro = s.kind === "upgrade_attempt";
        return `<li>
          <i class="dot" style="background:${isPro ? "var(--s-upgrade)" : "var(--s-signup)"}"></i>
          <span class="what">${isPro ? "Asked for Pro" : "New account"}</span>
          <span class="who">${esc((s.clerk_user_id || "—").slice(0, 16))}…</span>
          <time>${ago(s.created_at)}</time>
        </li>`;
    }).join("");
}

// ===== LOAD =====

async function load() {
    const res = await fetch("/admin/data", { headers: await authHeaders() });
    if (!res.ok) { $("dash").hidden = true; $("locked").hidden = false; return; }

    const d = await res.json();
    $("locked").hidden = true;
    $("dash").hidden = false;

    const recorded = d.people.reduce((a, p) => a + p.live_seconds + p.upload_seconds, 0);
    $("kUsers").textContent    = d.totals.users;
    $("kUsers7").textContent   = d.totals.users_7d;
    $("kPro").textContent      = d.totals.pro_requests;
    $("kPro7").textContent     = d.totals.pro_requests_7d;
    $("kLectures").textContent = d.totals.lectures;
    $("kHours").textContent    = hours(recorded);
    $("genAt").textContent     = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    drawActivity(d.series);
    drawRank(d.people);
    drawPeople(d.people);
    drawFeed(d.feed);
}

/* Clerk's script tag is async, so window.Clerk may not exist yet when this runs.
   Elsewhere the app awaits window.__clerk_loaded, but nothing in the codebase
   ever assigns that — it is undefined, and awaiting undefined resolves at once.
   The other pages survive it because an anonymous request there just shows less;
   here it would send the first fetch without a token, take the 404 meant for
   strangers, and lock the admin out of their own dashboard. So: wait for the
   object to actually appear, and give up after a bounded time rather than
   hanging on a page that will never have Clerk. */
async function waitForClerk(ms = 8000) {
    const started = Date.now();
    while (!window.Clerk && Date.now() - started < ms) {
        await new Promise((r) => setTimeout(r, 60));
    }
    if (!window.Clerk) return false;
    try { await window.Clerk.load(); } catch {}
    return true;
}

window.addEventListener("load", async () => {
    await waitForClerk();
    load();
    $("refreshBtn").addEventListener("click", load);
});
