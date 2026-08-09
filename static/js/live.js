// live.js — recording session core
// Handles: the rail, the lecture-context prompt, the mic state machine, theme,
// the spent-allowance notice, the device picker, alerts, session identity, the
// data layer, microphone capture to Int16 PCM, incoming transcript rendering
// and session start.
// Audio player / waveform / word-sync lives in audio-playback.js.
const B=document.body;
/* Hovering the mic opens the rail. Nothing closes it but the collapse icon — an
   auto-close on mouseleave meant the rail slid away whenever the pointer crossed it
   on the way somewhere else, which is the flicker in the recording. */
const handleEl=document.getElementById('handle'), railEl=document.querySelector('.rail');
let peekTimer=null;
const OPEN_INTENT=160;   // hover has to mean it — a cursor passing the corner is ignored

handleEl.addEventListener('mouseenter',()=>{
  if(B.classList.contains('rail-open'))return;
  peekTimer=setTimeout(()=>B.classList.add('rail-open'),OPEN_INTENT);
});
handleEl.addEventListener('mouseleave',()=>clearTimeout(peekTimer));   // only cancels an unfired open
handleEl.onclick=()=>{clearTimeout(peekTimer);B.classList.add('rail-open');};

// the only way out
document.getElementById('collapse').onclick=()=>{
  clearTimeout(peekTimer);B.classList.remove('rail-open');
};
const cap=document.getElementById('cap');
// Enter commits the title rather than inserting a newline
const h1=document.querySelector('.head h1');
h1.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();h1.blur();}});
// mock readout so the rail shows live numbers while "recording"
let tick=null,secs=0,words=0;
const roT=document.getElementById('roT'),roW=document.getElementById('roW'),
      roF=document.getElementById('roF'),roL=document.getElementById('roL');
const mmss=s=>String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
// The mic itself is the whole control: idle → recording → paused → recording → …
/* Chunks arrive with the session instead of being there from the start, so the
   empty state is a real state and the stream is something you watch fill. Driven
   off the session tick, which means it pauses when the session does. */
/* The clock only runs while audio is genuinely being captured — there is no
   longer a branch that invents words when there is no microphone. */
const run=()=>{tick=setInterval(()=>{
  secs++;
  /* The audio is the authority, not this interval. setInterval is throttled in a
     background tab, so a lecture recorded while you were in another tab counted
     fewer seconds than it captured — the playhead, which reads real samples, ran
     past a total that had fallen behind. Sample count cannot drift from the file
     it describes, and it is exactly what playback can reach.
     Length, Elapsed and the strip's total are all this one number. */
  const t = liveSamples ? Math.floor(liveSamples / SR) : secs;
  roT.textContent=mmss(t);
  durTxt.textContent=mmss(t);
  durDisplay.textContent=mmss(t);},1000);};
/* ── mic state machine, transcribed from live.js ─────────────────────
   lock off  : click → recording
   lock on   : HOLD to enrol a voice. ≥10s → locked. <10s → error.
   locked    : click → recording
   recording : click → paused (red, 60s drift) · click again → recording
   Save ends the session.                                            */
const mic=document.getElementById('mic'), hint=document.getElementById('lockhint'),
      lockToggle=document.getElementById('lockToggle');
const setCap=(t,cls)=>{cap.textContent=t;cap.className='mic-cap'+(cls?' '+cls:'');};
let enrolTimer=null, enrolSecs=0, holding=false, heldAt=0;

/* Two independent axes, and conflating them is what put a green halo under an
   idle caption: MODE is lockon/locked (a setting), ACTIVITY is rec/paused/
   enrolling (what the mic is doing right now). Activity classes are mutually
   exclusive and only ever change through setActivity, so the halo colour and
   the caption cannot disagree. */
/* "Hold the mic…" is only for the case where there is no voice on file at all --
   every class has a default (the most-used voice for it), so the normal path is
   lock on, click, go. Holding is how you add another, not a toll to pay first. */
const idleCap=()=>
  B.classList.contains('locked') ? 'Click to start recording' :
  B.classList.contains('lockon') ? 'Hold the mic to record a voice' :
                                   'Click the microphone to start recording';
const isBusy=()=>['starting','rec','paused','enrolling'].some(c=>B.classList.contains(c));
/* Pause is a sub-state of recording, not a sibling: `paused` keeps `rec` on,
   because the mic click and Save both gate on `rec`, and .glow's paused rules
   sit alongside the recording ones. */
/* `starting` is deliberately NOT `rec`: between the click and the microphone
   actually being granted, nothing is being captured, and the green halo would
   be claiming otherwise while the permission sheet is still open. */
const ACT={'':[], starting:['starting'], rec:['rec'], paused:['rec','paused'], enrolling:['enrolling']};
/* Errors are transient: a failed hold explains itself and then gets out of the way,
   rather than sitting in red until something else happens to overwrite it. */
let errTimer=null;
const showError=msg=>{
  setCap(msg,'err');
  clearTimeout(errTimer);
  errTimer=setTimeout(()=>{if(!isBusy())setCap(idleCap());},5000);
};
function setActivity(a){
  clearTimeout(errTimer);     // any real state change outranks a pending revert
  B.classList.remove('starting','rec','paused','enrolling');
  (ACT[a]||[]).forEach(c=>B.classList.add(c));
  if(a!=='rec')clearInterval(tick);
  if(a==='rec')setCap('Recording… (click to pause)');
  else if(a==='starting')setCap('Waiting for the microphone…');
  else if(a==='paused')setCap('Paused');
  else if(!a)setCap(idleCap());   // enrolling writes its own countdown
}

// the mic moves vertically as the rail's contents change, so measure it
// rather than hardcoding a top offset
const placeHint=()=>{
  const m=document.querySelector('.glow').getBoundingClientRect();
  const s=document.querySelector('.shell').getBoundingClientRect();
  hint.style.top=Math.round(m.top - s.top + m.height/2 - hint.offsetHeight/2)+'px';
  hint.style.left=Math.round(m.right - s.left + 12)+'px';
};
/* Shows for 3s, and startHold pulls it early — once you're holding, it has said
   its piece. placeHint runs first so it never animates from a stale position. */
let hintTimer=null;
const showHint=()=>{
  clearTimeout(hintTimer);
  placeHint();                 // synchronous: inside rAF this never ran in a
  hint.classList.add('visible'); // backgrounded tab, and the hint stayed invisible
  hintTimer=setTimeout(()=>hint.classList.remove('visible'),3000);
};
lockToggle.onchange=()=>{
  if(lockToggle.checked){
    B.classList.add('lockon');
    // the class's default voice is already on file, so lock is satisfied immediately
    if(VOICES.some(v=>v.sel)){
      B.classList.add('locked');   // nothing to prompt for — the hint would be noise
    }else{
      showHint();                  // no voice on file: holding is the only way forward
    }
  }else{
    B.classList.remove('lockon','locked');
    voiceLockOff();               // {type:'voice_lock_off'}
    hint.classList.remove('visible');
  }
  // never rewrite the caption over a live recording — that was the green-halo bug
  if(!isBusy())setCap(idleCap());
};

