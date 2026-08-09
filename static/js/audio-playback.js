// audio-playback.js — the listenable copy of a lecture
// Handles: playback transport, the waveform, drag-scrub, jump-to-latest, and
// building the WAV blob the player reads.
// Depends on live.js, which loads first.
/* ── playback : audio-playback.js ─────────────────────────────────────────────
   Scrolling waveform player and word-audio sync, carried over from
   static/js/audio-playback.js with its names, constants and structure intact.
   Fixed playhead at center; waveform slides smoothly underneath via sub-pixel
   translate. Depends on buildWavUrl / window.recordingBlob / window.recordingUrl
   above, exactly as it depends on live.js today.

   Two things differ, both forced by where it now lives. The colours are this
   page's indigo rather than the current page's green on black. And the strip is
   34px tall, which the ruler cannot share — the elapsed readout beside it says
   the time instead, so TICK_INTERVAL and the label colours are not carried. */

// ===== CONSTANTS =====
const BARS_PER_SEC  = 12;   // data resolution — bars per second of audio
const BAR_W         = 3;    // pixels wide per bar
const BAR_GAP       = 2;    // pixels gap between bars
const STEP          = BAR_W + BAR_GAP;  // 4px per bar slot

// While recording, "now" is the newest bar and there is nothing after it, so a
// centred playhead leaves the right half of the strip empty. Anchored near the
// right instead, audio enters on the right and the history slides left, held
// LIVE_INSET off the edge so the playhead is a line rather than a sliver on the
// border. Playback goes back to centre, where seeing what is ahead of the
// playhead is the point of the strip.
//
// It keys off the recording state, not the live loop: scrubbing stops the loop,
// and the anchor must not jump under the cursor when it does.
const LIVE_INSET = 14;
const anchorX = (W) => (B.classList.contains('rec') ? W - LIVE_INSET : W / 2);

/* Speech peaks around 0.05–0.3 of full scale, so drawing amplitude straight to
   pixels pins nearly every bar to the floor and the strip looks flat whatever
   was said. Loudness is perceived closer to a power law than a linear one, which
   is why meters are drawn on a curve: 0.05 lifts to about a fifth of the height,
   0.3 to just over half, and the difference between a word and a pause becomes
   visible. Peaks near full scale still reach the top, so nothing is invented —
   the same numbers are simply spread over the height instead of the bottom
   tenth of it. Genuinely silent audio still draws flat, which is worth knowing
   rather than hiding. */
const barScale = (amp) => Math.pow(Math.min(1, amp), 0.55);

/* Read from the stylesheet rather than written here, so switching theme moves
   the waveform with everything else. Cached because this is per-frame drawing;
   readWaveColors() runs again when the theme changes. */
let COLOR_PLAYED, COLOR_UNPLAYED, COLOR_PLAYHEAD;
function readWaveColors(){
  const s=getComputedStyle(document.documentElement);
  COLOR_PLAYED   = s.getPropertyValue('--wave-played').trim();
  COLOR_UNPLAYED = s.getPropertyValue('--wave-unplayed').trim();
  COLOR_PLAYHEAD = s.getPropertyValue('--wave-head').trim();
}
readWaveColors();

// ===== STATE =====
let waveformBars  = null;
let decodedBuffer = null;
let rafId         = null;

// ===== DOM REFS =====
const audioEl      = document.getElementById('recAudio');
const audioPanel   = document.getElementById('audioBar');
const canvas       = document.getElementById('wv');
const playPauseBtn = document.getElementById('pl');
const timeDisplay  = document.getElementById('plAt');
const durDisplay   = document.getElementById('plDur');


// ===== PANEL =====
function showAudioPanel() {
    if (!window.recordingUrl) return;
    audioEl.src = window.recordingUrl;
    audioPanel.hidden = false;
    requestAnimationFrame(() => initWaveform());
}


