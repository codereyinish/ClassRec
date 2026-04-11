// live.js — recording session core
// Handles: WebSocket connection, microphone capture, PCM chunking, enrollment,
// transcript rendering (word spans), WAV blob utilities, and UI state.
// Audio player / waveform / word-sync lives in player.js.

// ===== 0. LOGGER =====
   const Logger = {
       DEBUG: true,
       debug: (msg, data = '') => {
           if (Logger.DEBUG) console.log(`[DEBUG] ${msg}`, data);
       },
       error: (msg, data = '') => {
           console.error(`[ERROR] ${msg}`, data);
       }
   };



   // ======= 1. CONSTANTS =========
     const TAG_ICONS = { exam: '🔴', assignment: '📝', important: '⭐', attendance: '📋', classwork: '📖', name: '🙋' };
     const KEYWORD_MAP = {
               exam:       ["exam", "midterm", "final", "quiz", "test"],
               assignment: ["homework", "due", "submit", "assignment"],
               important:  ["important", "remember this", "key concept"],
               attendance: ["attendance", "sign in", "roll call", "present"],
               classwork:  ["classwork", "in class"],
               name: []
           };
     const MAX_CHARS = 400;          // ← NEW: max chars before new div
     const SILENCE_THRESHOLD = 0.0001;




   // ===== 2. STATE =====
   let isRecording = false;
   let websocket = null;
   let audioContext = null;
   let voiceLockActive = false;
   let lockToggleOn = false;
   let isEnrolling = false;
   let enrollAutoStop = null;   // 10s auto-stop for enrollment
   let enrollmentAudioChunks = [];
   let pcmBlob = null;          // grows incrementally every chunk, no header inside


    //=====2B. LIVE USAGE TRACING ======
    let sessionSeconds = 0;
    let liveTimer = null;
    let hasWarnedOneMinute = false;

    function startUsageTracking(){
        sessionSeconds = 0;
        liveTimer = setInterval(trackLiveUsage, 1000);
    }

    function trackLiveUsage(){
        Logger.debug("Live Tracking ....");
        sessionSeconds++;
        savetoLocalStorage();
        warnOneMinuteRemaining();
        stopAtLimit();
    }

    function savetoLocalStorage() {
        if(sessionSeconds % 10 == 0){
            UsageTracker.addLiveMinutes(10/60);
            Logger.debug("10 seconds passed +");
        }
    }

    function warnOneMinuteRemaining(){
        if (UsageTracker.getRemainingLiveSeconds()<= 30 && !hasWarnedOneMinute){
             hasWarnedOneMinute = true;
             if(!window.Clerk?.user){
                statusDiv.textContent = '⚠️ 1 minute left — sign up to continue!';
                statusDiv.style.color = '#f59e0b';
             }
        }
    }

    function stopAtLimit(){
        if (UsageTracker.getRemainingLiveSeconds() <= 0) {
            stopRecording();
            window.showUpgradeModal();
        }
    }

    function stopUsageTracking() {
        clearInterval(liveTimer);
        const untrackedSeconds = sessionSeconds % 10;
        if (untrackedSeconds > 0) UsageTracker.addLiveMinutes(untrackedSeconds / 60);
        sessionSeconds = 0;
    }




   // ===== 3. DOM ELEMENTS =====
   const micBubble = document.getElementById('micBubble');
   const statusDiv = document.getElementById('status');
   const transcriptArea = document.getElementById('transcriptArea');
   const transcriptContent = document.getElementById('transcriptContent');
   const emptyState = document.getElementById('emptyState');
   const micSelect = document.getElementById('micSelect');
   const lockToggle = document.getElementById('lockToggle');
   const lockBadge = document.getElementById('lockBadge');
   const lockHint = document.getElementById('lockHint');

   lockToggle.addEventListener('change', () => {
       lockToggleOn = lockToggle.checked;
       if (lockToggleOn) {
           lockHint.classList.add('visible');
       } else {
           lockHint.classList.remove('visible');
           lockBadge.classList.remove('visible');
           voiceLockActive = false;
           if (websocket && websocket.readyState === WebSocket.OPEN) {
               websocket.send(JSON.stringify({ type: "voice_lock_off" }));
           }
       }
   });


   function onMicDown(e) {
       if (!lockToggleOn || voiceLockActive) return;
       e.preventDefault();   // block click from firing
       enrollmentAudioChunks = [];
       statusDiv.textContent = 'Recording sample...';
       statusDiv.className = 'status enrolling';
       lockHint.classList.remove('visible');
       if (!UsageTracker.canRecordLive()) { window.showUpgradeModal(); return; }
       (async () => {
           try { pendingStream = await getMicrophoneAccess(); }
           catch (err) { alert('Mic denied: ' + err.message); return; }
           isEnrolling = true;
           startEnrolling();
       })();
       enrollAutoStop = setTimeout(() => onMicUp(null), 10000);  // auto-stop
   }

   function showEnrollmentPlayback() {
       if (enrollmentAudioChunks.length === 0) return;
       const blob = createWavBlob(enrollmentAudioChunks);
       const audioEl = document.getElementById('sampleAudio');
       const wrapper = document.getElementById('sampleAudioWrapper');
       if (audioEl && wrapper) {
           audioEl.src = URL.createObjectURL(blob);
           wrapper.style.display = 'block';
       }
   }

   function createWavBlob(chunks) {
       const totalSamples = chunks.reduce((s, c) => s + c.length, 0);
       const pcm = new Int16Array(totalSamples);
       let offset = 0;
       for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
       const dataSize = pcm.byteLength;
       const wav = new ArrayBuffer(44 + dataSize);
       const v = new DataView(wav);
       const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
       str(0,'RIFF'); v.setUint32(4, 36+dataSize, true); str(8,'WAVE');
       str(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true);
       v.setUint16(22,1,true); v.setUint32(24,16000,true);
       v.setUint32(28,32000,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
       str(36,'data'); v.setUint32(40,dataSize,true);
       new Int16Array(wav,44).set(pcm);
       return new Blob([wav], { type:'audio/wav' });
   }

   function makeWavHeader(dataSize) {
       // Write just the 44-byte WAV header for a given PCM data size
       const buf = new ArrayBuffer(44);
       const v = new DataView(buf);
       const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
       str(0,'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8,'WAVE');
       str(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true);
       v.setUint16(22,1,true); v.setUint32(24,16000,true);
       v.setUint32(28,32000,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
       str(36,'data'); v.setUint32(40,dataSize,true);
       return buf;
   }

   function appendChunkToPcmBlob(int16Chunk) {
       // Reference append — browser holds pointer to old blob, no copy of old data
       const newPiece = new Blob([int16Chunk.buffer]);
       pcmBlob = pcmBlob ? new Blob([pcmBlob, newPiece]) : newPiece;
   }

   function buildWavUrl() {
       // Prepend a fresh 44-byte header to the current pcmBlob — trivial cost
       if (!pcmBlob) return;
       const header  = makeWavHeader(pcmBlob.size);
       const wavBlob = new Blob([header, pcmBlob], { type: 'audio/wav' });
       if (window.recordingUrl) URL.revokeObjectURL(window.recordingUrl);
       window.recordingBlob = wavBlob;
       window.recordingUrl  = URL.createObjectURL(wavBlob);
   }

   function onMicUp(e) {
       if (!lockToggleOn || !isEnrolling) return;
       if (e) e.preventDefault();
       isEnrolling = false;
       if (enrollAutoStop) { clearTimeout(enrollAutoStop); enrollAutoStop = null; }
       if (websocket && websocket.readyState === WebSocket.OPEN) {
           websocket.send(JSON.stringify({ type: "enroll_end" }));
       }
       const seconds = (enrollmentAudioChunks.length * 4096) / 16000;
       if (seconds >= 1.5) {
           showEnrollmentPlayback();
           statusDiv.textContent = 'Processing sample...';
           statusDiv.className = 'status recording';
       } else {
           lockHint.textContent = 'Hold for at least 2 seconds';
           lockHint.classList.add('visible');
           statusDiv.textContent = 'Too short — try again';
           statusDiv.className = 'status idle';
       }
   }

   micBubble.addEventListener('mousedown', onMicDown);
   micBubble.addEventListener('mouseup', onMicUp);
   micBubble.addEventListener('touchstart', onMicDown, { passive: false });
   micBubble.addEventListener('touchend', onMicUp, { passive: false });


   //======= DATA SANITIZATION =======
   function escapeHtml(str) {
   return str
       .replace(/&/g, '&amp;')
       .replace(/</g, '&lt;')
       .replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;');
   }

   // ==== 4. DEVICE SELECTOR DROPDOWN=====
   async function requestMicPermissionBriefly(){
       const stream = await navigator.mediaDevices.getUserMedia({ audio : true})
       stream.getTracks().forEach(track => track.stop());
   }

   async function getAudioInputDevices(){
       const devices = await navigator.mediaDevices.enumerateDevices();
       const audioInputs = devices.filter(d => d.kind === 'audioinput');
       return audioInputs;
   }

   function createDeviceDropdown(audioInputs){
       const filtered = audioInputs.filter(device =>
           !device.label.toLowerCase().includes('airpods') &&
           !device.label.toLowerCase().includes('bluetooth')
       );
       filtered.forEach(device => {
           const option = document.createElement('option');
           option.value = device.deviceId;
           option.text =  device.label;
           micSelect.appendChild(option);
       });
   }

   async function loadMicDevices(){
       await requestMicPermissionBriefly();
       const audioInputs = await getAudioInputDevices();
       createDeviceDropdown(audioInputs);
   }

   loadMicDevices();



   // ===== 5. MIC CLICK=====
   let pendingStream = null;  // ← store stream here

   // CLICK MICROPHONE
   micBubble.addEventListener('click', async () => {
       if (lockToggleOn && !voiceLockActive) return;
       if (isRecording) {
           stopRecording();
       } else {
           if (!UsageTracker.canRecordLive()) { window.showUpgradeModal(); return; }
           openPopup();
           try {
               pendingStream = await getMicrophoneAccess();
           } catch (e) {
               alert('Microphone access denied: ' + e.message);
               closePopup();
           }
       }
   });



   // ===== 6. MICROPHONE =====
   async function getMicrophoneAccess(){
           const stream = await navigator.mediaDevices.getUserMedia({
               audio: { deviceId: micSelect.value ? {ideal : micSelect.value} : undefined,
                        sampleRate : 16000,
                        channelCount : 1
                       }
           });

           if(!stream) throw new Error('Could not access microphone');
           return stream;
   }


    // ===== 7. UI HELPERS =====
    function setRecordingUI(){
       micBubble.classList.add('recording');
       statusDiv.textContent = 'Recording... (Click to stop)';
       statusDiv.className = 'status recording';
    }

   function resetUI(){
       micBubble.classList.remove('recording');
       statusDiv.textContent = 'Click to start recording';
       statusDiv.className = 'status idle';
       lockToggle.checked = false;
       lockToggleOn = false;
       lockHint.textContent = 'Hold mic to capture professor\'s voice';
       lockHint.classList.remove('visible');
       lockBadge.classList.remove('visible');
       voiceLockActive = false;
       isEnrolling = false;
       if (enrollAutoStop) { clearTimeout(enrollAutoStop); enrollAutoStop = null; }
   }

   //======= 8. Display Transcription
   let currentChunk = null;        // ← NEW: tracks current div

   function getOrCreateChunk(){
       const currentText = currentChunk ? currentChunk.querySelector('.transcript-text').textContent : '';
       const endsWithSentence = /[.!?]$/.test(currentText.trim());

       if (!currentChunk || (currentText.length > MAX_CHARS && endsWithSentence)) {
           currentChunk = document.createElement('div');
           currentChunk.className = 'transcript-chunk';
           currentChunk.innerHTML = `
               <div class="timestamp">${new Date().toLocaleTimeString()}</div>
               <div class="transcript-text"></div>
           `;
           transcriptContent.appendChild(currentChunk);
       }
       return currentChunk
   }

   function applyTags(chunk, tags){
       const timestamp = currentChunk.querySelector('.timestamp');
           tags.forEach(tag => {
               if(!timestamp.innerHTML.includes(`tag-${tag}`)){
                   timestamp.innerHTML += ` <span class="tag tag-${tag}"> ${TAG_ICONS[tag] || ''} ${tag} </span>`;
               }
           });
           currentChunk.classList.add('flagged');
   }

   function highlightKeywords(textEl, tags){
       const keyword_map = { ...KEYWORD_MAP, name: window.tagConfig?.name ? [window.tagConfig.name] : [] };
       // Highlight inside each word span individually so data-start/data-end attributes survive
       textEl.querySelectorAll('span.word').forEach(span => {
           let text = escapeHtml(span.textContent);
           tags.forEach(tag => {
               (keyword_map[tag] || []).forEach(kw => {
                   const regex = new RegExp(`(${kw})`, 'gi');
                   text = text.replace(regex, `<mark class="highlight-${tag}">$1</mark>`);
               });
           });
           span.innerHTML = text;
       });
   }


   function displayTranscription(text, tags=[], words=[]){
       emptyState.style.display = 'none';
       const chunk = getOrCreateChunk();
       const textEl = chunk.querySelector('.transcript-text');
       const needsSpace = textEl.innerHTML !== '';

       if (words.length > 0) {
           // Render each word as a clickable span with timestamp data attributes
           const spansHtml = words.map(w =>
               `<span class="word" data-start="${w.s}" data-end="${w.e}">${escapeHtml(w.w)}</span>`
           ).join(' ');
           textEl.innerHTML += (needsSpace ? ' ' : '') + spansHtml;
       } else {
           // Fallback: no words array, render plain text
           textEl.textContent += (textEl.textContent ? ' ' : '') + text;
       }

       if(tags.length > 0){
           applyTags(chunk, tags);
           highlightKeywords(textEl, tags);
       }
       transcriptArea.scrollTop = transcriptArea.scrollHeight;
   }


   // ===== 9. WEBSOCKET =====
   function implementWebsocketConnection(stream){
           const protocol = window.location.protocol === "https:"? "wss:" : "ws:"
           const wsUrl = window.location.host;
           websocket = new WebSocket(`${protocol}//${wsUrl}/ws/transcribe`);


           //Connection opened
           Logger.debug("Websocket Connection  Opened");
           websocket.onopen = () => {
               setRecordingUI();
               websocket.send(JSON.stringify({
                   type: "context",
                   prompt: lecturePrompt,
                   tagConfig: window.tagConfig
               }));
           Logger.debug("Prompt and Tags sent to Backend", window.tagConfig);
               setupAudioProcessing(stream);
           };

           // Server sends transcription
           websocket.onmessage = (event) =>{
               const data = JSON.parse(event.data)
               if (data.type === 'transcription'){
                   //Display i2t
                   Logger.debug("Received transcript from Backend");
                   Logger.debug('Tags detected:' , data.tags  )
                   displayTranscription(data.text, data.tags || [], data.words || [])
               }
               else if (data.type === "error"){
                   alert('Transcription error: ' + data.message);
               }
               else if (data.type === "enroll_success") {
                   voiceLockActive = true;
                   lockBadge.classList.add('visible');
                   lockHint.classList.remove('visible');
                   openPopup();   // let user set lecture context now that voice is locked
               }
               else if (data.type === "enroll_failed") {
                   lockHint.textContent = 'Hold for more than 3 seconds';
                   lockHint.classList.add('visible');
                   statusDiv.textContent = 'Not enough audio — try again';
                   statusDiv.className = 'status idle';
               }
           };

           //Error --connection failed
           websocket.onerror = (error) => {
               stopRecording();
               alert('Cannot connect to server. Is it running on port 8000?');
           };

           // Connection closed or intentionally dropped
           websocket.onclose = (event) => {
               // Check if it was intentionally closed or not
               if (isRecording) {
                   statusDiv.textContent = 'Connection lost!';
                   statusDiv.style.color = '#f59e0b'; // Orange

                   //Try to reconnect
                   const shouldReconnect = confirm('Connection lost! Try reconnecting?');
                   if (shouldReconnect) {
                       stopRecording();                           // 1. Clean up old connection
                       setTimeout(() => startRecording(), 1000);  // 2. Wait 1 sec, then try again
                   }
               }
           };
   }


   // ===== 10. AUDIO PROCESSING =====
   function setupAudioProcessing(stream){
           audioContext = new AudioContext({ sampleRate : 16000});
           const source = audioContext.createMediaStreamSource(stream);
           const processor = audioContext.createScriptProcessor(4096,1, 1);
           source.connect(processor);
           processor.connect(audioContext.destination);

            processor.onaudioprocess = (e) => {
               if (websocket && websocket.readyState === WebSocket.OPEN){
                   const audioData = e.inputBuffer.getChannelData(0);
                   const int16Chunk = convertToInt16(audioData);
                   websocket.send(int16Chunk.buffer);
                   if (isEnrolling) enrollmentAudioChunks.push(new Int16Array(int16Chunk)); //for Enrollment Audio UI
                   //preview and bottom one for Live Audio Wav Preview
                   else appendChunkToPcmBlob(int16Chunk);
               }
           };
   }

   function isSilent(audioData){
       const rms = calculateRMS(audioData);
       return (rms<SILENCE_THRESHOLD)

   }

   function calculateRMS(audioFloatSamples) {
   let sum = 0;
   for (let i = 0; i < audioFloatSamples.length; i++) {
       sum += audioFloatSamples[i] * audioFloatSamples[i]; // square each sample
   }
   return Math.sqrt(sum / audioFloatSamples.length); // sqrt of average
   }



   function convertToInt16(audioFloatSamples){
       const int16 = new Int16Array(audioFloatSamples.length);
       for (let i = 0; i < audioFloatSamples.length; i++) {
           int16[i] = audioFloatSamples[i] * 32767;
       }
       return int16;
   }

   // ===== 11. CORE FUNCTIONS =====
   async function startRecording() {
       try{
           Logger.debug("Into Recording Mode");
           const stream = pendingStream || await getMicrophoneAccess();
           pendingStream = null;
           if (websocket && websocket.readyState === WebSocket.OPEN) {
               isRecording = true;
               startUsageTracking();
               setRecordingUI();
               setupAudioProcessing(stream);
           } else {
               implementWebsocketConnection(stream);
               isRecording = true;
               startUsageTracking();
           }
       }
       catch(error){
           alert('Error: ' + error.message);
           resetUI();
       }
   }


   function stopRecording() {
       stopUsageTracking();
       if (audioContext) audioContext.close();
       if (websocket) websocket.close();
       isRecording = false;

       // Build final WAV URL and show player panel
       buildWavUrl();
       pcmBlob = null;
       showAudioPanel();

       resetUI();
   }

   function startEnrolling() {
       const stream = pendingStream;
       pendingStream = null;
       if (!stream) { isEnrolling = false; return; }

       const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
       websocket = new WebSocket(`${protocol}//${window.location.host}/ws/transcribe`);

       websocket.onopen = () => {
           websocket.send(JSON.stringify({ type: "context", prompt: "", tagConfig: window.tagConfig || { tags: [], name: "" } }));
           websocket.send(JSON.stringify({ type: "enroll_start" }));
           isRecording = true;
           startUsageTracking();
           setupAudioProcessing(stream);
       };

       websocket.onmessage = (event) => {
           const data = JSON.parse(event.data);
           if (data.type === "enroll_success") {
               voiceLockActive = true;
               lockBadge.classList.add('visible');
               lockHint.classList.remove('visible');
               if (audioContext) audioContext.close();
               isRecording = false;
               stopUsageTracking();
               statusDiv.textContent = 'Voice locked! Click mic to record.';
               statusDiv.className = 'status idle';
           } else if (data.type === "enroll_failed") {
               lockHint.textContent = 'Hold for at least 2 seconds';
               lockHint.classList.add('visible');
               if (audioContext) audioContext.close();
               websocket.close();
               isRecording = false;
               stopUsageTracking();
               statusDiv.textContent = 'Not enough audio — try again';
               statusDiv.className = 'status idle';
           } else if (data.type === "error") {
               alert('Error: ' + data.message);
           } else if (data.type === "transcription") {
               displayTranscription(data.text, data.tags || []);
           }
       };

       websocket.onerror = () => { stopRecording(); alert('Cannot connect to server. Is it running?'); };
       websocket.onclose = (event) => {
           console.log('Enrollment WS closed. code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean, 'isRecording:', isRecording);
           if (isRecording) {
               isRecording = false;
               stopUsageTracking();
           }
       };
   }

   // =====12. POPUP / SESSION =====
   let lecturePrompt = "";
   let debounceTimer;

   const overlay      = document.getElementById('overlay');
   const promptInput  = document.getElementById('promptInput');
   const generating   = document.getElementById('generating');
   const titlePreview = document.getElementById('titlePreview');
   const previewText  = document.getElementById('previewText');
   const btnStart     = document.getElementById('btnStart');
   const btnSkip      = document.getElementById('btnSkip');
   const sessionTitle = document.getElementById('sessionTitle');
   const titleText    = document.getElementById('titleText');

   function openPopup() {
       overlay.classList.add('open');
       setTimeout(() => promptInput.focus(), 300);
   }

   function closePopup() {
       overlay.classList.remove('open');
   }


   function startSession() {
       lecturePrompt = promptInput.value.trim().slice(0,100);
       collectAlertConfig();
       const title = previewText.textContent || null;
       closePopup();
       if (title) { titleText.textContent = title; sessionTitle.classList.add('visible'); }
       if (isRecording) {
           if (websocket && websocket.readyState === WebSocket.OPEN) {
               websocket.send(JSON.stringify({ type: "context", prompt: lecturePrompt, tagConfig: window.tagConfig }));
           }
           setRecordingUI();
       } else {
           startRecording();
       }
   }

   promptInput.addEventListener('input', () => {
       clearTimeout(debounceTimer);
       const val = promptInput.value.trim();
       if (!val) {
           titlePreview.classList.remove('visible');
           generating.classList.remove('visible');
           return;
       }
       titlePreview.classList.remove('visible');
       generating.classList.add('visible');
       debounceTimer = setTimeout(() => {
           generating.classList.remove('visible');
           const words = val.split(' ').slice(0, 5);
           const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
           previewText.textContent = title;
           titlePreview.classList.add('visible');
       }, 900);
   });

   btnStart.addEventListener('click', startSession);
   btnSkip.addEventListener('click', () => {
       collectAlertConfig();
       overlay.classList.remove('open');
       if (isRecording) {
           if (websocket && websocket.readyState === WebSocket.OPEN) {
               websocket.send(JSON.stringify({ type: "context", prompt: "", tagConfig: window.tagConfig }));
           }
           setRecordingUI();
       } else {
           startRecording();
       }
   });
   promptInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startSession(); });

   function collectAlertConfig() {
   const selectedTags = [...document.querySelectorAll('.alert-dropdown input[type="checkbox"]:checked')]
       .map(cb => cb.value);
   const customName = document.getElementById('nameInput').value.trim().slice(0,50);
   window.tagConfig = { tags: selectedTags, nFLoame: customName };
   }

   document.getElementById('nameCheck').addEventListener('change', (e) => {
       document.getElementById('nameInput').disabled = !e.target.checked;
       if (e.target.checked) document.getElementById('nameInput').focus();
   });