/* One way in to a session, so the mic and "Start session" cannot drift apart on
   which counters they reset. */
async function startRecording(){
  /* Recording needs an account, so the prompt comes before the microphone rather
     than after a lecture has been recorded and cannot be saved. Signing in here
     continues into the recording — no second click. */
  if(window.Clerk && !window.Clerk.session){
    setActivity('');
    setCap('Sign in to record');
    try{ await window.Clerk.openSignIn(); }catch{}
    await new Promise(r=>setTimeout(r,400));
    if(!window.Clerk.session){ showError('Sign in to record'); return; }
    await refreshForUser();
  }
  B.classList.remove('rail-open');
  secs=0;words=0;roT.textContent='00:00';roW.textContent='0';
  lastServerError='';              // this attempt is not the last one's refusal
  setActivity('starting');roL.textContent='—';
  [roT,roW,roF].forEach(e=>e.classList.remove('dim'));roF.textContent='0';
  durTxt.textContent='00:00';
  try{
    await beginLiveSession();        // returns only once the mic is actually granted
  }catch(err){
    /* Denied, or no server. Back to idle — the clock never started and the halo
       never went green, so there is nothing to undo. */
    setActivity('');
    /* Name what actually failed. Everything that was not a permission denial
       used to be reported as "could not reach the server", which sent us looking
       at a backend that was answering fine while the microphone was the problem. */
    const n=(err&&err.name)||'';
    showError(
      n==='NotAllowedError'||n==='SecurityError' ? 'Microphone blocked — allow it to record' :
      n==='NotFoundError'                        ? 'No microphone found' :
      n==='NotReadableError'                     ? 'Microphone is in use by another app' :
      err&&err.stage==='mic'                     ? 'Microphone unavailable ('+(n||'unknown')+')' :
                                                   'Could not reach the server');
    return;
  }
  if(!B.classList.contains('starting')){
    endLiveSession();      // cancelled while we waited: let the mic and socket go
    return;
  }
  /* Refused while the microphone was opening. The server answers in a few
     milliseconds and getUserMedia takes rather longer, so this is the ordinary
     ordering, not the rare one -- and without this the lines below would paint
     "Recording…" over the refusal and start a clock against a dead socket. */
  if(!ws||ws.readyState!==1){
    endLiveSession();      // the mic is up by now, so there is something to stop
    setActivity('');roL.textContent='—';
    // beginLiveSession finished behind the close and left the rail reading
    // "Live · recording"; endLiveSession then says 'Idle'. Neither is true.
    setConn('off','Disconnected');
    if(lastServerError)setCap(lastServerError,'err');
    return;
  }
  B.classList.add('has-text');        // empty state gives way to the stream
  startLiveWave();                    // the strip is up for the whole lecture
  setActivity('rec');                 // green, and the clock, only from here
  roL.textContent='good';
  run();
}

/* Both entry points — the mic and the picker's Start session — come through here,
   so the prompt cannot be bypassed by one of them. */
const ctx=document.getElementById('ctx'), ctxInput=document.getElementById('ctxInput');
let lectureContext='';
function askContext(){
  stopPlay();
  vp.classList.remove('open');    // the picker leaves rather than stacking underneath
  ctxInput.value=lectureContext;
  ctx.classList.add('open');
  setTimeout(()=>ctxInput.focus(),140);
}
const closeContext=()=>ctx.classList.remove('open');
const beginFromContext=keep=>{
  lectureContext=keep?ctxInput.value.trim():'';
  closeContext();
  startRecording();
};
document.getElementById('ctxStart').onclick=()=>beginFromContext(true);
document.getElementById('ctxSkip').onclick=()=>beginFromContext(false);
// the cross abandons the attempt entirely: no session, no context, page as it was
document.getElementById('ctxX').onclick=()=>{lectureContext='';ctxInput.value='';closeContext();};
ctxInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();beginFromContext(true);}};
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&ctx.classList.contains('open')){lectureContext='';ctxInput.value='';closeContext();}
});
ctx.onclick=e=>{if(e.target===ctx)closeContext();};

// hold-to-enrol
/* A press is not a hold until it has lasted HOLD_MS. Every click is mousedown →
   mouseup → click, so arming the enrol on mousedown made an ordinary click into a
   0-second sample: it failed with "too short" and then had its own click swallowed,
   which made recording unstartable in Lock Mode. A normal click is 60-120ms, so
   250ms separates the two intents without feeling sticky. */
const HOLD_MS=250;
let holdTimer=null, pressAt=0;
const startHold=e=>{
  // `locked` no longer disqualifies a hold: a voice is on file from the start now, and
  // holding is how you add another. Only a live session rules it out.
  if(!B.classList.contains('lockon')||B.classList.contains('rec'))return;
  e.preventDefault();
  pressAt=Date.now();
  clearTimeout(holdTimer);
  holdTimer=setTimeout(()=>{
    holding=true;enrolSecs=0;
    beginEnrol();                  // start keeping the sample
    setActivity('enrolling');hint.classList.remove('visible');
    setCap('Recording sample… 0s','enrol');
    // counted from the press, not from when the threshold fired, so 10s means 10s
    enrolTimer=setInterval(()=>{
      enrolSecs=Math.floor((Date.now()-pressAt)/1000);
      setCap(`Recording sample… ${enrolSecs}s`,'enrol');
    },250);
  },HOLD_MS);
};
const endHold=()=>{
  clearTimeout(holdTimer);
  if(!holding)return;         // released before HOLD_MS — that was a click, leave it alone
  holding=false;
  enrolSecs=Math.floor((Date.now()-pressAt)/1000);
  // A hold ending on mouseup owes us one trailing click; a hold ending because the
  // pointer left the circle owes us nothing, since the browser only fires click when
  // press and release share an element. So mark WHEN it ended and let the click
  // handler ignore anything older than a moment -- a sticky flag armed by mouseleave
  // sat there and swallowed the next real click instead.
  heldAt=Date.now();
  clearInterval(enrolTimer);
  if(enrolSecs>=10){
    // a real sample was captured — file it, open the picker, let them name it
    finishEnrol(enrolSecs);        // wrap it as a WAV, ready to be named
    B.classList.add('locked');
    setActivity('');                 // idle, and idleCap() now reads "Click to start recording"
    addCapturedVoice(enrolSecs);
  }else{
    enrolCapturing=false;enrolBuf=[];
    setActivity('');
    showError('Too short — hold for at least 10 seconds');
  }
};
mic.addEventListener('mousedown',startHold);
mic.addEventListener('mouseup',endHold);
mic.addEventListener('mouseleave',endHold);