// ===== WAVEFORM INIT =====
async function initWaveform() {
    if (!window.recordingBlob) return;

    const r = devicePixelRatio || 1;
    canvas.width  = canvas.clientWidth * r;
    canvas.height = canvas.clientHeight * r;
    canvas.getContext('2d').setTransform(r, 0, 0, r, 0, 0);

    const arrayBuf    = await window.recordingBlob.arrayBuffer();
    const actx        = new AudioContext();
    await actx.resume();
    decodedBuffer     = await actx.decodeAudioData(arrayBuf);
    await actx.close();

    // One bar = 1/BARS_PER_SEC seconds of audio; store peak amplitude per bar
    const rawData      = decodedBuffer.getChannelData(0);
    const sr           = decodedBuffer.sampleRate;
    const samplesPerBar= Math.max(1, Math.floor(sr / BARS_PER_SEC));
    const numBars      = Math.ceil(rawData.length / samplesPerBar);
    waveformBars       = new Float32Array(numBars);

    for (let i = 0; i < numBars; i++) {
        let peak = 0;
        const start = i * samplesPerBar;
        const end   = Math.min(start + samplesPerBar, rawData.length);
        for (let j = start; j < end; j++) {
            const a = Math.abs(rawData[j]);
            if (a > peak) peak = a;
        }
        waveformBars[i] = peak;
    }

    durDisplay.textContent = mmss(Math.round(decodedBuffer.duration));   // same format as Length
    drawWaveform(audioEl.currentTime);
}


// ===== WAVEFORM DRAW =====
// Sub-pixel smooth scrolling:
//   world-x of bar i  = i * STEP
//   world-x of center = currentTime * BARS_PER_SEC * STEP
//   canvas-x of bar i = world-x - leftWorld  (before fractional shift)
// We ctx.translate(-fracPart, 0) so the canvas slides by less than 1px per frame → smooth.
function drawWaveform(currentTime) {
    const ctx     = canvas.getContext('2d');
    const W       = canvas.clientWidth;
    const H       = canvas.clientHeight;
    const PAD_V   = 4;        // top/bottom padding inside waveform zone
    const centerX = anchorX(W);

    ctx.clearRect(0, 0, W, H);
    // decodedBuffer is absent while the lecture is still running — the bars are
    // being accumulated live at that point, and are just as drawable.
    if (!waveformBars || !waveformBars.length) return;

    // Exact world pixel position of current time
    const centerWorld = currentTime * BARS_PER_SEC * STEP;
    const leftWorld   = centerWorld - centerX;
    const fracPart    = leftWorld - Math.floor(leftWorld);

    // Sub-pixel translate so bars don't jump by whole pixels
    ctx.save();
    ctx.translate(-fracPart, 0);

    const firstBar = Math.floor(leftWorld / STEP);
    const lastBar  = Math.ceil((leftWorld + W + STEP) / STEP);
    const curBarF  = currentTime * BARS_PER_SEC;  // fractional bar index = playhead

    for (let i = firstBar; i <= lastBar; i++) {
        if (i < 0 || i >= waveformBars.length) continue;
        // Nothing is drawn past the playhead while recording: there is no audio
        // after "now", and the few bars that fitted in the inset read as a stray
        // dash floating beyond the line.
        if (B.classList.contains('rec') && i > curBarF) continue;
        const x    = i * STEP - Math.floor(leftWorld);
        const amp  = waveformBars[i];
        const maxBarH = H - PAD_V * 2;
        const barH    = Math.max(2, barScale(amp) * maxBarH);
        ctx.fillStyle = i < curBarF ? COLOR_PLAYED : COLOR_UNPLAYED;
        ctx.fillRect(x, PAD_V + (maxBarH - barH) / 2, BAR_W, barH);
    }

    ctx.restore();

    // --- Playhead: a full-height bar in the lock indigo. Weight alone carries it
    // against 3px bars; the pin head that was here read as a map marker.
    ctx.fillStyle = COLOR_PLAYHEAD;
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(centerX - 1.5, 0, 3, H, 1.5);
        ctx.fill();
    } else {
        ctx.fillRect(centerX - 1.5, 0, 3, H);
    }

    timeDisplay.textContent = formatTime(currentTime);
}

// Full format for main display: m:ss.xx
function formatTime(sec) {
    if (sec < 0) sec = 0;
    const m  = Math.floor(sec / 60);
    const s  = Math.floor(sec % 60).toString().padStart(2, '0');
    const ms = Math.floor((sec % 1) * 100).toString().padStart(2, '0');
    return `${m}:${s}.${ms}`;
}

