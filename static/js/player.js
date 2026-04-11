// player.js — waveform player and word-audio sync
// Handles: canvas waveform rendering, play/pause/skip controls, requestAnimationFrame
// sync loop (active word highlight), click-word-to-seek, click-canvas-to-seek.
// Depends on live.js being loaded first (uses buildWavUrl, window.recordingBlob/Url).

// ===== WAVEFORM CONSTANTS =====
const WAVEFORM_PLAYED   = '#52b788';
const WAVEFORM_UNPLAYED = '#1b4332';
const WAVEFORM_PLAYHEAD = '#52b788';

// ===== STATE =====
let waveformBars  = null;   // Float32Array of downsampled amplitudes, one per canvas pixel
let decodedBuffer = null;   // Web Audio API AudioBuffer — holds decoded samples + duration
let rafId         = null;   // requestAnimationFrame handle, null when loop is stopped

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
    initWaveform();
}


// ===== WAVEFORM INIT =====
async function initWaveform() {
    if (!window.recordingBlob) return;

    // Match canvas pixel dimensions to its CSS display size for sharp rendering
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    // Decode WAV blob → raw float32 samples via Web Audio API
    const arrayBuf    = await window.recordingBlob.arrayBuffer();
    const ctx         = new AudioContext();
    decodedBuffer     = await ctx.decodeAudioData(arrayBuf);
    await ctx.close();

    // Downsample: divide samples into N blocks (one per pixel column),
    // take the peak amplitude of each block as the bar height
    const rawData   = decodedBuffer.getChannelData(0);
    const N         = canvas.width;
    const blockSize = Math.floor(rawData.length / N);
    waveformBars    = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        let max = 0;
        const start = i * blockSize;
        for (let j = start; j < start + blockSize; j++) {
            if (Math.abs(rawData[j]) > max) max = Math.abs(rawData[j]);
        }
        waveformBars[i] = max;
    }

    drawWaveform(audioEl.currentTime);
}


// ===== WAVEFORM DRAW =====
function drawWaveform(currentTime) {
    if (!waveformBars || !decodedBuffer) return;
    const ctx       = canvas.getContext('2d');
    const W         = canvas.width;
    const H         = canvas.height;
    const progress  = decodedBuffer.duration > 0 ? currentTime / decodedBuffer.duration : 0;
    const playheadX = Math.floor(progress * W);

    ctx.clearRect(0, 0, W, H);

    // Draw amplitude bars — played portion bright green, unplayed dark green
    for (let i = 0; i < W; i++) {
        const barH = waveformBars[i] * H * 0.9;
        ctx.fillStyle = i < playheadX ? WAVEFORM_PLAYED : WAVEFORM_UNPLAYED;
        ctx.fillRect(i, (H - barH) / 2, 1, barH);
    }

    // Vertical playhead line
    ctx.fillStyle = WAVEFORM_PLAYHEAD;
    ctx.fillRect(playheadX, 0, 2, H);

    // Update time display
    timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(decodedBuffer.duration)}`;
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}


// ===== SYNC LOOP =====
// Runs at ~60fps while audio plays — redraws waveform and highlights active word span
function startSyncLoop() {
    function tick() {
        const t = audioEl.currentTime;
        drawWaveform(t);
        document.querySelectorAll('span.word').forEach(span => {
            const s = parseFloat(span.dataset.start);
            const e = parseFloat(span.dataset.end);
            span.classList.toggle('active', s <= t && t <= e);
        });
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
});

document.getElementById('skipBack').addEventListener('click', () => {
    audioEl.currentTime = Math.max(0, audioEl.currentTime - 15);
    drawWaveform(audioEl.currentTime);
});

document.getElementById('skipFwd').addEventListener('click', () => {
    audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 15);
    drawWaveform(audioEl.currentTime);
});


// ===== SEEK =====
// Click on canvas → seek to that position
canvas.addEventListener('click', (e) => {
    if (!decodedBuffer) return;
    const rect      = canvas.getBoundingClientRect();
    const fraction  = (e.clientX - rect.left) / rect.width;
    audioEl.currentTime = fraction * decodedBuffer.duration;
    drawWaveform(audioEl.currentTime);
});

// Click on word span → build fresh WAV, seek, play
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