mic.addEventListener('click',()=>{
  // A hold ends with mouseup, and the browser then fires click on the same element.
  // That trailing click used to fall through into "start recording", so enrolling a
  // voice silently began a session behind the still-open picker. Swallow it: after a
  // hold, the next click is spent.
  if(Date.now()-heldAt<400){heldAt=0;return;}   // the hold's own trailing click
  // With a default voice on file, `locked` is already set when Lock Mode goes on, so
  // this no longer gates the normal path -- it only bites when every voice has been
  // deleted and there is nothing to lock onto. Never blocks a live session.
  /* Already waiting on the permission sheet: this click cancels rather than
     starting a second attempt, which would open a second prompt and a second
     socket. Whatever the pending request does later is discarded. */
  if(B.classList.contains('starting')){
    setActivity('');setConn('off','Idle');
    return;
  }
  const live=B.classList.contains('rec');
  if(!live&&B.classList.contains('lockon')&&!B.classList.contains('locked'))return;
  if(!B.classList.contains('rec')){
    /* Straight to recording. The context prompt used to sit here, but the server
       never passes it to Whisper — it is accepted and dropped — so it was a step
       between the click and the lecture that bought nothing. The dialog and its
       plumbing stay in the file for when the prompt actually reaches the model. */
    startRecording();
  }else if(!B.classList.contains('paused')){
    setActivity('paused');roL.textContent='paused';
    /* The capture loop returns early while paused, so meter() stops being
       called and the bar keeps the width it had at the instant of the pause —
       a level reading beside the word "paused". Nothing is arriving, so it
       shows nothing. */
    roFill.style.width='0%';
    setConn('on','Live · paused');   // the socket is up; the microphone is not
  }else{
    setActivity('rec');roL.textContent='good';run();
    setConn('on','Live · recording');
  }
});

document.getElementById('save').onclick=()=>{
  /* Reachable after the session ends now that the button lives with the
     transcript, so it saves whatever is on the page and only closes a session
     that is still running. */
  if(!document.querySelector('.stream .transcript-text'))return;   // nothing to save
  saveSession();                 // POST /sessions before the page forgets the transcript
  if(B.classList.contains('rec')){
    endLiveSession();
    setActivity('');roL.textContent='—';
  }
};
/* ── theme ───────────────────────────────────────────────────────────────────
   The choice is remembered, so it survives the reload; until someone makes one
   the system decides, and changing the system setting still moves the page. */
const themeBtn=document.getElementById('themeBtn');
themeBtn.onclick=()=>{
  const dark=document.documentElement.dataset.theme!=='dark';
  if(dark)document.documentElement.dataset.theme='dark';
  else delete document.documentElement.dataset.theme;
  try{localStorage.setItem('classrecTheme',dark?'dark':'light');}catch(e){}
  // the waveform is painted onto a canvas, so it does not re-read the CSS on
  // its own the way everything else does
  if(typeof readWaveColors==='function'){
    readWaveColors();
    if(decodedBuffer)drawWaveform(audioEl.currentTime);
  }
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',e=>{
  let saved=null; try{saved=localStorage.getItem('classrecTheme');}catch(_){}
  if(saved)return;                       // a choice was made; the system does not override it
  if(e.matches)document.documentElement.dataset.theme='dark';
  else delete document.documentElement.dataset.theme;
});

/* ── the allowance, spent ──
   Opened by the server naming the reason, not by reading its wording. */
const limOverlay=document.getElementById('limOverlay');
function showLimit(){
  if(limOverlay.classList.contains('open'))return;   // one close, one panel
  limOverlay.classList.add('open');
  document.getElementById('limNote').textContent =
    USAGE_LAST.live!=null
      ? 'Used ' + (USAGE_LAST.live/60).toFixed(1) + ' of '
        + Math.round(USAGE_ALLOWANCE.live/60) + ' minutes'
      : '';
}
const hideLimit=()=>limOverlay.classList.remove('open');
document.getElementById('limLater').onclick=hideLimit;
limOverlay.onclick=e=>{ if(e.target===limOverlay)hideLimit(); };
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&limOverlay.classList.contains('open'))hideLimit();
});
/* There is nowhere to send anyone yet, so the button answers rather than
   pretending to navigate. Deliberately not "you are on the list": the click is
   not recorded anywhere, and a promise the app cannot keep is worse than none. */
document.getElementById('limPro').onclick=()=>{
  document.getElementById('limNote').textContent =
    'Paid plans are coming. You will hear first.';
};

const openAI=()=>B.classList.add('ai-open');
document.getElementById('aibtn').onclick=openAI;
// the shortcut the pill advertises
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='j'){e.preventDefault();openAI();}
});

/* Per-block actions. Copy takes the spoken text only — not the timestamp or the tag
   chips, which are ours rather than the lecturer's. Ask pins the block as the panel's
   context, which is what the floating button does for a selection. */
const blockText=c=>c.querySelector('.transcript-text').textContent.replace(/\s+/g,' ').trim();
/* Delegated, because blocks arrive during the lecture. This used to bind over a
   fixed list of blocks that existed at load — which was true of the mock and is
   not true of a live session, where the stream starts empty. */
