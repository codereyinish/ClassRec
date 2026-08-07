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


    const DOM = {
         audioFileInput:  document.getElementById('audioFile'),
         resultDiv:  document.getElementById('result'),
         uploadBtn:  document.getElementById('uploadBtn'),
    }


    //===== FILE_UPLOAD_TRACKING
    let selectedAudioFile = null;
    let audioFileDuration = 0;


    function buildFormData(Selected_file){
        const formData = new FormData();
        formData.append('file', Selected_file);
        return formData
    }

    /* The three states the panel can be in are built here rather than written
       as strings at each call site, so they share one shell and one vocabulary
       with the rest of the app -- line icons, no emoji. */
    const ICO = {
        ok:   '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
        err:  '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.1"/>',
        copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
        tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    };
    const svg = (d, w) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'
        + (w || 1.9) + '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';

    function show_Transcription_Loading_State(){
        DOM.uploadBtn.disabled = true;
        DOM.resultDiv.innerHTML =
            '<div class="up-panel"><div class="up-status busy">'
          + '<span class="up-spin"></span>Transcribing\u2026 a long lecture takes a moment'
          + '</div></div>';
    }

    async function transcribeAudio(formData){
            // Uploading spends the account's allowance, so the route needs to know
            // whose it is. Asked for each time rather than cached: a Clerk token
            // lasts about a minute and the SDK hands back the current one.
            let token = '';
            try{
                token = (window.Clerk && window.Clerk.session)
                    ? await window.Clerk.session.getToken() : '';
            }catch{}
            const response = await fetch('/transcribe', {
                method: 'POST',
                headers: token ? { 'Authorization': 'Bearer ' + token } : {},
                body: formData
            });
            const data = await response.json();

            //Throw Error
            if(!response.ok){
                throw new Error(data.detail || 'Transcription failed');
            }
            return data;
    }

    function extractAudioDuration(audioFile){
         return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(audioFile);
            const audio = new Audio();
            audio.onloadedmetadata = () => {
                resolve(audio.duration/ 60);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            audio.onerror = () => {
                URL.revokeObjectURL(url)  // ← on failure
                reject(new Error('Could not read audio duration'))
            }
            audio.src = url;
         })
    }


    DOM.audioFileInput.addEventListener('change', async(e) => {
        selectedAudioFile = e.target.files[0];
        if(!selectedAudioFile) return;
        showChosenFile(selectedAudioFile);   // the panel hides the native control

        try {
            audioFileDuration = await extractAudioDuration(selectedAudioFile);
            Logger.debug("Audio Duration is", audioFileDuration);
        } catch (err) {
            Logger.debug("Could not read audio duration, defaulting to 0", err.message);
            audioFileDuration = 0;
        }
    });




    async function handleUpload() {
        if(!selectedAudioFile){
         // The page has a place to say things; a browser dialog is not it — it
         // arrives in the operating system's type, blocks everything behind it,
         // and looks like it came from somewhere else.
         add_ErrorMessage_to_ResultDiv('Choose an audio file first.');
         return;
        }

        let uploadPermission = UsageTracker.canUpload(audioFileDuration)
        if(!uploadPermission.allowed){
            if(uploadPermission.code === "file_too_long"){
                console.log(uploadPermission.reason);
                add_ErrorMessage_to_ResultDiv(uploadPermission.reason);
                return;
            } else {
                window.showUpgradeModal();
            }
            return;
        }

        show_Transcription_Loading_State();
        try{
            const formData = buildFormData(selectedAudioFile);
            const data = await transcribeAudio(formData);
            add_Transcription_to_ResultDiv(data);
            UsageTracker.addUploadMinutes(audioFileDuration);
            Logger.debug("UploadMins:" , UsageTracker.getUploadMinutes())
            enableCopyButton(data);
        }
        catch (error){
            add_ErrorMessage_to_ResultDiv(error.message);
        }
        finally {
        DOM.uploadBtn.disabled = false;  // ← Cleanup HERE
        }

    }


    function add_Transcription_to_ResultDiv(data){
        DOM.resultDiv.innerHTML=
            '<div class="up-panel">'
          + '<div class="up-status ok">' + svg(ICO.ok, 2.2) + 'Transcribed</div>'
          + '<div class="up-meta"><span id="upFile"></span>'
          + '<span><span class="n">' + data.file_size_mb + '</span> MB</span></div>'
          + '<div class="up-text"><span id="transcriptionText"></span>'
          + '<button class="up-copy" id="copyBtn" type="button" aria-label="Copy">'
          + svg(ICO.copy, 1.8) + '</button></div>'
          + '</div>';
        // textContent, not innerHTML: a filename and a transcript are both text
        // someone else supplied
        document.getElementById('upFile').textContent = data.filename;
        document.getElementById('transcriptionText').textContent = data.transcription;
    }


    function add_ErrorMessage_to_ResultDiv(ErrorMessage){
       DOM.resultDiv.innerHTML =
            '<div class="up-panel"><div class="up-status err">'
          + svg(ICO.err) + '<span id="upErr"></span></div></div>';
       document.getElementById('upErr').textContent = ErrorMessage;
    }

    function enableCopyButton(data){
        document.getElementById('copyBtn').addEventListener('click', function() {
                    copyToClipboard(data.transcription, this);
        });
    }


    function copyToClipboard(text, buttonElement) {
        navigator.clipboard.writeText(text).then(() => {
            // the same tick-then-back the transcript blocks use, so copying
            // feels like one gesture across the app
            buttonElement.classList.add('done');
            buttonElement.innerHTML = svg(ICO.tick, 2.2);
            setTimeout(() => {
                buttonElement.classList.remove('done');
                buttonElement.innerHTML = svg(ICO.copy, 1.8);
            }, 1400);
        }).catch(err => {
            add_ErrorMessage_to_ResultDiv('Could not copy: ' + err);
        });
    }

    /* The name of what was chosen, and the drag states the panel answers with.
       Without these the only sign a file had been picked was the browser's own
       control, which the redesigned panel hides. */
    const dropzone = document.getElementById('dropzone');
    const fileName = document.getElementById('fileName');
    function showChosenFile(f){
        if(!fileName) return;
        fileName.hidden = !f;
        fileName.textContent = f ? f.name : '';
    }
    if (dropzone) {
        ['dragenter','dragover'].forEach(ev =>
            dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('over'); }));
        ['dragleave','drop'].forEach(ev =>
            dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('over'); }));
        dropzone.addEventListener('drop', e => {
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!f) return;
            // route it through the input so the existing change handler does the
            // duration read and validation, rather than a second copy of both
            const dt = new DataTransfer();
            dt.items.add(f);
            DOM.audioFileInput.files = dt.files;
            DOM.audioFileInput.dispatchEvent(new Event('change'));
        });
    }


    DOM.uploadBtn.addEventListener('click', handleUpload);