// Short format for the duration: m:ss
function formatTimeTick(sec) {
    if (sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}


// ===== LIVE WAVEFORM =====
// The strip is up from the first second rather than only after stop, so the
// lecture is visibly being captured. Peaks accumulate into the same array
// initWaveform builds, at the same BARS_PER_SEC, so nothing changes shape when
// the recording ends — the bars are simply recomputed exactly from the WAV.
//
// The bar boundary is carried as a float (16000/12 = 1333.33 samples). Rounding
// it would drift about a second over an hour and slide the waveform out of step
// with the word timings by the end of a lecture.
// Evaluated when called, not at load: SR is declared further down, and reading it
// up here is a temporal-dead-zone error that kills the rest of the script.
const liveSamplesPerBar = () => SR / BARS_PER_SEC;
let liveBars = [], liveSamples = 0, barPeak = 0, barBoundary = 0, liveRaf = null;

function feedLiveWave(float32) {
    for (let i = 0; i < float32.length; i++) {
        const a = Math.abs(float32[i]);
        if (a > barPeak) barPeak = a;
        liveSamples++;
        if (liveSamples >= barBoundary) {
            liveBars.push(barPeak);
            barPeak = 0;
            barBoundary += liveSamplesPerBar();
        }
    }
}

function startLiveWave() {
    liveBars = []; liveSamples = 0; barPeak = 0; barBoundary = liveSamplesPerBar();
    waveformBars = liveBars;      // drawWaveform reads this either way
    decodedBuffer = null;
    audioPanel.hidden = false;
    const r = devicePixelRatio || 1;
    canvas.width  = canvas.clientWidth * r;
    canvas.height = canvas.clientHeight * r;
    canvas.getContext('2d').setTransform(r, 0, 0, r, 0, 0);
    resumeLiveWave();
}

// Following the live edge again after playback let go of the strip. Separate
// from startLiveWave so replaying part of a lecture mid-lecture does not throw
// away the bars already drawn.
/* Capture runs on the main thread — createScriptProcessor, as live.js uses — so
   anything drawing at 60fps competes with it for the same thread and a missed
   callback is a dropped audio frame, heard as a click. The existing app draws
   nothing while recording and never had to share.
   20fps is smooth for a waveform and leaves four frames in five for audio. */
const DRAW_MS = 50;
let lastDraw = 0;
function dueToDraw(now) {
    if (now - lastDraw < DRAW_MS) return false;
    lastDraw = now;
    return true;
}

function resumeLiveWave() {
    stopLiveWave();
    /* Hand the strip back to the live bars. Playing something repoints
       waveformBars at the peaks decoded from that clip and sets decodedBuffer,
       so without this the strip keeps drawing the finished clip while the
       playhead is put at the live edge — off the end of what is being drawn,
       which looks like an empty strip with the line stuck at the right. */
    waveformBars  = liveBars;
    decodedBuffer = null;          // the live edge is the length again, not the clip
    (function loop(now) {
        if (dueToDraw(now || 0)) {
            const t = liveSamples / SR;   // playhead sits at the live edge
            drawWaveform(t);
            timeDisplay.textContent = formatTime(t);
        }
        liveRaf = requestAnimationFrame(loop);
    })(performance.now());
}

function stopLiveWave() {
    if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = null; }
}


// ===== SYNC LOOP =====
let lastActiveSpan = null;

// ===== WORD INDEX =====
// Built once when playback starts rather than re-derived from the DOM every
// frame. Two Float64Arrays hold each word's start/end so the loop can go
// straight to the right word instead of testing all of them.
let idxSpans = [];
let idxStart = null;
let idxEnd   = null;
let cursor   = 0;       // word the previous frame landed on
let litIndex = -1;      // word currently carrying .active
let lastT    = -1;      // previous frame's time, used to spot a seek

function buildWordIndex() {
    idxSpans = Array.prototype.slice.call(document.querySelectorAll('.stream span.word'));
    const n  = idxSpans.length;
    idxStart = new Float64Array(n);
    idxEnd   = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        idxStart[i] = parseFloat(idxSpans[i].dataset.start);
        idxEnd[i]   = parseFloat(idxSpans[i].dataset.end);
    }
    // Adopt whatever is already highlighted, so resuming from pause doesn't flicker.
    litIndex = idxSpans.findIndex(s => s.classList.contains('active'));
    cursor   = litIndex >= 0 ? litIndex : 0;
    lastT    = -1;      // forces a seek resolution on the first tick
}