document.querySelector('.stream').addEventListener('click',async e=>{
  const copy=e.target.closest('.copy'), ask=e.target.closest('.ask');
  const c=e.target.closest('.chunk');
  if(!c||(!copy&&!ask))return;
  e.stopPropagation();
  if(copy){
    try{await navigator.clipboard.writeText(blockText(c));}catch{}
    copy.classList.add('done');
    copy.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    setTimeout(()=>{copy.classList.remove('done');
      copy.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';},1400);
    return;
  }
  attachContext(c);
  openAI();
});

/* ── input device picker ──────────────────────────────────────── */
/* Real inputs, as live.js gets them — see the four functions below, carried over
   unchanged: a brief getUserMedia at load to unlock the labels the browser hides
   until permission exists, then enumerateDevices filtered to audio inputs, minus
   AirPods and Bluetooth. Until that resolves this is what the field shows. */
let DEVICES=[{id:'',label:'System default'}];
const devField=document.getElementById('devField'), devMenu=document.getElementById('devMenu'),
      devTxt=document.getElementById('devTxt');
let devCur=0;
function renderDevices(){
  devMenu.innerHTML='';
  DEVICES.forEach((d,i)=>{
    const b=document.createElement('button');
    b.type='button';b.className='devopt'+(i===devCur?' on':'');
    // textContent, not innerHTML: a device name is whatever the OS reports, and
    // this runs before esc() exists if enumerateDevices is missing entirely.
    const nameEl=document.createElement('span'); nameEl.textContent=d.label;
    const tickEl=document.createElement('span'); tickEl.className='tick'; tickEl.textContent='✓';
    b.append(nameEl,tickEl);
    b.onclick=e=>{e.stopPropagation();devCur=i;devTxt.textContent=d.label;
      devMenu.classList.remove('open');renderDevices();};
    devMenu.appendChild(b);
  });
  devTxt.textContent=(DEVICES[devCur]||DEVICES[0]).label;
}

/* ==== 4. DEVICE SELECTOR DROPDOWN=====  — live.js, same functions, same order */
async function requestMicPermissionBriefly(){
    const stream = await navigator.mediaDevices.getUserMedia({ audio : true })
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
    DEVICES = filtered.map(d => ({id:d.deviceId, label:d.label}));
    if(!DEVICES.length) DEVICES = [{id:'', label:'System default'}];
    devCur = 0;
    renderDevices();
}

async function loadMicDevices(){
    await requestMicPermissionBriefly();
    const audioInputs = await getAudioInputDevices();
    createDeviceDropdown(audioInputs);
}
loadMicDevices();
devField.onclick=e=>{e.stopPropagation();devMenu.classList.toggle('open');};
document.addEventListener('click',()=>devMenu.classList.remove('open'));

/* ── alerts ────────────────────────────────────────────────────────────────
   Same six tags and the same name field as live.html today; live.js reads them at
   session start via collectAlertConfig() into window.tagConfig = {tags, name}, so
   alertConfig() below returns that exact shape. */
/* Icons are drawn in the page's own hand — 24x24, 1.8 stroke, round caps — the same
   set the bell, save, mic and waveform come from. The tag's colour rides on the
   glyph, so meaning and colour arrive together instead of a dot doing colour and
   nothing doing meaning. */
const ICO={
  exam:'<path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1z"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9 13.5l2 2 4-4"/>',
  assignment:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  important:'<path d="M12 3.2l2.6 5.4 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L4.5 9.5l5.9-.9z"/>',
  attendance:'<path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="3.6"/><path d="M16 11.5l2 2 4-4"/>',
  classwork:'<path d="M2.5 4.5h5a3 3 0 0 1 3 3v12a2.4 2.4 0 0 0-2.4-2H2.5z"/><path d="M21.5 4.5h-5a3 3 0 0 0-3 3v12a2.4 2.4 0 0 1 2.4-2h5.6z"/>',
  name:'<circle cx="12" cy="12" r="3.4"/><path d="M15.4 8.6v4.6a2.6 2.6 0 0 0 5.2 0V12A8.6 8.6 0 1 0 17 18.8"/>',
};
const ALERTS=[
  {v:'exam',       l:'Exam / quiz',  c:'var(--red)',       on:true},
  {v:'assignment', l:'Assignment',   c:'var(--corn)',      on:true},
  {v:'important',  l:'Important',    c:'var(--theme)',     on:true},
  {v:'attendance', l:'Attendance',   c:'var(--teal)',      on:false},
  {v:'classwork',  l:'Classwork',    c:'var(--g6)',        on:false},
];
const icoSvg=(k,c)=>`<span class="tagico" style="color:${c}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICO[k]}</svg></span>`;
const alertBtn=document.getElementById('alertBtn'), alertMenu=document.getElementById('alertMenu'),
      alertRows=document.getElementById('alertRows'), alertCount=document.getElementById('alertCount'),
      alertNameRow=document.getElementById('alertNameRow'), alertNameInput=document.getElementById('alertNameInput');
let alertName=false;
const alertConfig=()=>({
  tags:ALERTS.filter(a=>a.on).map(a=>a.v).concat(alertName?['name']:[]),
  name:alertName?alertNameInput.value.trim().slice(0,50):'',
});
/* The menu is open during a lecture, so what it says has to be what the server
   is tagging against. It used to be read once, in the opening message, and never
   again: turning Exam on halfway through changed the tick in the menu and nothing
   else for the rest of the recording.
   Deliberately not a second `context` message, which would re-run everything that
   one carries -- the token check, the socket claim, and opening a lecture row. */
const pushAlerts=()=>{
  if(ws&&ws.readyState===1)
    ws.send(JSON.stringify({type:'alerts',tagConfig:alertConfig()}));
};
function renderAlerts(){
  alertRows.innerHTML='';
  ALERTS.forEach(a=>{
    const b=document.createElement('button');
    b.type='button';b.className='alert-row'+(a.on?' on':'');
    b.innerHTML=`${icoSvg(a.v,a.c)}<span>${a.l}</span><span class="cbox">✓</span>`;
    b.onclick=e=>{e.stopPropagation();a.on=!a.on;renderAlerts();pushAlerts();};
    alertRows.appendChild(b);
  });
  alertNameRow.classList.toggle('on',alertName);
  alertNameInput.disabled=!alertName;
  const n=ALERTS.filter(a=>a.on).length+(alertName?1:0);
  alertCount.textContent=n;
  alertCount.style.display=n?'grid':'none';
}
renderAlerts();
alertBtn.onclick=e=>{e.stopPropagation();alertMenu.classList.toggle('open');};
alertMenu.onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>alertMenu.classList.remove('open'));
/* The box is the switch: tick it and the cursor lands in the field. Until then the
   field is disabled, so there is no typing into a keyword alert that is off. */
alertNameRow.onclick=e=>{
  if(!e.target.closest('.cbox'))return;
  alertName=!alertName;renderAlerts();pushAlerts();
  if(alertName)alertNameInput.focus();
};
/* On change rather than input: the name is only worth sending once it has been
   typed, not once per keystroke. */
alertNameInput.onchange=pushAlerts;

/* ── class + session identity ─────────────────────────────────────
   The title isn't typed from scratch: it's the class plus the day. Editing it by
   hand still works, but picking a class or starting a session rewrites it. */
/* ── data layer ────────────────────────────────────────────────────────────────
   Every class read and write goes through Store, so wiring the backend later is one
   fetch() per method with no other change to this file. The cache stays because a
   real client wants one anyway: render off the cache, reconcile after the call.

   MIND THE NAME COLLISION. The backend already has a `Class` model — table
   `classes`, routes `/voices` — but that is a VOICE PROFILE (name, embedding,
   threshold, use_count), not a course. `repo.top_voices(limit=4)` is what picks the
   default voice by use_count, which is the behaviour the rail relies on.

   So a *course* (CS 301) has no table and no endpoint today. These four methods are
   the only place that has to change when it gets them:
     load()        GET    /classes            -> [{id, name}]
     add(name)     POST   /classes            {name} -> {id, name}
     remove(name)  DELETE /classes/{id}
   and a session should then carry course_id alongside voice_id, which already
   records the voice that filtered it.                                          */
/* Every call to our server goes through here so the token is attached in one
   place rather than at each call site. getToken() is asked each time rather than
   cached: Clerk's tokens last about a minute, and the SDK hands back the current
   one or quietly mints a fresh one from the session cookie.

   Signed out it returns nothing and the request goes anonymous, which the API
   allows for reads — that is how a visitor records before having an account. */
async function authHeaders(){
  try{
    const t = window.Clerk && window.Clerk.session
      ? await window.Clerk.session.getToken() : null;
    return t ? {Authorization:'Bearer '+t} : {};
  }catch{ return {}; }
}

async function api(path, opts={}){
  const auth = await authHeaders();
  return fetch(API+path, {...opts, headers:{...(opts.headers||{}), ...auth}});
}

const Store={
  /* A COURSE. Not a voice — the two are separate things that happen to collide in
     the backend's naming, and this list must never be filled from /voices: those
     rows are speaker embeddings, so a course picker built from them offers
     "Zamaigas_audio" where "CS 301" belongs.

     Courses have no table yet, so they live in localStorage and a name is all one
     is. Every read and write goes through here, so the swap is one fetch per
     method and nothing else in this file moves. */
  classes:{
    KEY:'classrecCourses',
    _rows:[],
    async load(){                                           // GET /classes
      try{ this._rows=JSON.parse(localStorage.getItem(this.KEY)||'[]'); }catch{ this._rows=[]; }
      return this._rows;
    },
    _persist(){ try{ localStorage.setItem(this.KEY,JSON.stringify(this._rows)); }catch{} },
    list(){return this._rows.slice();},
    names(){return this._rows.map(r=>r.cls);},
    find(name){return this._rows.find(r=>r.cls===name);},
    has(n){return this._rows.some(r=>r.cls===n);},
    count(){return this._rows.length;},
    /* A course is a name. No audio, no embedding — that is the voice's job. */
    async add(name){                                        // POST /classes {name}
      const cls=(name||'').trim();
      if(!cls||this.has(cls))return cls||null;
      this._rows.push({id:Date.now(),cls});
      this._persist();
      return cls;
    },
    async remove(name){                                     // DELETE /classes/{id}
      this._rows=this._rows.filter(r=>r.cls!==name);
      this._persist();
    },
  },

  voices:{
    async list(){ return (await api('/voices')).json(); },                       // GET    /voices
    add(name,file){                                                             // POST   /voices?name=
      const fd=new FormData(); fd.append('file',file);
      return api('/voices?name='+encodeURIComponent(name),{method:'POST',body:fd});
    },
    rename(id,name){                                                            // PATCH  /voices/{id}
      return api('/voices/'+id,{method:'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    },
    remove(id){   return api('/voices/'+id,{method:'DELETE'}); },                // DELETE /voices/{id}
    /* Not a URL: the route needs the token, and an <audio src> cannot carry a
       header. Fetched with one and handed to the player as a blob instead. */
    async audioBlobUrl(id){
      const r=await api('/voices/'+id+'/audio');
      if(!r.ok)return null;
      return URL.createObjectURL(await r.blob());
    },
  },
  sessions:{
    async list(){ return (await api('/sessions')).json(); },                     // GET    /sessions
    save(body){                                                                 // POST   /sessions
      return api('/sessions',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    },
    rename(id,body){                                                            // PATCH  /sessions/{id}
      return api('/sessions/'+id,{method:'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    },
  },
};
let curClass='';
const titleEl=document.getElementById('title'), durTxt=document.getElementById('durTxt'),
      classPick=document.getElementById('classPick'), classMenu=document.getElementById('classMenu');
const fmtDate=d=>d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});

/* A skipped name gets numbered, and the number is the first one free rather than a
   running count, so deleting "Untitled 1" frees it again. A CLASS is never given a
   name this way — an unnamed class would be meaningless, so one has to be typed. */
const USED_TITLES=new Set();
function nextUntitled(){
  let n=1;while(USED_TITLES.has('Untitled '+n))n++;
  return 'Untitled '+n;
}
function setTitle(name){
  const t=name&&name.trim()?name.trim():nextUntitled();
  USED_TITLES.add(t);
  titleEl.textContent=t;
  titleEl.classList.remove('auto');       // a chosen name, not a stand-in
}

/* A session is never nameless: it opens as "Untitled 1" (or the first free
   number). The name is real — it saves as typed if you never touch it — but it
   is styled as provisional and steps aside the moment you click in, so you type
   over an empty line instead of deleting someone else's text first. */
function applyAutoTitle(){
  const t=nextUntitled();
  titleEl.textContent=t;
  titleEl.style.setProperty('--ph',JSON.stringify(t));   // the ghost, once cleared
  titleEl.classList.add('auto');
}
titleEl.addEventListener('focus',()=>{
  if(!titleEl.classList.contains('auto'))return;
  titleEl.textContent='';
  titleEl.classList.remove('auto');
});
titleEl.addEventListener('blur',()=>{
  if(titleEl.textContent.trim())return;   // typed something: keep it
  applyAutoTitle();                       // left it empty: back to the stand-in
});

/* Seeded from saved lectures, so the number skips names already in the database
   rather than restarting at 1 every reload. */
async function seedTitles(){
  try{
    const rows=await Store.sessions.list();
    if(Array.isArray(rows))rows.forEach(s=>s.title&&USED_TITLES.add(s.title.trim()));
  }catch{}
  if(titleEl.classList.contains('auto')||!titleEl.textContent.trim())applyAutoTitle();
}
/* ONE class menu, rendered into two containers. The picker under the title and
   the one in the New Session dialog are the same list with the same "add a
   class" field — only the box around them differs in size, so they share this
   builder rather than drifting apart as two copies.

   `current` is the selected name, `onPick` takes the chosen one, and `openAdd`
   starts straight in the input for when there is nothing to pick yet. */
function buildClassMenu(menuEl,{current,onPick,openAdd}={}){
  menuEl.innerHTML='';
  const row=(label,val,mod)=>{
    const b=document.createElement('button');
    b.type='button';b.className='devopt'+(mod||'');
    b.innerHTML=`<span>${label}</span><span class="tick">✓</span>`;
    b.onclick=e=>{e.stopPropagation();menuEl.classList.remove('open');onPick(val);};
    menuEl.appendChild(b);
  };
  /* The chosen class is already shown on the control above, so the menu lists
     what you could switch TO — repeating it just read as the same name twice.
     Clearing it is an option in its own right, offered only when one is set. */
  Store.classes.names().filter(c=>c!==current).forEach(c=>row(c,c));
  if(current)row('No class','',' muted');
  const add=document.createElement('div');
  // Nothing above it: the spacing separates nothing, so the menu is the one row.
  add.className='cls-add'+(menuEl.children.length?'':' only');
  menuEl.appendChild(add);
  const showInput=()=>{
    add.innerHTML='';
    const inp=document.createElement('input');
    inp.className='cls-add-input';inp.placeholder='Class name';inp.autocomplete='off';
    add.appendChild(inp);inp.focus();
    inp.onclick=e=>e.stopPropagation();
    inp.onkeydown=async e=>{
      e.stopPropagation();
      if(e.key==='Enter'){
        // awaited so the shape already matches the POST that replaces it
        const created=await Store.classes.add(inp.value);
        if(!created)return;                 // blank input creates nothing
        menuEl.classList.remove('open');
        onPick(created);                    // a class you just named is the one you meant
      }else if(e.key==='Escape'){ syncClassMenus(); }
    };
  };
  const btn=document.createElement('button');
  btn.type='button';btn.className='devopt';
  btn.innerHTML='<span>＋ Add a class</span>';
  /* A course is just a name, so it is typed right here. Voices are enrolled from
     the rail — a different thing, deliberately not reached from this menu. */
  btn.onclick=e=>{e.stopPropagation();showInput();};
  add.appendChild(btn);
  if(openAdd)showInput();
}

function renderClasses(){
  classPick.classList.toggle('unset',!curClass);
  classPick.innerHTML=(curClass||'Course name')+' <span class="c">▾</span>';
  buildClassMenu(classMenu,{current:curClass,
    onPick:c=>{curClass=c;syncClassMenus();}});
}
renderClasses();
classPick.onclick=e=>{e.stopPropagation();classMenu.classList.toggle('open');};
document.addEventListener('click',()=>classMenu.classList.remove('open'));

/* New session: name the class, and the page comes back to its empty state under a
   fresh title. Whatever the last session left behind goes with it. */
function resetSession(){
  setActivity('');
  B.classList.remove('has-text');
  document.querySelector('.stream').innerHTML='';   // last session's blocks go with it
  B.classList.remove('has-lines');
  liveChunk=null;
  // the previous lecture's audio goes with its transcript
  stopSyncLoop(); stopLiveWave();
  audioPanel.hidden=true;
  if(window.recordingUrl){URL.revokeObjectURL(window.recordingUrl);window.recordingUrl=null;}
  window.recordingBlob=null; pcmBlob=null; hifiChunks=[]; waveformBars=null; decodedBuffer=null;
  lastActiveSpan=null; playPauseBtn.textContent='▶';
  secs=0;words=0;
  roT.textContent='00:00';roW.textContent='0';roF.textContent='0';roL.textContent='—';
  [roT,roW,roF].forEach(e=>e.classList.add('dim'));
  durTxt.textContent='0 min';   // nothing recorded yet, so say so rather than show a fake clock
  lectureContext='';
}
const ns=document.getElementById('ns'), nsInput=document.getElementById('nsInput'),
      nsClassPick=document.getElementById('nsClassPick'), nsClassMenu=document.getElementById('nsClassMenu'),
      nsClassTxt=document.getElementById('nsClassTxt'),
      nsClassField=document.getElementById('nsClassField'), nsAddFirst=document.getElementById('nsAddFirst');
let nsClass=curClass;

/* The class list in the dialog, with "add new" as its last row. Clicking that row
   turns it into a focused field: type, press Enter, and the class exists and is
   selected. Empty input creates nothing — classes are never auto-named. */
function renderNsClasses(openAdd){
  nsClassTxt.textContent=nsClass||'No class — just recording';
  buildClassMenu(nsClassMenu,{current:nsClass,openAdd,
    onPick:c=>{nsClass=c;renderNsClasses();}});

  /* Nothing to pick yet — drop the select entirely and offer the one move that
     makes sense. The field comes back as soon as a class exists. */
  const bare=!Store.classes.count();
  nsClassField.classList.toggle('no-classes',bare);
  nsAddFirst.innerHTML='';
  if(!bare)return;
  const b=document.createElement('button');
  b.type='button';b.className='add-first';
  b.innerHTML='<span>＋</span><span>Add a class</span>';
  b.onclick=e=>{
    e.stopPropagation();
    nsAddFirst.innerHTML='';
    const inp=document.createElement('input');
    inp.className='cls-add-input';inp.placeholder='Class name';inp.autocomplete='off';
    nsAddFirst.appendChild(inp);inp.focus();
    inp.onclick=ev=>ev.stopPropagation();
    inp.onkeydown=async ev=>{
      ev.stopPropagation();
      if(ev.key==='Enter'){
        const created=await Store.classes.add(inp.value);
        if(!created)return;                 // blank input creates nothing
        nsClass=created;syncClassMenus();
      }else if(ev.key==='Escape'){renderNsClasses();}
    };
  };
  nsAddFirst.appendChild(b);
}

/* A class added in one menu exists in the other, so both are rebuilt together. */
function syncClassMenus(){ renderClasses(); if(typeof renderNsClasses==='function')renderNsClasses(); }
nsClassPick.onclick=e=>{
  e.stopPropagation();
  const opening=!nsClassMenu.classList.contains('open');
  nsClassMenu.classList.toggle('open');
  if(opening&&!Store.classes.count())renderNsClasses(true);   // nothing to pick — go straight to adding
};
ns.addEventListener('click',()=>nsClassMenu.classList.remove('open'));

const closeNs=()=>{ns.classList.remove('open');nsClassMenu.classList.remove('open');};
document.getElementById('newSess').onclick=()=>{
  nsInput.value='';nsClass=curClass;renderNsClasses();
  ns.classList.add('open');setTimeout(()=>nsInput.focus(),140);
};
document.getElementById('nsX').onclick=closeNs;
/* Skip only skips the NAME. A class is required either way, so both buttons run the
   same check and say so in the dialog rather than failing silently. */
const nsErr=document.getElementById('nsErr');
let nsErrTimer=null;
const showNsErr=msg=>{
  nsErr.textContent=msg;nsErr.classList.add('on');
  clearTimeout(nsErrTimer);
  nsErrTimer=setTimeout(()=>{nsErr.classList.remove('on');nsErr.textContent='';},4000);
};
const createSession=named=>{
  // membership, not just truthiness: a selection can outlive the class it named
  if(!nsClass||!Store.classes.has(nsClass)){
    nsClass='';
    showNsErr('Pick a class first — or add one.');
    nsClassMenu.classList.add('open');
    if(!Store.classes.count())renderNsClasses(true);
    return;
  }
  clearTimeout(nsErrTimer);nsErr.classList.remove('on');nsErr.textContent='';
  setTitle(named?nsInput.value:'');   // blank or skipped → Untitled N
  curClass=nsClass;renderClasses();
  closeNs();resetSession();
};
document.getElementById('nsCreate').onclick=()=>createSession(true);
document.getElementById('nsCancel').onclick=()=>createSession(false);   // Skip still starts one
nsInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();createSession(true);}};
ns.onclick=e=>{if(e.target===ns)closeNs();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&ns.classList.contains('open'))closeNs();});

/* ── microphone → Int16 PCM, exactly as live.js does it ── */
async function startCapture(){
  setConn('wait','Waiting for mic…');
  /* No timeout on the prompt. It used to give up after 8s and call that a refusal,
     which turned "still reading the permission sheet" into a fabricated session.
     An unanswered prompt just means not started yet — the page waits. */
  /* Exactly live.js's constraints. Asking for echoCancellation and
     noiseSuppression on top of a sample-rate constraint is enough for Safari to
     reject the whole request, and the failure arrives as a bare error with the
     microphone never prompting. */
  try{
    const pick=(DEVICES[devCur]||{}).id;
    micStream=await navigator.mediaDevices.getUserMedia({
      audio:{deviceId:pick?{ideal:pick}:undefined,sampleRate:SR,channelCount:1}});
  }catch(err){
    err.stage='mic';        // so the caller does not blame the server for this
    throw err;
  }
  startHifiRecorder(micStream);   // the copy you will actually listen to
  audioCtx=new AudioContext({sampleRate:SR});
  srcNode=audioCtx.createMediaStreamSource(micStream);
  node=audioCtx.createScriptProcessor(FRAME,1,1);
  srcNode.connect(node);node.connect(audioCtx.destination);
  node.onaudioprocess=e=>{
    if(B.classList.contains('paused'))return;             // pause freezes the stream, keeps the socket
    const f=e.inputBuffer.getChannelData(0);
    let sum=0;
    const pcm=new Int16Array(f.length);
    for(let i=0;i<f.length;i++){
      const s=Math.max(-1,Math.min(1,f[i]));
      pcm[i]=s<0?s*0x8000:s*0x7FFF;
      sum+=s*s;
    }
    meter(Math.sqrt(sum/f.length));                        // the rail's input level, from real audio
    if(enrolCapturing){enrolBuf.push(new Int16Array(pcm));return;}   // sample, not lecture
    if(ws&&ws.readyState===1)ws.send(pcm.buffer);
    appendChunkToPcmBlob(pcm);   // keep the lecture, so it can be played back
    feedLiveWave(f);             // and draw it as it arrives
  };
}
function stopCapture(){
  stopHifiRecorder();   // before the tracks go, or the last chunk is lost
  try{node&&node.disconnect();srcNode&&srcNode.disconnect();}catch{}
  try{audioCtx&&audioCtx.close();}catch{}
  try{micStream&&micStream.getTracks().forEach(t=>t.stop());}catch{}
  node=srcNode=audioCtx=micStream=null;
}
function meter(rms){
  const pct=Math.min(100,Math.round(rms*260));
  roFill.style.width=pct+'%';
  roL.textContent=pct<4?'silent':pct<12?'low':pct>82?'loud':'good';
}

/* ── incoming transcript → the app's own markup, not the mock's ──
   span.word[data-start][data-end] inside a .chunk, because that is what
   audio-playback.js, save-transcript.js and doubt-panel.js read. */
const MAX_CHARS=400;
let liveChunk=null;
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function chunkFor(){
  const txt=liveChunk?liveChunk.querySelector('.transcript-text').textContent:'';
  if(!liveChunk||(txt.length>MAX_CHARS&&/[.!?]$/.test(txt.trim()))){
    liveChunk=document.createElement('div');
    liveChunk.className='chunk in';
    /* Copy and Ask, on every block. The port brought the styling and the click
       handler across but not this markup, because in the mock it was written by
       hand into each sample block -- and blocks here are built at runtime, so
       there was nothing to copy it from. Same SVGs as the mock; the copy icon
       has to match the one the handler restores after its tick, or the button
       changes shape a second after it is used. */
    liveChunk.innerHTML=`<div class="chunk-act">
                           <button class="copy" type="button" aria-label="Copy this block">
                             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                               <rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>
                             </svg>
                           </button>
                           <button class="ask" type="button" aria-label="Ask about this block">
                             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                               <path d="M12 4l1.7 4.8L18.5 10.5l-4.8 1.7L12 17l-1.7-4.8L5.5 10.5l4.8-1.7L12 4z"/>
                             </svg>
                           </button>
                         </div>
                         <div class="timestamp">${new Date().toLocaleTimeString()}</div>
                         <div class="transcript-text"></div>`;
    document.querySelector('.stream').appendChild(liveChunk);
  }
  return liveChunk;
}
function onServer(d){
  if(d.type==='transcription'){
    /* Where the reader is, measured before anything is added -- chunkFor may
       append a whole new block, which moves the bottom. Following the lecture
       means staying stuck to the bottom; reading something further up means
       being left alone. Forcing the scroll every ten seconds did the second
       thing to people doing the first. */
    const sc=document.querySelector('.scroll');
    const stuck=sc.scrollHeight-sc.scrollTop-sc.clientHeight<60;
    const c=chunkFor(), t=c.querySelector('.transcript-text');
    const html=(d.words&&d.words.length)
      ? d.words.map(w=>`<span class="word" data-start="${w.s}" data-end="${w.e}">${esc(w.w)}</span>`).join(' ')
      : esc(d.text||'');
    /* Appended rather than re-assigned. `innerHTML +=` re-parses the block and
       builds every word span again, so the newest block was rebuilt from scratch
       every ten seconds -- it flickers, it drops a selection someone was making
       inside it, and it gets slower as the block fills. firstChild answers "is
       there anything to separate from" without serialising the block to ask. */
    t.insertAdjacentHTML('beforeend',(t.firstChild?' ':'')+html);
    // a sentence exists now, which is what Save waits for — has-text only means
    // the session started and the empty state stepped aside
    if(t.textContent.trim())B.classList.add('has-lines');
    if(d.tags&&d.tags.length){applyTags(c,d.tags);highlight(t,d.tags);}
    words+=(d.words?d.words.length:(d.text||'').split(/\s+/).filter(Boolean).length);
    roW.textContent=words.toLocaleString();
    // only for someone who was already at the bottom; the browser's own scroll
    // anchoring holds everyone else's place, once this stops overriding it
    if(stuck)sc.scrollTop=sc.scrollHeight;
    else showJump(true);      // words arrived somewhere they cannot see
  }else if(d.type==='enroll_success'){
    enrolling=false;B.classList.add('locked');
    if(!isBusy())setActivity('');
  }else if(d.type==='enroll_failed'){
    enrolling=false;showError(d.message||'Not enough audio — hold for longer');
  }else if(d.type==='usage'){
    /* The account's own total, sent when a chunk is billed rather than asked for
       on a timer — the socket is already open and the server has just written
       the number, so this costs nothing and cannot be stale by more than a
       chunk. */
    showUsage(d.live_seconds);
  }else if(d.type==='session'){
    /* The row the server opened for this recording. Everything transcribed from
       here lands in it as it arrives, so the lecture is already stored and Save
       only has to name it. */
    liveSessionId=d.id;
  }else if(d.type==='error'){
    /* A spent allowance goes to the panel and nowhere else. It is the one
       refusal the caption cannot deliver -- the caption lives in the rail, and
       the rail is closed for the whole of a recording -- and once the panel has
       said it, the rail repeating it in red only leaves the microphone looking
       broken. The caption goes back to inviting a recording. */
    if(d.code==='live_limit'){ showLimit(); return; }
    // kept as well as shown: a refusal is followed by a close, and the teardown
    // in between would otherwise take the explanation with it
    lastServerError=d.message||'Transcription error';
    showError(lastServerError);
  }
}
function applyTags(chunk,tags){
  const ts=chunk.querySelector('.timestamp');
  tags.forEach(tag=>{
    if(ts.innerHTML.includes('tag-'+tag))return;
    const ico=ICO[tag]?`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICO[tag]}</svg>`:'';
    /* Every other tag is its own label -- exam is "exam". The keyword alert is
       not: `name` is the slot, and the word being watched for is what the chip
       is telling you was said, so the chip carries that instead. Escaped because
       unlike the fixed keys this half is typed by the person reading it. */
    const label=tag==='name'?esc(alertConfig().name||tag):tag;
    ts.insertAdjacentHTML('beforeend',` <span class="tag tag-${tag}">${ico}${label}</span>`);
  });
  chunk.classList.add('tagged');
  const first=tags[0];
  const col={exam:'var(--red)',assignment:'var(--corn)',important:'var(--theme)',
             attendance:'var(--teal)',classwork:'var(--g6)',name:'var(--blush-ink)'}[first];
  if(col)chunk.style.setProperty('--tagline',col);
  roF.textContent=String(document.querySelectorAll('.chunk.tagged').length);
}
function highlight(textEl,tags){
  const map={...KEYWORDS,name:alertConfig().name?[alertConfig().name]:[]};
  textEl.querySelectorAll('span.word').forEach(sp=>{
    let t=esc(sp.textContent);
    tags.forEach(tag=>(map[tag]||[]).forEach(kw=>{
      t=t.replace(new RegExp('('+kw+')','gi'),`<mark class="highlight-${tag}">$1</mark>`);
    }));
    sp.innerHTML=t;
  });
}

/* ── keeping the recording ────────────────────────────────────────────────────
   live.js's approach, unchanged: every frame is appended to a growing headerless
   Blob rather than held as an array of Int16Arrays. The browser keeps a reference
   to the previous blob instead of copying it, so an hour of audio costs no
   resident memory — which raw PCM in an array would, at 32 KB a second.

   The 44-byte WAV header is written only when playback is wanted, in front of
   whatever has accumulated. */
let pcmBlob=null;
function appendChunkToPcmBlob(int16Chunk){
  const piece=new Blob([int16Chunk.buffer]);
  pcmBlob=pcmBlob?new Blob([pcmBlob,piece]):piece;
}
function makeWavHeader(dataSize){
  const buf=new ArrayBuffer(44), v=new DataView(buf);
  const str=(off,s)=>[...s].forEach((c,i)=>v.setUint8(off+i,c.charCodeAt(0)));
  str(0,'RIFF'); v.setUint32(4,36+dataSize,true); str(8,'WAVE');
  str(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true);
  v.setUint16(22,1,true); v.setUint32(24,SR,true);
  v.setUint32(28,SR*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  str(36,'data'); v.setUint32(40,dataSize,true);
  return buf;
}
/* ── session start : try the real thing, fall back to the demo ── */
async function beginLiveSession(){
  try{
    setConn('wait','Connecting…');
    await openSocket();
    await startCapture();
    live=true;
    liveSessionId=null;              // this recording's row, not the last one's
    document.querySelector('.stream').innerHTML='';   // real words replace the samples
    B.classList.remove('has-lines');                  // a new session has none yet
    liveChunk=null;words=0;roW.textContent='0';roF.textContent='0';
    setConn('on','Live · recording');
  }catch(err){
    live=false;
    // the socket may have opened before the mic was refused — don't leave it dangling
    if(ws&&ws.readyState<=1){try{ws.close();}catch{} ws=null;}
    stopCapture();
    /* Nothing is faked when this fails. A page that invents a transcript after a
       denied microphone is lying about what it recorded, so it says what went
       wrong and goes back to idle. */
    const denied=err&&(err.name==='NotAllowedError'||err.name==='SecurityError');
    setConn('off',denied?'Mic blocked':'No server');
    throw err;
  }
}
function endLiveSession(){
  stopCapture();
  if(ws&&ws.readyState===1)ws.close();
  ws=null;live=false;setConn('off','Idle');
  roFill.style.width='0%';

  // Build final WAV URL and show player panel — stopRecording() does this too.
  // The live bars hand over to peaks read straight from the finished WAV.
  stopLiveWave();
  buildWavUrl();
  pcmBlob = null;
  showAudioPanel();
}

/* the old simulation, kept for when there is no backend to talk to */
/* ── the two messages the current page also sends ── */
function useSavedVoice(v){                       // voice-picker.js → live.js does this
  if(!v||!v.id||!ws||ws.readyState!==1)return;
  ws.send(JSON.stringify({type:'use_saved_voice',voice_id:v.id}));
}
function voiceLockOff(){                         // sent when Lock Mode is switched off
  if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'voice_lock_off'}));
}
let voiceAudio=null, voiceAudioUrl=null;
async function playVoice(id){                    // GET /voices/{id}/audio
  try{
    if(voiceAudio){voiceAudio.pause();voiceAudio=null;}
    if(voiceAudioUrl){URL.revokeObjectURL(voiceAudioUrl);voiceAudioUrl=null;}
    // fetched rather than linked, because the route wants the token
    voiceAudioUrl=await Store.voices.audioBlobUrl(id);
    if(!voiceAudioUrl){stopPlay();return;}
    voiceAudio=new Audio(voiceAudioUrl);
    // a clip that reaches its end leaves the row showing a pause glyph otherwise
    voiceAudio.onended=()=>stopPlay();
    voiceAudio.play().catch(()=>{});
  }catch{ stopPlay(); }
}

