// voice-picker.js — choosing a saved voice, and enrolling a new one
// Handles: the .vp-* popup, and hold-to-enrol with the naming step after it.
// Depends on live.js, which loads first.
/* ── voice picker ─────────────────────────────────────────────── */
const VOICES=[
  {n:'Zamaigas_audio.wav',d:'0:24',sel:true},
  {n:'Prof. Whitaker — CS 301',d:'0:31',sel:false},
  {n:'Dr. Osei — lecture hall',d:'0:18',sel:false},
];
/* Real voices when the app is up, the samples above when it is not. id is what
   `use_saved_voice` and POST /sessions both call voice_id. */
async function loadVoices(){
  try{
    const rows=await Store.voices.list();
    if(!Array.isArray(rows))return;
    VOICES.length=0;
    rows.forEach((v,i)=>VOICES.push({id:v.id,n:v.name,voice:v.voice_name||'',
                                     d:v.use_count?('used '+v.use_count+'×'):'—',
                                     hasAudio:v.has_audio,sel:i===0}));
    renderVoices();
    if(VOICES.length&&B.classList.contains('lockon'))B.classList.add('locked');
  }catch{ /* offline: keep the samples */ }
}

/* Courses are local and unrelated to the voice fetch, so they load on their own —
   a backend that is down must not cost you your class list. */
async function loadCourses(){
  await Store.classes.load();
  renderClasses();         // stays unset until picked: nothing is chosen for you
}
const vp=document.getElementById('vp'),vpList=document.getElementById('vpList'),
      vpStatus=document.getElementById('vpStatus');
const TRASH='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
const vpStart=document.getElementById('vpStart');
let playing=null;   // {name, arrow} of the row currently playing
const stopPlay=()=>{
  /* Stop the audio, not just the arrow. This only reset the row's appearance,
     so clicking a playing voice again looked like it did nothing, and closing
     the picker left a clip talking over the page. */
  try{ if(voiceAudio){voiceAudio.pause();voiceAudio.currentTime=0;voiceAudio=null;} }catch{}
  if(voiceAudioUrl){URL.revokeObjectURL(voiceAudioUrl);voiceAudioUrl=null;}
  if(!playing)return;
  playing.name.classList.remove('playing');
  playing.arrow.textContent='▸';playing.arrow.classList.remove('on');
  playing=null;
};
// reflect the current selection everywhere it's shown
function syncSelection(){
  const v=VOICES.find(o=>o.sel);
  document.getElementById('voicebtnTxt').textContent=v?v.n:'Select voice';
  vpStart.hidden=!v;          // nothing to start a session with
}
function renderVoices(editIdx){
  playing=null;   // rows are rebuilt below; the old refs are about to be detached
  if(!VOICES.length){
    /* A new account lands here. "No voices yet" states a fact and leaves you
       stuck; the two ways out are already in this panel, so say which. */
    vpList.innerHTML='<div class="vp-empty">'
      +'<strong>No voices yet</strong>'
      +'<span>Hold the microphone for ten seconds while your professor is talking, '
      +'or upload a clip of them.</span></div>';
    syncSelection();return;
  }
  vpList.innerHTML='';
  VOICES.forEach((v,i)=>{
    const row=document.createElement('div');
    row.className='vp-item'+(v.sel?' selected':'');
    row.innerHTML=`<span class="vp-item-name">${v.n}${v.voice?`<em class="vsub">${v.voice}</em>`:''}</span>
      <span class="vp-gap"></span>
      <span class="vp-dur">${v.d}</span>
      <span class="vp-item-arrow">▸</span>
      <button class="vp-trash" aria-label="Delete voice">${TRASH}</button>`;
    const name=row.querySelector('.vp-item-name');
    // row click selects; name click plays; dblclick renames
    // the ring and the slot both say which voice is picked; a sentence saying it
    // again is just noise
    /* Selecting marks the rows in place rather than rebuilding the list. The
       rebuild replaced every node on the first click of a double-click, so the
       second landed on a new element and dblclick never fired — renaming only
       worked on the name itself, which stops propagation and so never triggered
       the rebuild. */
    row.onclick=()=>{
      VOICES.forEach(o=>o.sel=false); v.sel=true;
      [...vpList.children].forEach((el,idx)=>el.classList.toggle('selected',idx===i));
      syncSelection();
      useSavedVoice(v);                       // {type:'use_saved_voice', voice_id}
      B.classList.add('locked');
      if(!isBusy())setActivity('');   // picking a voice mid-recording must not end it
      vpStatus.textContent='';};
    const arrow=row.querySelector('.vp-item-arrow');
    /* Playable only when the server actually holds a clip for it. A voice
       captured in this session has no id until it is saved, and nothing is
       stored for it — the row used to show the pause glyph regardless, so the
       control sat there claiming to play something that did not exist. */
    const playable = !!(v.id && v.hasAudio);
    if(!playable) arrow.classList.add('mute');
    const toggle = e => {
      e.stopPropagation();
      if(playing&&playing.name===name){stopPlay();return;}
      stopPlay();
      if(!playable) return;                                             // nothing to play
      playVoice(v.id);                                                  // GET /voices/{id}/audio
      name.classList.add('playing');arrow.textContent='||';arrow.classList.add('on');
      playing={name,arrow};
    };
    name.onclick=toggle;
    arrow.onclick=toggle;      // the glyph is a control, so it takes the click too
    const startEdit=()=>{
      name.contentEditable='true';name.classList.add('editing');
      row.classList.add('editing');   // the whole box is a field now, not a target
      name.focus();
      const r=document.createRange();r.selectNodeContents(name);
      r.collapse(false);      // caret at the end, not the whole name selected —
                              // renaming is usually a correction, not a retype
      const s=getSelection();s.removeAllRanges();s.addRange(r);
      name.onkeydown=ev=>{
        if(ev.key==='Enter'){ev.preventDefault();name.blur();stopPlay();vp.classList.remove('open');}
        if(ev.key==='Escape'){name.textContent=v.n;name.blur();}
      };
      name.onblur=async()=>{
        name.contentEditable='false';name.classList.remove('editing');row.classList.remove('editing');
        const nn=name.textContent.trim()||v.n;
        const was=v.n; v.n=nn;name.textContent=nn;syncSelection();
        if(v.pending){                    // just held: this is the moment it is saved
          v.pending=false;
          await saveEnrolledVoice(nn);    // POST /voices — embedding computed, row written
          return;
        }
        if(v.id&&nn!==was)Store.voices.rename(v.id,nn).catch(()=>{});   // PATCH /voices/{id}
      };
    };
    /* Anywhere in the row, not only on the name itself — the row is the voice,
       and hunting for the few pixels the text happens to occupy is a worse
       target the shorter the name is. The bin keeps its own click. */
    row.ondblclick=e=>{
      if(e.target.closest('.vp-trash'))return;
      e.stopPropagation();
      startEdit();
    };
    if(i===editIdx)setTimeout(startEdit,60);   // freshly captured → name it now
    row.querySelector('.vp-trash').onclick=e=>{e.stopPropagation();
      if(v.id)Store.voices.remove(v.id).catch(()=>{});                  // DELETE /voices/{id}
      VOICES.splice(i,1);renderVoices();
      // deleting the locked voice unlocks: the badge and "click to start" were
      // outliving the thing they described, leaving "Select voice" next to a padlock
      if(!VOICES.some(o=>o.sel)){
        B.classList.remove('locked');
        if(!isBusy())setActivity('');
      }
      vpStatus.className='vp-status';vpStatus.textContent='Deleted.';};
    vpList.appendChild(row);
  });
  syncSelection();
}

