// Live page wiring — voice picker.
// (Extracted from an inline <script> in live.html for readability.)
// Depends on: voice-picker.js (VoicePicker).
//
// window.selectedVoiceId is read in live.js on WS open: if set, it sends a
// "use_saved_voice" message so the server locks the live filter onto that voice.

window.selectedVoiceId = null;
document.getElementById("pickVoiceBtn").addEventListener("click", () => {
    VoicePicker.open((voice) => {
        window.selectedVoiceId = voice.id;
        document.getElementById("selectedVoice").textContent = `Voice: ${voice.name}`;
    });
});
