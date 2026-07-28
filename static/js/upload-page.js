// Upload page wiring — voice picker + save-lecture flow.
// (Extracted from an inline <script> in upload.html for readability.)
// Depends on: voice-picker.js (VoicePicker) and upload.js (fires 'transcription:done').

// ---- Voice picker: choosing a voice remembers its id for the saved session ----
let selectedVoiceId = null;
document.getElementById("pickVoiceBtn").addEventListener("click", () => {
    VoicePicker.open((voice) => {
        selectedVoiceId = voice.id;
        document.getElementById("selectedVoice").textContent =
            `Voice: ${voice.name} (used ${voice.use_count}×)`;
    });
});

// ---- Save flow: when a transcript is ready, reveal the save row ----
let lastTranscript = null;
const saveRow = document.getElementById("saveRow");
const saveTitle = document.getElementById("saveTitle");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");

window.addEventListener("transcription:done", (e) => {
    lastTranscript = e.detail.transcription;
    saveTitle.value = (e.detail.filename || "Lecture").replace(/\.[^.]+$/, "");  // drop extension
    saveRow.style.display = "block";
    saveStatus.textContent = "";
});

saveBtn.addEventListener("click", async () => {
    if (!lastTranscript) return;
    saveStatus.textContent = "Saving…";
    try {
        const res = await fetch("/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: saveTitle.value.trim() || "Untitled Lecture",
                transcript: lastTranscript,
                class_id: selectedVoiceId,     // may be null if no voice picked
            }),
        });
        const data = await res.json();
        saveStatus.textContent = res.ok ? `Saved ✓ (lecture #${data.id})` : "Save failed.";
        saveStatus.style.color = res.ok ? "var(--green)" : "var(--red)";
    } catch (err) {
        saveStatus.textContent = "Save failed.";
        saveStatus.style.color = "var(--red)";
    }
});
