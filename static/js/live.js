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
     const SILENCE_THRESHOLD = 0.01;




   // ===== 2. STATE =====
   let isRecording = false;
   let websocket = null;
   let audioContext = null;


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
   const micSelect = document.getElementById('micSelect')

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
       audioInputs.forEach(device => {
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
   micBubble.addEventListener('click', async() => {
       if (isRecording) {
           stopRecording();
       } else {
                if(!UsageTracker.canRecordLive()){
                    window.showUpgradeModal();
                    return;
                }
                try{
                    pendingStream = await getMicrophoneAccess();
                }
                catch(e){
                    alert('Microphone access denied: ' + e.message);
                    return;
                }
              openPopup()
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
       //CHANGE CSS STYLE
       micBubble.classList.add('recording');
       statusDiv.textContent = 'Recording... (Click to stop)';
       statusDiv.className = 'status recording';
    }

   function resetUI(){
       micBubble.classList.remove('recording');
       statusDiv.textContent = 'Click to start recording';
       statusDiv.className = 'status idle';
   }

   //======= 8. Display Transcription
   let currentChunk = null;        // ← NEW: tracks current div

   function getOrCreateChunk(){
       // ← NEW: if currentChunk is null, then  text=''
       const currentText = currentChunk ? currentChunk.querySelector('.transcript-text').textContent : '';
       const endsWithSentence = /[.!?]$/.test(currentText.trim());

       // if no div created yet or given div is full
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
        let highlighted = escapeHtml(textEl.textContent)
           tags.forEach(tag => {
               (keyword_map[tag]).forEach( kw => {
                   const regex = new RegExp(`(${kw})`, 'gi');
                   highlighted = highlighted.replace(regex,`<mark class="highlight-${tag}">$1</mark>`);
               });
           });
           textEl.innerHTML = highlighted;
   }


   function displayTranscription(text, tags=[]){
       emptyState.style.display = 'none';
       const chunk = getOrCreateChunk();
       //Fill up the text
       const textEl = chunk.querySelector('.transcript-text');
       textEl.textContent += (textEl.textContent ? ' ' : '') + text;
       if(tags.length>0){
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

           // states of websocket connection with corresponding function to be implemented in each state

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
                   displayTranscription(data.text, data.tags || [])
               }
               else if (data.type === "error"){
                   alert('Transcription error: ' + data.message);
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
           // 4. Setup Audio Processing
           audioContext = new AudioContext({ sampleRate : 16000});
           const source = audioContext.createMediaStreamSource(stream);
           const processor = audioContext.createScriptProcessor(4096,1, 1);
           source.connect(processor);
           processor.connect(audioContext.destination);

           //5. Send Audio to Server
            processor.onaudioprocess = (e) => {
               if (websocket && websocket.readyState === WebSocket.OPEN){
                   const audioData = e.inputBuffer.getChannelData(0);
                   const rms = calculateRMS(audioData);
<!--                    Logger.debug('RMS:', rms);  // ← add this-->
                   if(isSilent(audioData)) return;

                   const int16Chunk = convertToInt16(audioData);
                   websocket.send(int16Chunk.buffer)
                   Logger.debug("Audio sent from frontend to Backend ")
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
           implementWebsocketConnection(stream);
           isRecording = true;
           startUsageTracking();
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
       resetUI();
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
       if (title) {
           titleText.textContent = title;
           sessionTitle.classList.add('visible');
       }
       startRecording();
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
       startRecording();
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