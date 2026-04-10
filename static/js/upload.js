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

    function show_Transcription_Loading_State(){
        DOM.uploadBtn.disabled = true;
        DOM.resultDiv.style.display = 'block';
        DOM.resultDiv.innerHTML = '<p class="loading">⏳ Transcribing... This may take 10-30 seconds</p>';
    }

    async function transcribeAudio(formData){
            const response = await fetch('/transcribe', {
                method: 'POST',
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
         alert('Please select a file first!');
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
                '<strong>✅ Transcription Complete!</strong><br><br>' +
                '<strong>File:</strong> ' + data.filename + '<br>' +
                '<strong>Size:</strong> ' + data.file_size_mb + ' MB<br><br>' +
                '<strong>Text:</strong><br>' +
                '<div class="transcription-container">' +
                    '<span id="transcriptionText"></span>' +
                    '<button class="copy-btn" id="copyBtn">📋 Copy</button>' +
                '</div>';
        document.getElementById('transcriptionText').textContent = data.transcription;
    }


    function add_ErrorMessage_to_ResultDiv(ErrorMessage){
       DOM.resultDiv.style.display = 'block';
       DOM.resultDiv.innerHTML = '<strong>❌ Error:</strong> ' + ErrorMessage;

    }

    function enableCopyButton(data){
        document.getElementById('copyBtn').addEventListener('click', function() {
                    copyToClipboard(data.transcription, this);
        });
    }


    function copyToClipboard(text, buttonElement) {
        navigator.clipboard.writeText(text).then(() => {
            buttonElement.classList.add('dimmed');
            setTimeout(() => {
                buttonElement.classList.remove('dimmed');
            }, 2000);
        }).catch(err => {
            alert('Failed to copy text: ' + err);
        });
    }


    DOM.uploadBtn.addEventListener('click', handleUpload);
