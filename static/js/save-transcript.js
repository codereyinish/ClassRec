// save-transcript.js — keeping a lecture
// Handles: POST /sessions with the body the server expects.
// Depends on live.js, which loads first.
/* ── saving : POST /sessions with the body save-transcript.js sends ── */
async function saveSession(){
  /* A recorded lecture is already in the database — the server wrote it there a
     chunk at a time as it arrived, which is what makes a closed tab survivable.
     So Save names that row rather than sending the transcript again, and pressing
     it twice renames one lecture instead of creating a second. */
  if(liveSessionId!==null){
    const sel=VOICES.find(v=>v.sel);
    try{
      const res=await Store.sessions.rename(liveSessionId,{
        title:titleEl.textContent.trim()||'Untitled',
        voice_id:(sel&&sel.id)||null,
      });
      if(res&&res.ok){setConn('on','Saved · session '+liveSessionId);return true;}
      if(res&&res.status===401){setConn('off','Not saved — sign in to keep lectures');return false;}
    }catch{}
    setConn('off','Saved, but could not be renamed');
    return false;
  }

  /* Nothing was recorded through this page — an upload, or a transcript that
     arrived some other way. There is no row yet, so one is created. */
  const sel=VOICES.find(v=>v.sel);
  const text=[...document.querySelectorAll('.transcript-text')]
    .map(t=>t.textContent.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n\n');
  const wordEls=[...document.querySelectorAll('#transcriptContent span.word, .stream span.word')];
  const body={
    title:titleEl.textContent.trim()||'Untitled',
    transcript:text,
    voice_id:(sel&&sel.id)||null,                // the Voice used, as the server names it
  };
  if(wordEls.length)body.words=wordEls.map(w=>({w:w.textContent,s:+w.dataset.start,e:+w.dataset.end}));
  try{
    let res=await Store.sessions.save(body);

    /* Saving is the moment an account becomes necessary — a lecture has to
       belong to someone. A visitor records freely and is asked to sign in only
       here, then the same save goes through without them repeating anything. */
    if(res&&res.status===401&&window.Clerk){
      setConn('wait','Sign in to save this lecture');
      try{ await window.Clerk.openSignIn(); }catch{}
      await new Promise(r=>setTimeout(r,400));      // let the session settle
      if(window.Clerk.session){
        await refreshForUser();                     // their voices and lectures
        res=await Store.sessions.save(body);        // retry with the token
      }
    }

    if(res&&res.ok){const j=await res.json().catch(()=>({}));
      setConn('on','Saved · session '+(j.id??''));return true;}
    if(res&&res.status===401){setConn('off','Not saved — sign in to keep lectures');return false;}
  }catch{}
  setConn('off','Saved locally only');
  return false;
}

/* Signing in mid-session changes who the page is for, so the lists it loaded as
   a visitor — empty — are fetched again as them. */
/* Each part stands on its own. They ran in a chain inside a caller that swallows
   errors, so one of them throwing took the rest with it silently — which is how
   the usage panel sat at zero while the account had been charged eighteen
   minutes: it was simply never asked for. */
async function refreshForUser(){
  for(const step of [loadUsage,loadVoices,seedTitles]){
    try{ await step(); }
    catch(e){ console.warn('[classrec] '+step.name+' failed', e); }
  }
}

