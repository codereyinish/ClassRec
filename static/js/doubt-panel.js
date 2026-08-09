// doubt-panel.js — the AI panel
// Handles: what a question is asking about, and the colouring that shows it.
// Depends on live.js, which loads first.
/* ── what the question is about ───────────────────────────────────────────────
   A chip per block, carrying the block itself rather than a copy of its text, so
   clicking one can take you back to where it was said. Attached by the Ask icon
   and by + ; selecting words fills the question instead, since a selection is
   what you want to ask about rather than another thing to carry. */
const ctxChips=document.getElementById('ctxChips');
const askInput=document.getElementById('askInput');
const attached=[];                         // the blocks, in the order they were added

function blockStamp(c){
  const el=c.querySelector('.timestamp');
  return el&&el.firstChild?el.firstChild.textContent.trim():'';
}
function renderChips(){
  ctxChips.innerHTML='';
  attached.forEach((c,i)=>{
    const words=blockText(c).split(/\s+/).slice(0,5).join(' ');
    const chip=document.createElement('span');
    chip.className='ctx-chip';
    chip.title=blockStamp(c);          // the time is available, without taking the room
    /* Quotation marks, drawn in the same hand as the rest of the page's icons —
       it names what the chip is (a passage) without a word for it. */
    chip.innerHTML=`<span class="go">`
                 + `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
                 + `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">`
                 + `<path d="M9 7H5.5A1.5 1.5 0 0 0 4 8.5V12h5V7zM9 12c0 3-1.6 4.6-4 5"/>`
                 + `<path d="M20 7h-3.5A1.5 1.5 0 0 0 15 8.5V12h5V7zM20 12c0 3-1.6 4.6-4 5"/></svg>`
                 + `<span class="lbl">${esc(words)}…</span></span>`
                 + `<button class="x" type="button" aria-label="Remove">`
                 + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" `
                 + `stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    chip.querySelector('.go').onclick=()=>locate(c);
    chip.querySelector('.x').onclick=()=>{attached.splice(i,1);renderChips();};
    ctxChips.appendChild(chip);
  });
}
function attachContext(c){
  if(!attached.includes(c))attached.push(c);
  renderChips();
}
/* Take me back to what I attached. The tint leaves on its own, because a block
   that stays highlighted stops meaning "this is the one you asked about". */
function locate(c){
  c.scrollIntoView({behavior:'smooth',block:'center'});
  c.classList.add('located');
  setTimeout(()=>c.classList.remove('located'),1600);
}

/* The field grows with what is in it rather than scrolling inside a fixed line —
   a question about a lecture is usually a sentence, not a search box. */
const growAsk=()=>{askInput.style.height='auto';
                   askInput.style.height=Math.min(askInput.scrollHeight,180)+'px';};
askInput.addEventListener('input',growAsk);

/* Selecting words in the transcript puts them in the question. Only a selection
   inside the stream counts — selecting the title, or text in the rail, is not
   someone asking about the lecture. The panel is filled but not opened: pulling
   it over the page every time you highlight something to copy would be worse
   than useless. */
let lastSelBlock=null;
const ctxAdd=document.getElementById('ctxAdd');
document.addEventListener('selectionchange',()=>{
  const sel=getSelection();
  if(!sel||sel.isCollapsed)return;
  const node=sel.anchorNode;
  const el=node&&(node.nodeType===1?node:node.parentElement);
  const block=el&&el.closest('.stream .chunk');
  if(!block)return;
  const text=sel.toString().replace(/\s+/g,' ').trim();
  if(!text)return;
  lastSelBlock=block;
  ctxAdd.disabled=false;
  askInput.value=text;
  growAsk();
});

/* + carries the block the selection is in, which is the one being read. Without
   a selection there is nothing to point at, so it stays disabled rather than
   guessing. */
ctxAdd.onclick=()=>{if(lastSelBlock)attachContext(lastSelBlock);};
document.getElementById('aiX').onclick=()=>B.classList.remove('ai-open');

