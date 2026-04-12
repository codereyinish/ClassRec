// player.js — scrolling waveform player and word-audio sync
// Fixed playhead at center; waveform slides smoothly underneath via sub-pixel translate.
// Depends on live.js (buildWavUrl, window.recordingBlob/Url).

// ===== CONSTANTS =====
const BARS_PER_SEC  = 12;   // data resolution — bars per second of audio
const BAR_W         = 3;    // pixels wide per bar
const BAR_GAP       = 2;    // pixels gap between bars
const STEP          = BAR_W + BAR_GAP;  // 4px per bar slot
const TICK_INTERVAL = 5;    // ruler label every N seconds

const COLOR_PLAYED   = '#52b788';
const COLOR_UNPLAYED = 'rgba(82,183,136,0.18)';
const COLOR_PLAYHEAD = 'rgba(255,255,255,0.9)';
const COLOR_TICK     = 'rgba(255,255,255,0.4)';
const COLOR_LABEL    = '#ffffff';

// ===== STATE =====
let waveformBars  = null;
let decodedBuffer = null;
let rafId         = null;

// ===== DOM REFS =====
const audioEl      = document.getElementById('recordingAudio');
const audioPanel   = document.getElementById('audioPanel');
const canvas       = document.getElementById('waveform');
const playPauseBtn = document.getElementById('playPause');
const timeDisplay  = document.getElementById('timeDisplay');


// ===== PANEL =====
function showAudioPanel() {
    if (!window.recordingUrl) return;
    audioEl.src = window.recordingUrl;
    audioPanel.classList.add('visible');
    requestAnimationFrame(() => initWaveform());
}


// ===== WAVEFORM INIT =====
async function initWaveform() {
    if (!window.recordingBlob) return;

    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

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

    drawWaveform(audioEl.currentTime);
}


// ===== WAVEFORM DRAW =====
// Sub-pixel smooth scrolling:
//   world-x of bar i  = i * STEP
//   world-x of center = currentTime * BARS_PER_SEC * STEP
//   canvas-x of bar i = world-x - leftWorld  (before fractional shift)
// We ctx.translate(-fracPart, 0) so the canvas slides by less than 1px per frame → smooth.
function drawWaveform(currentTime) {
    if (!waveformBars || !decodedBuffer) return;

    const ctx     = canvas.getContext('2d');
    const W       = canvas.width;
    const H       = canvas.height;
    const RULER_H  = 14;       // pixels reserved at bottom for ruler
    const PAD_V    = 6;        // top/bottom padding inside waveform zone
    const waveH    = H - RULER_H;
    const centerX = W / 2;

    // Exact world pixel position of current time
    const centerWorld = currentTime * BARS_PER_SEC * STEP;
    const leftWorld   = centerWorld - centerX;
    const fracPart    = leftWorld - Math.floor(leftWorld);

    ctx.clearRect(0, 0, W, H);

    // Sub-pixel translate so bars don't jump by whole pixels
    ctx.save();
    ctx.translate(-fracPart, 0);

    const firstBar = Math.floor(leftWorld / STEP);
    const lastBar  = Math.ceil((leftWorld + W + STEP) / STEP);
    const curBarF  = currentTime * BARS_PER_SEC;  // fractional bar index = playhead

    for (let i = firstBar; i <= lastBar; i++) {
        if (i < 0 || i >= waveformBars.length) continue;
        const x    = i * STEP - Math.floor(leftWorld);
        const amp  = waveformBars[i];
        const maxBarH = waveH - PAD_V * 2;
        const barH    = Math.max(3, amp * maxBarH);
        ctx.fillStyle = i < curBarF ? COLOR_PLAYED : COLOR_UNPLAYED;
        ctx.fillRect(x, PAD_V + (maxBarH - barH) / 2, BAR_W, barH);
    }

    ctx.restore();

    // --- Ruler: tick marks + labels ---
    const leftSec  = currentTime - centerX / (BARS_PER_SEC * STEP);
    const rightSec = currentTime + (W - centerX) / (BARS_PER_SEC * STEP);
    const firstTick= Math.ceil(leftSec / TICK_INTERVAL) * TICK_INTERVAL;

    ctx.font = '11px "DM Mono", monospace';
    ctx.textAlign = 'center';

    for (let t = firstTick; t <= rightSec + 0.01; t += TICK_INTERVAL) {
        // Exact canvas x for this tick (same sub-pixel logic)
        const tickWorld = t * BARS_PER_SEC * STEP;
        const tickX     = tickWorld - leftWorld;  // before fracPart correction
        const x         = tickX - fracPart;

        ctx.fillStyle = COLOR_TICK;
        ctx.fillRect(x, waveH + 4, 1, 6);

        ctx.fillStyle = COLOR_LABEL;
        ctx.fillText(formatTimeTick(t), x, H - 2);
    }

    // --- Playhead: vertical white line at center ---
    ctx.fillStyle = COLOR_PLAYHEAD;
    ctx.fillRect(centerX - 0.5, 0, 1, waveH + 2);

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

// Short format for ruler ticks: m:ss
function formatTimeTick(sec) {
    if (sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}


// ===== SYNC LOOP =====
let lastActiveSpan = null;

function startSyncLoop() {
    function tick() {
        const t = audioEl.currentTime;
        drawWaveform(t);

        let activeSpan = null;
        document.querySelectorAll('span.word').forEach(span => {
            const s = parseFloat(span.dataset.start);
            const e = parseFloat(span.dataset.end);
            const isActive = s <= t && t <= e;
            span.classList.toggle('active', isActive);
            if (isActive) activeSpan = span;
        });

        // Scroll transcript when the active word chunk changes
        if (activeSpan && activeSpan !== lastActiveSpan) {
            lastActiveSpan = activeSpan;
            activeSpan.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
        audioEl.play();
        playPauseBtn.textContent = '⏸';
        startSyncLoop();
    } else {
        audioEl.pause();
        playPauseBtn.textContent = '▶';
        stopSyncLoop();
    }
});

audioEl.addEventListener('ended', () => {
    playPauseBtn.textContent = '▶';
    stopSyncLoop();
    if (decodedBuffer) drawWaveform(decodedBuffer.duration);
});

// ===== SEEK =====
// Click on canvas: offset from center → time delta
canvas.addEventListener('click', (e) => {
    if (!decodedBuffer) return;
    const rect    = canvas.getBoundingClientRect();
    const clickX  = (e.clientX - rect.left) * (canvas.width / rect.width);
    const dt      = (clickX - canvas.width / 2) / (BARS_PER_SEC * STEP);
    const newTime = Math.max(0, Math.min(decodedBuffer.duration, audioEl.currentTime + dt));
    audioEl.currentTime = newTime;
    drawWaveform(newTime);
});

// Click word span → seek and play
document.addEventListener('click', (e) => {
    const span = e.target.closest('span.word');
    if (!span) return;
    const t = parseFloat(span.dataset.start);
    if (isNaN(t)) return;
    buildWavUrl();
    showAudioPanel();
    audioEl.src = window.recordingUrl;
    audioEl.currentTime = t;
    audioEl.play();
    playPauseBtn.textContent = '⏸';
    startSyncLoop();
});