// Words are in time order, so a jump can halve the list instead of walking it —
// 8,000 words resolves in ~13 comparisons.
function seekIndex(t) {
    let lo = 0, hi = idxStart.length - 1, best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (idxStart[mid] <= t) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return best;
}

function startSyncLoop() {
    stopSyncLoop();
    buildWordIndex();

    function tick(now) {
        const t = audioEl.currentTime;
        // Word highlighting stays per-frame — it is a class swap. Redrawing the
        // canvas is the expensive part, and it shares a thread with capture.
        if (dueToDraw(now || performance.now())) drawWaveform(t);

        const n = idxSpans.length;
        if (n) {
            // A jump of more than a second means the user seeked; otherwise the
            // audio only crept forward, so step on from where we were — which at
            // 60fps is almost always zero or one step.
            if (lastT < 0 || Math.abs(t - lastT) > 1) cursor = seekIndex(t);
            else while (cursor < n - 1 && t > idxEnd[cursor]) cursor++;
            lastT = t;

            // Between words, leave the previous one lit. Only the outgoing and
            // incoming spans are ever touched.
            if (t >= idxStart[cursor] && t <= idxEnd[cursor] && cursor !== litIndex) {
                if (litIndex >= 0) idxSpans[litIndex].classList.remove('active');
                idxSpans[cursor].classList.add('active');
                litIndex       = cursor;
                lastActiveSpan = idxSpans[cursor];
                idxSpans[cursor].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
}

function stopSyncLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}


// ===== CONTROLS =====
playPauseBtn.addEventListener('click', () => {
    if (audioEl.paused) {
        // built here rather than on every click: pausing used to rebuild too,
        // which revoked the URL the element was in the middle of playing
        if (!buildWavUrl() && !window.recordingUrl) return;   // nothing captured yet
        stopLiveWave();          // the playhead is the user's now, not the live edge
        /* buildWavUrl revokes the URL it replaces, so a source set on an earlier
           press points at a blob that no longer exists — the browser cannot load
           it, play() fails quietly, and the playhead never moves. Whenever the
           copy has been rebuilt, the source is replaced and the position carried
           across, since assigning src winds it back to zero. */
        if (audioEl.src !== window.recordingUrl) { playFrom(audioEl.currentTime || 0); return; }
        audioEl.play();
        playPauseBtn.textContent = '⏸';
        startSyncLoop();
    } else {
        audioEl.pause();
        playPauseBtn.textContent = '▶';
        stopSyncLoop();
        // Keep last word lit while paused
        if (lastActiveSpan) lastActiveSpan.classList.add('active');
        if (B.classList.contains('rec')) resumeLiveWave();   // still recording
    }
});

audioEl.addEventListener('ended', () => {
    /* What was played was a copy of the lecture as it stood when play was
       pressed, so reaching its end is not reaching the end of the lecture --
       the lecture kept going while you listened. If it has grown past where
       this copy stopped, take a fresh one and carry on from the same second.
       That repeats for as long as there is more, so playback follows the
       recording instead of stopping short of it.

       Each hand-over costs a beat, because the source is being reloaded. Gapless
       would mean feeding one stream through MediaSource rather than replacing a
       file, which is a different piece of work. */
    if (B.classList.contains('rec')) {
        const at   = audioEl.currentTime;
        const live = liveSamples / SR;
        if (live > at + 0.35) { playFrom(at); return; }   // more lecture exists
        // caught up with the microphone: the strip belongs to the live edge again
        playPauseBtn.textContent = '▶';
        stopSyncLoop();
        if (lastActiveSpan) lastActiveSpan.classList.add('active');
        resumeLiveWave();
        return;
    }

    playPauseBtn.textContent = '▶';
    stopSyncLoop();
    if (decodedBuffer) drawWaveform(decodedBuffer.duration);
    // Keep last word lit after playback ends
    if (lastActiveSpan) lastActiveSpan.classList.add('active');
});

/* The strip is a canvas, so its backing store has to be told the size its CSS box
   has become — and the box changes without the window changing at all: opening
   the AI panel or the rail narrows .main, and the transition means it changes
   over a third of a second rather than at once. Listening for window resize
   missed every one of those, so the canvas kept drawing at its old width and the
   bars scattered.

   A bar is a fixed slice of TIME, not of width, so nothing has to be recomputed
   here — measure, then redraw whatever is current. */
function fitCanvas() {
    if (audioPanel.hidden) return;
    const r = devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width === Math.round(w * r) && canvas.height === Math.round(h * r)) return;
    canvas.width  = w * r;
    canvas.height = h * r;
    canvas.getContext('2d').setTransform(r, 0, 0, r, 0, 0);
    drawWaveform(liveRaf ? liveSamples / SR : audioEl.currentTime);
}
if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe(canvas);
addEventListener('resize', fitCanvas);

// ===== SEEK =====
// Click on canvas: offset from center → time delta
/* ===== DRAG SCRUB =====
   Hold the strip and pull: the recording slides under a fixed playhead, back
   towards 0:00 as you drag left, and the time you are over rides above the
   playhead. Let go and playback carries on from there.

   Capture never pauses for any of this. onaudioprocess keeps appending to
   pcmBlob and to the bars, and the session clock keeps counting, so a lecture
   examined at minute 2 while it is at minute 9 loses nothing — rejoining the
   live edge shows every bar that arrived meanwhile. */
/* Held, it shuttles rather than tracks: how far the cursor sits from where it
   went down sets the speed, and it keeps winding at that speed until you move or
   let go — so reaching minute 2 of a long lecture does not mean dragging the
   width of the strip. Push right and the recording runs forward, which slides
   the waveform left, against the cursor.
   SHUTTLE_PX is the displacement worth one second of audio per second. */
const SHUTTLE_PX = 22, SHUTTLE_MAX = 60;   // cap so a flick does not fly to the end
let dragging = false, dragStartX = 0, dragStartT = 0, dragT = 0, dragMoved = false;
let shuttleDX = 0, shuttleRaf = null, shuttleLast = 0;

function shuttleStep(now) {
    if (!dragging) return;
    const dt = Math.min(0.1, (now - shuttleLast) / 1000);   // a stall must not lurch
    shuttleLast = now;
    const captured = decodedBuffer ? decodedBuffer.duration : liveSamples / SR;
    const rate = Math.max(-SHUTTLE_MAX, Math.min(SHUTTLE_MAX, shuttleDX / SHUTTLE_PX));
    dragT = Math.max(0, Math.min(captured, dragT + rate * dt));
    // Time still advances every frame — only the drawing is rationed, so the
    // shuttle stays smooth while the microphone keeps its share of the thread.
    if (dueToDraw(now)) {
        drawWaveform(dragT);
        const rect = canvas.getBoundingClientRect();
        wvTime.hidden = false;
        wvTime.textContent = formatTimeTick(dragT);
        wvTime.style.left = (canvas.offsetLeft + anchorX(rect.width)) + 'px';
    }
    shuttleRaf = requestAnimationFrame(shuttleStep);
}
const wvTime = document.getElementById('wvTime');
const pxPerSec = () => BARS_PER_SEC * STEP;

function viewTime() {
    return liveRaf ? liveSamples / SR : audioEl.currentTime;
}

canvas.addEventListener('pointerdown', (e) => {
    const captured = decodedBuffer ? decodedBuffer.duration : liveSamples / SR;
    if (!captured) return;
    dragging = true; dragMoved = false; shuttleDX = 0;
    dragStartX = e.clientX;
    dragStartT = dragT = viewTime();
    canvas.setPointerCapture(e.pointerId);
    stopLiveWave();                    // the playhead answers to the cursor now
    audioEl.pause(); playPauseBtn.textContent = '▶'; stopSyncLoop();
    shuttleLast = performance.now();
    shuttleRaf = requestAnimationFrame(shuttleStep);
});

canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    shuttleDX = e.clientX - dragStartX;
    if (Math.abs(shuttleDX) > 2) dragMoved = true;
});