/* ── what the account has been charged ───────────────────────────────────────
   The panel used to read a copy the page kept for itself, so it showed a number
   the account had never agreed to and clearing the browser looked like free
   minutes. It reads the account now.

   Fetched exactly twice — when the page opens, and when the panel is opened, in
   case another device recorded. There is no timer: while a recording runs the
   socket sends the total each time a chunk is billed, which is the only moment
   it can change, and a paused recording bills nothing and so sends nothing. */
let USAGE_ALLOWANCE={live:20*60,upload:30*60};
/* Kept because the panel is built by auth.js after Clerk settles, which can be
   later than the first answer from the server — and later than the first chunk
   billed. Without this the numbers arrive before anything exists to show them. */
let USAGE_LAST={live:null,upload:null};
function showUsage(liveSeconds,uploadSeconds){
  if(liveSeconds!=null)USAGE_LAST.live=liveSeconds;
  if(uploadSeconds!=null)USAGE_LAST.upload=uploadSeconds;
  const set=(id,used,limit)=>{
    const t=document.getElementById(id+'-usage-text');
    const b=document.getElementById(id+'-usage-bar');
    if(!t||used==null)return;
    t.textContent=(used/60).toFixed(1)+' / '+Math.round(limit/60)+' min';
    if(b)b.style.width=Math.min(used/limit*100,100)+'%';
  };
  set('live',liveSeconds,USAGE_ALLOWANCE.live);
  set('upload',uploadSeconds,USAGE_ALLOWANCE.upload);
}
async function loadUsage(){
  try{
    const res=await api('/me');
    if(!res||!res.ok)return;                  // signed out: the panel is not shown anyway
    const m=await res.json();
    USAGE_ALLOWANCE={live:m.live_allowance,upload:m.upload_allowance};
    showUsage(m.live_seconds,m.upload_seconds);
  }catch{}
}
/* The panel is built by auth.js, so this listens for the click rather than
   owning the markup — in the CAPTURE phase, because auth.js's own handler calls
   stopPropagation() on the avatar and a listener waiting for the click to bubble
   never hears it. Capture runs on the way down, before the target.

   auth.js then writes its localStorage copy into the panel, so the account's own
   numbers are put back once they are in hand: last known immediately, so the
   panel is never blank, and the fetched ones a moment later. */
document.addEventListener('click',e=>{
  if(!e.target.closest('#user-avatar'))return;
  setTimeout(()=>{
    showUsage(USAGE_LAST.live,USAGE_LAST.upload);
    loadUsage();
  },0);
},true);