// a ≥10s hold captured a sample: file it as Untitled N, select it, open the
// picker with the name already in edit mode
let untitledN=0;
function addCapturedVoice(secs){
  untitledN++;
  VOICES.forEach(o=>o.sel=false);
  VOICES.unshift({n:'Voice '+untitledN,d:'0:'+String(secs).padStart(2,'0'),sel:true,pending:true});
  vp.classList.add('open');
  /* No status line here: the row is already at the top of the list in edit mode
     with "Voice N" in the field, which says the same thing twice over. */
  vpStatus.className='vp-status';
  vpStatus.textContent='';
  renderVoices(0);
}
/* Dismissing without typing is the skip: the generated name stands and the voice is
   still saved, rather than the sample being thrown away. */
async function acceptPendingName(){
  const p=VOICES.find(v=>v.pending);
  if(!p||!pendingSample)return;
  p.pending=false;
  await saveEnrolledVoice(p.n);
}
renderVoices();
document.getElementById('voicebtn').onclick=()=>{vp.classList.add('open');vpStatus.textContent='';};
vp.onclick=e=>{if(e.target===vp){acceptPendingName();stopPlay();vp.classList.remove('open');}};
// "Record new" — back to the rail with the prompt showing, so the next hold enrols
document.getElementById('vpRecordNew').onclick=()=>{
  acceptPendingName();
  stopPlay();
  vp.classList.remove('open');
  vpStatus.textContent='';
  showHint();
};
// "Start session" — commits the picked voice and goes straight into recording
vpStart.onclick=()=>{
  if(!B.classList.contains('rec')){vp.classList.remove('open');stopPlay();startRecording();}
  else {vp.classList.remove('open');stopPlay();}
};
// Upload — the other way to get a sample in. Named from the file, selected on arrival.
const vpFile=document.getElementById('vpFile');
document.getElementById('vpUpload').onclick=()=>vpFile.click();
vpFile.onchange=async()=>{
  const f=vpFile.files&&vpFile.files[0];
  if(!f)return;
  const named=f.name.replace(/\.[^.]+$/,'');
  try{
    const res=await Store.voices.add(named,f);                          // POST /voices?name=
    if(res&&res.ok){await loadVoices();vpStatus.className='vp-status ok';
      vpStatus.textContent='Uploaded — “'+named+'” enrolled';vpFile.value='';return;}
  }catch{}
  VOICES.forEach(o=>o.sel=false);
  VOICES.unshift({n:f.name,d:'0:00',sel:true});
  B.classList.add('locked');
  if(!isBusy())setActivity('');
  renderVoices();
  vpStatus.className='vp-status ok';vpStatus.textContent='Uploaded — locked to “'+f.name+'”';
  vpFile.value='';
};