canvas.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false; shuttleDX = 0;
    if (shuttleRaf) { cancelAnimationFrame(shuttleRaf); shuttleRaf = null; }
    wvTime.hidden = true;
    canvas.releasePointerCapture(e.pointerId);
    if (!dragMoved) return;            // a plain click: the handler below has it
    playFrom(dragT);
});

/* The total is the live length, so clicking it means "take me to now". While
   recording that rejoins the live edge; on a finished recording it is the end. */
durDisplay.addEventListener('click', () => {
    if (audioPanel.hidden) return;
    audioEl.pause(); playPauseBtn.textContent = '▶'; stopSyncLoop();
    if (B.classList.contains('rec')) { resumeLiveWave(); return; }
    if (decodedBuffer) { audioEl.currentTime = decodedBuffer.duration; drawWaveform(decodedBuffer.duration); }
});

/* Play from a point on a recording that may still be growing — the header has to
   be written over whatever pcmBlob holds now, and currentTime cannot be set
   before the browser knows the duration of that new source. */
function playFrom(t) {
    buildWavUrl();
    audioEl.src = window.recordingUrl;
    audioEl.addEventListener('loadedmetadata', () => {
        audioEl.currentTime = Math.min(t, audioEl.duration || t);
        drawWaveform(audioEl.currentTime);
        audioEl.play();
        playPauseBtn.textContent = '⏸';
        startSyncLoop();
    }, { once: true });
}

// Works mid-lecture too: the audio up to this moment already exists in pcmBlob,
// so there is nothing to wait for. Scrubbing takes the strip off the live edge;
// pausing or reaching the end gives it back.
canvas.addEventListener('click', (e) => {
    if (dragMoved) { dragMoved = false; return; }   // that was a drag, not a click
    const captured = decodedBuffer ? decodedBuffer.duration : liveSamples / SR;
    if (!captured) return;                       // nothing recorded yet

    const wasLive = !!liveRaf;
    const rect    = canvas.getBoundingClientRect();
    const clickX  = e.clientX - rect.left;

    // Clicking at the live edge while recording rejoins it. Without this a scrub
    // mid-lecture freezes the strip with no way back to now.
    if (B.classList.contains('rec') && clickX >= anchorX(rect.width)) {
        audioEl.pause(); playPauseBtn.textContent = '▶'; stopSyncLoop();
        resumeLiveWave();
        return;
    }

    // Measured against the anchor actually in use, not a hardcoded centre —
    // otherwise every click on the right-anchored live strip lands
    // half a canvas early.
    const dt      = (clickX - anchorX(rect.width)) / (BARS_PER_SEC * STEP);
    const from    = wasLive ? liveSamples / SR : audioEl.currentTime;
    const newTime = Math.max(0, Math.min(captured, from + dt));

    stopLiveWave();                              // the playhead is the user's now
    if (wasLive || !audioEl.src) {
        buildWavUrl();                           // the lecture so far
        audioEl.src = window.recordingUrl;
        audioEl.addEventListener('loadedmetadata', () => {
            audioEl.currentTime = newTime;
            drawWaveform(newTime);
        }, { once: true });
        return;
    }
    audioEl.currentTime = newTime;
    drawWaveform(newTime);
});

// Click word span → seek and play
document.addEventListener('click', (e) => {
    const span = e.target.closest('.stream span.word');
    if (!span) return;
    const t = parseFloat(span.dataset.start);
    if (isNaN(t)) return;
    buildWavUrl();               // mid-lecture this is the audio so far
    showAudioPanel();
    stopLiveWave();              // stop following the live edge; the user is steering
    audioEl.src = window.recordingUrl;
    audioEl.currentTime = t;
    lastActiveSpan = null;  // reset so stale word doesn't show before first hit
    audioEl.play();
    playPauseBtn.textContent = '⏸';
    startSyncLoop();
});