/* ── enrolment : hold 10s → name it → saved ──────────────────────────────────
   The sample is kept as it streams, wrapped as a WAV on release, and posted to
   POST /voices — the one call that computes an embedding and writes the row. The
   socket's enroll_start/end pair is not used here: it locks a voice for the current
   connection and stores nothing, so a voice held that way is gone with the tab. */
let enrolBuf=[], enrolCapturing=false;
function wavFromPcm(chunks,rate){
  let n=0; chunks.forEach(c=>n+=c.length);
  const pcm=new Int16Array(n); let o=0; chunks.forEach(c=>{pcm.set(c,o);o+=c.length;});
  const buf=new ArrayBuffer(44+pcm.length*2), v=new DataView(buf);
  const str=(off,t)=>{for(let i=0;i<t.length;i++)v.setUint8(off+i,t.charCodeAt(i));};
  str(0,'RIFF'); v.setUint32(4,36+pcm.length*2,true); str(8,'WAVE');
  str(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,rate,true); v.setUint32(28,rate*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  str(36,'data'); v.setUint32(40,pcm.length*2,true);
  new Int16Array(buf,44).set(pcm);
  return new Blob([buf],{type:'audio/wav'});
}
let pendingSample=null;                       // the WAV waiting for a name

async function beginEnrol(){
  try{ if(!audioCtx)await startCapture(); }catch{}
  enrolBuf=[];enrolCapturing=true;
}
function finishEnrol(seconds){
  enrolCapturing=false;
  if(!enrolBuf.length)return null;
  pendingSample=wavFromPcm(enrolBuf,SR);
  enrolBuf=[];
  return pendingSample;
}
/* Named (or skipped, which generates one) → the voice is saved and listed. */
async function saveEnrolledVoice(name){
  if(!pendingSample)return false;
  const nm=(name||'').trim()||('Voice '+(VOICES.length+1));
  try{
    const fd=new FormData(); fd.append('file',pendingSample,'enrolment.wav');
    const res=await fetch(API+'/voices?name='+encodeURIComponent(nm),{method:'POST',body:fd});
    if(!res.ok){vpStatus.className='vp-status error';
      vpStatus.textContent=(await res.json().catch(()=>({}))).detail||'Could not save the voice';
      return false;}
    const saved=await res.json();
    pendingSample=null;
    await loadVoices();                        // it now appears in the list
    const row=VOICES.find(v=>v.id===saved.id);
    if(row){VOICES.forEach(o=>o.sel=false);row.sel=true;renderVoices();useSavedVoice(row);}
    vpStatus.className='vp-status ok';vpStatus.textContent='Saved — “'+nm+'”';
    return true;
  }catch{ vpStatus.className='vp-status error';vpStatus.textContent='Server unreachable — kept locally';
    return false; }
}

/* ── enrolment over the wire (unused by the hold, kept for reference) ── */
async function enrolStart(){
  try{
    await openSocket();
    if(!audioCtx)await startCapture();
    enrolling=true;ws.send(JSON.stringify({type:'enroll_start'}));
  }catch{ /* offline: the local 10s rule still applies */ }
}
function enrolEnd(ok){
  if(!enrolling||!ws||ws.readyState!==1)return false;
  if(ok){ws.send(JSON.stringify({type:'enroll_end'}));return true;}   // wait for enroll_success
  enrolling=false;return false;
}

/* The page opens empty and fills from the socket — the mock's "already finished a
   lecture" scaffolding is deliberately not carried over. */
loadVoices(); loadCourses(); applyAutoTitle(); seedTitles();

/* Those four ran before Clerk had finished loading, so they went out without a
   token and came back empty. Once Clerk settles — and again whenever the signed
   in user changes — they are re-run as whoever is now signed in. */
(async()=>{
  try{
    await window.__clerk_loaded;
    if(!window.Clerk)return;
    if(window.Clerk.session)await refreshForUser();
    window.Clerk.addListener(({user})=>{ refreshForUser(); });
    /* A second chance for the usage, a moment later. The panel is built by
       auth.js once Clerk settles, and the numbers above can be in hand before
       anything exists to put them in. */
    setTimeout(()=>{ if(window.Clerk&&window.Clerk.session)loadUsage(); },1200);
  }catch{}
})();