/* ══ LIVE BACKEND ═══════════════════════════════════════════════════════════════
   Speaks the protocol src/main.py already serves — nothing here asks the server to
   change. Copied from live.js so the wire format matches exactly:

     ws  ws://<api>/ws/transcribe
     →   {type:'context', prompt, tagConfig:{tags,name}}
     →   {type:'enroll_start'} … PCM … {type:'enroll_end'}
     →   {type:'use_saved_voice', voice_id}
     →   binary Int16 PCM, mono, 16 kHz
     ←   {type:'transcription', text, tags[], words:[{w,s,e}]}
     ←   {type:'enroll_success'} | {type:'enroll_failed'} | {type:'error'}

   The mock is served from :8899 while the app runs on :8000, so the host is
   explicit and overridable:  localStorage.classrecApi = 'http://localhost:8000'
   If the server is not up, or the mic is refused, the page falls back to the
   simulation it has always run — a design file should still demo on a plane. */
/* Served by the app itself, so every call is same-origin: relative paths for REST,
   and the socket follows the page's own protocol and host. */
const API='';
const WS_URL=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws/transcribe';
const SR=16000, FRAME=4096;

let ws=null, audioCtx=null, micStream=null, node=null, srcNode=null;
let live=false;                 // true once audio is actually flowing to the server
/* The lecture this recording is filling, as the server named it. Null until the
   server answers the opening message, and again for a page that has not recorded
   anything — which is what tells Save whether there is a row to name. */
let liveSessionId=null;
let enrolling=false;            // mirrors the server's enrolment state
/* The last thing the server said before it hung up. Held because the reason and
   the close arrive as two separate events -- the message explains it, the close
   ends the session -- and the caption has to survive the teardown in between. */
let lastServerError='';
const KEYWORDS={               // same map live.js highlights with
  exam:['exam','midterm','final','quiz','test'],
  assignment:['homework','due','submit','assignment'],
  important:['important','remember this','key concept'],
  attendance:['attendance','sign in','roll call','present'],
  classwork:['classwork','in class'],
};

const setConn=(state,msg)=>{     // one place decides what the rail says about the link
  const el=document.getElementById('conn');
  el.dataset.state=state; el.textContent=msg;
};

async function openSocket(){
  if(ws&&ws.readyState<=1)return ws;
  // fetched before opening, since the first message must carry it
  let wsToken='';
  try{ wsToken = (window.Clerk&&window.Clerk.session)
        ? await window.Clerk.session.getToken() : ''; }catch{}
  return new Promise((resolve,reject)=>{
    let s;
    try{s=new WebSocket(WS_URL);}catch(e){reject(e);return;}
    const fail=()=>{reject(new Error('socket'));};
    s.binaryType='arraybuffer';
    s.onopen=()=>{
      ws=s;setConn('on','Connected');
      /* The token rides in the opening message: a browser cannot put a header on
         a WebSocket handshake, and a query string would put it in every access
         log between here and the server. */
      /* The title goes with the opening message because the server opens the
         lecture's row on receiving it — before there is any transcript to name. */
      s.send(JSON.stringify({type:'context',prompt:lectureContext,
                             tagConfig:alertConfig(),token:wsToken,
                             title:(titleEl.textContent||'').trim()}));
      resolve(s);
    };
    s.onerror=fail;
    /* A close is the end of the session, whenever it lands. The server hangs up
       deliberately -- no token, no minutes left, too many recordings open, and
       the minutes can run out fifteen minutes in -- so there is no moment at
       which a close can be treated as a blip to ride out. Relabelling the rail
       and leaving the microphone running made the page look like it was still
       recording into a socket that was gone. */
    s.onclose=()=>{
      if(ws!==s)return;
      ws=null;live=false;
      /* 'starting' is deliberately not torn down here: the microphone is still
         being opened on the other side of an await, and stopping a capture that
         has not been set up yet would leave the finished one orphaned. That case
         belongs to the check in startRecording, which runs once the mic is up. */
      if(B.classList.contains('rec')||B.classList.contains('paused')){
        endLiveSession();                   // same teardown as ending a session
        setActivity('');roL.textContent='—';
      }
      setConn('off','Disconnected');        // after endLiveSession, which says 'Idle'
      // last word, because setActivity writes the idle caption over everything
      if(lastServerError)setCap(lastServerError,'err');
    };
    s.onmessage=e=>onServer(JSON.parse(e.data));
    setTimeout(()=>{if(s.readyState!==1)fail();},2500);   // don't hang on a dead host
  });
}

/* ── jump to latest ──────────────────────────────────────────────────────────
   Only ever offered, never forced: it appears when a transcript arrives below
   the fold and leaves the moment you are back at the bottom, however you got
   there. `hidden` as well as the class, so it is out of the tab order while it
   is invisible rather than a focusable nothing. */
const jumpBtn=document.getElementById('jump');
function showJump(on){
  jumpBtn.hidden=!on;
  // the class drives the transition, and it cannot animate from `hidden`
  if(on)requestAnimationFrame(()=>jumpBtn.classList.add('show'));
  else jumpBtn.classList.remove('show');
}
jumpBtn.onclick=()=>{
  const sc=document.querySelector('.scroll');
  // smooth here and nowhere else: this one is asked for, so it reads as travel
  // rather than the page moving under someone who did not ask
  sc.scrollTo({top:sc.scrollHeight,behavior:'smooth'});
  showJump(false);
};
document.querySelector('.scroll').addEventListener('scroll',()=>{
  const sc=document.querySelector('.scroll');
  if(sc.scrollHeight-sc.scrollTop-sc.clientHeight<60)showJump(false);
},{passive:true});

/* ── the listenable copy ──────────────────────────────────────────────────────
   Whisper is fed 16 kHz mono because that is what it wants, and that discards
   everything above 8 kHz — the band that makes speech sound crisp rather than
   like a phone call. Fine for recognition, poor to listen back to.

   So the same microphone stream is recorded a second time by MediaRecorder at
   the device's own rate, compressed. That copy is what playback uses; the 16 kHz
   PCM still goes to the server untouched, and still backs playback if the
   browser gives us no recorder.

   Both start from the same stream within a frame of each other, so word
   timings from the server line up with either. */
let hifiRec=null, hifiChunks=[], hifiType='';
function startHifiRecorder(stream){
  hifiChunks=[]; hifiRec=null;
  if(typeof MediaRecorder==='undefined')return;
  const types=['audio/mp4','audio/webm;codecs=opus','audio/webm'];   // Safari first
  hifiType=types.find(t=>{try{return MediaRecorder.isTypeSupported(t);}catch{return false;}})||'';
  try{
    hifiRec=hifiType?new MediaRecorder(stream,{mimeType:hifiType}):new MediaRecorder(stream);
    hifiRec.ondataavailable=e=>{if(e.data&&e.data.size)hifiChunks.push(e.data);};
    // A timeslice means the header chunk arrives early, so the pieces collected
    // so far are already playable — needed for scrubbing mid-lecture.
    hifiRec.start(1000);
  }catch{ hifiRec=null; }
}
function stopHifiRecorder(){
  try{
    if(hifiRec&&hifiRec.state!=='inactive'){
      /* stop() flushes one final chunk, and it arrives after this returns. The
         panel is already open by then, so the source is rebuilt when it lands —
         otherwise playback is missing the last second of the lecture. */
      hifiRec.onstop=()=>{
        if(audioPanel.hidden)return;
        buildWavUrl();
        audioEl.src=window.recordingUrl;
        initWaveform();
      };
      hifiRec.stop();
    }
  }catch{}
  hifiRec=null;
}

function buildWavUrl(){
  /* The good copy once the lecture is over, the 16 kHz PCM while it is running.
     MediaRecorder is asked for a chunk a second so there is something to scrub,
     but those chunks are pieces of a file that has not been finished: its
     duration is whatever a demuxer can infer from an incomplete container. That
     is why playback stopped short of the audio that existed, and why the clock
     could read past the length it was shown against.
     The PCM header is written for exactly the bytes in hand, so the length is
     true every time it is rebuilt. */
  const recording = B.classList.contains('rec') || B.classList.contains('paused');
  const blob = (!recording && hifiChunks.length)
    ? new Blob(hifiChunks,{type:hifiType||'audio/webm'})
    : (pcmBlob ? new Blob([makeWavHeader(pcmBlob.size),pcmBlob],{type:'audio/wav'}) : null);
  if(!blob)return false;
  if(window.recordingUrl)URL.revokeObjectURL(window.recordingUrl);
  window.recordingBlob=blob;
  window.recordingUrl=URL.createObjectURL(blob);
  return true;
}

