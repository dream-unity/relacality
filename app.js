import { KEYS, FORMS } from './ontology.js';
import { AudioEngine, createDefaultClocks, normalizeClock } from './audio-engine.js';
import { generateChallenge, evaluatePerformance, generateComparison } from './game-engine.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const keyById = new Map(KEYS.map(key => [key.id, key]));
const keyByCode = new Map(KEYS.map(key => [key.code, key]));
const colours = ['#c5e891', '#88cddd', '#f0bb82', '#b7acf3', '#eea9c6', '#e5d475'];
const voiceOptions = [['wood','Wood'],['bell','Bell'],['click','Click'],['rim','Rim'],['glass','Glass'],['pulse','Pulse']];
const settingsKey = 'relacality.settings.v1';
let storageAvailable = true;
function readStored(key, fallback) { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { storageAvailable = false; return fallback; } }
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { storageAvailable = false; $('#storage-status').textContent = 'Browser storage is unavailable. You can still play and export a phrase.'; } }
const saved = readStored(settingsKey, {});
let clocks = Array.isArray(saved.clocks) && saved.clocks.length === 6 ? saved.clocks.map(normalizeClock) : createDefaultClocks();
let mode = 'free';
let level = 1;
let challenge = null;
let comparison = null;
let questionAnswered = false;
let comparisonAnswered = false;
let practice = null;
let playback = null;
let recordStart = null;
let recording = [];
let recordingTimer = null;
let toastTimer;
let generation = 0;
let pendingAction = false;
let lastClockSettings = '';
let lastCueMode = '';
let lastPianoEnabled = null;
const held = new Map();
const pointerNotes = new Map();
const lastBeat = new Map();
const answered = { correct: 0, total: 0 };

const engine = new AudioEngine({
  onTransport({ reason }) {
    if(reason==='audio-suspended') {
      allQuiet();
      notify('Audio was interrupted. The clocks are paused; start again when ready.');
    }
  },
  onBeat({ clockIndex, beatIndex }) {
    const card = $(`.clock-card[data-index="${clockIndex}"]`);
    if (!card) return;
    card.querySelectorAll('.beat-dot').forEach((dot, index) => dot.classList.toggle('is-current', index === beatIndex));
    lastBeat.set(clockIndex, performance.now());
  }
});
function safeText(value) { return String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])); }
function notify(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function persistSettings() { store(settingsKey, { clocks, master: Number($('#master-volume').value), piano: $('#piano-sound').checked, cue: $('#cue-mode').value }); }
function syncAudio() {
  const clockSettings=JSON.stringify(clocks);
  if(clockSettings!==lastClockSettings){engine.setClocks(clocks);lastClockSettings=clockSettings;}
  engine.setMasterVolume(Number($('#master-volume').value) / 100);
  if(lastPianoEnabled!==$('#piano-sound').checked){engine.setPianoEnabled($('#piano-sound').checked);lastPianoEnabled=$('#piano-sound').checked;}
  if(lastCueMode!==$('#cue-mode').value){engine.setCueMode($('#cue-mode').value);lastCueMode=$('#cue-mode').value;}
  $('#enabled-count').textContent = `${clocks.filter(clock => clock.enabled).length} / 6 clocks`;
  persistSettings();
}
async function readyAudio() {
  try { await engine.unlock(); $('#audio-state').textContent = $('#piano-sound').checked ? 'Piano ready' : 'Key sound off'; return true; }
  catch { $('#audio-state').textContent = 'Audio unavailable'; notify('Audio could not start. Try a current browser and press a key again.'); return false; }
}
async function runAudioAction(action) {
  if(pendingAction)return;
  const token=generation;pendingAction=true;
  try {if(await readyAudio() && token===generation)await action();}
  finally {pendingAction=false;}
}

function renderKeys() {
  $('#piano-keys').innerHTML = FORMS.map(form => `<div class="key-row" data-form="${form.id}"><div class="key-row-label"><strong>${safeText(form.label)}</strong><span>${form.id === 'archetypal' ? 'The operation' : form.id === 'inner' ? 'From within' : 'Outward relation'}</span></div><div class="key-bank">${KEYS.filter(key => key.form === form.id).map(key => `<button type="button" class="piano-key" data-key-id="${key.id}" data-form="${key.form}" aria-label="${safeText(key.name)} — ${safeText(key.key)} key" aria-pressed="false" title="${safeText(key.name)}: ${safeText(key.description)}"><kbd class="key-shortcut">${safeText(key.key)}</kbd><span class="key-category">${key.categoryId==='multiplication'?'Unfoldment':key.categoryId==='encompassment'?'Encompass&shy;ment':safeText(key.category)}</span><span class="key-note">${safeText(noteName(key.midi))}</span></button>`).join('')}</div></div>`).join('');
}
function noteName(midi) { const pitches=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B']; return pitches[midi%12]+(Math.floor(midi/12)-1); }
function inspectKey(key) { $('#active-key-name').textContent = key.name; $('#active-key-description').textContent = key.description; }
function paintHeld(keyId, state) { const button=$(`[data-key-id="${keyId}"]`); if(button) { button.classList.toggle('is-held',state); button.setAttribute('aria-pressed',String(state)); } }
function isTyping(target) { return target instanceof Element && (target.matches('input, textarea, select') || target.isContentEditable); }
async function pressKey(key, source) {
  if (held.has(source)) return;
  const token = generation;
  const entry = { key, began: performance.now(), noteId:`input-${source}`, record:null, performance:null, cancelled:false };
  held.set(source,entry); paintHeld(key.id,true); inspectKey(key);
  if (recordStart !== null) { entry.record={keyId:key.id,onset:(entry.began-recordStart)/1000,duration:.15}; recording.push(entry.record); renderPhrase(); }
  if (practice && practice.type === 'perform') {
    const onset=(engine.elapsed-practice.startElapsed)/practice.beatSeconds;
    if (onset >= -.45 && onset <= challenge.lengthBeats+.5) { entry.performance={keyId:key.id,onset,duration:0}; practice.events.push(entry.performance); }
  }
  if (!await readyAudio() || token!==generation || entry.cancelled || held.get(source)!==entry) return;
  engine.noteOn(entry.noteId,key.midi,.75);
}
function releaseKey(source) {
  const entry=held.get(source); if(!entry)return;
  entry.cancelled=true;
  const duration=Math.max(.015,(performance.now()-entry.began)/1000);
  if(entry.record)entry.record.duration=duration;
  if(entry.performance && practice)entry.performance.duration=duration/practice.beatSeconds;
  engine.noteOff(entry.noteId); held.delete(source);
  if(![...held.values()].some(other=>other.key.id===entry.key.id))paintHeld(entry.key.id,false);
}
function releaseInputs() { [...held.keys()].forEach(releaseKey); pointerNotes.clear(); }
function allQuiet(message=false) {
  generation++; releaseInputs(); engine.releaseAll();
  if(playback) { playback=null; $('#replay-button').textContent='▶ Replay'; }
  KEYS.forEach(key=>paintHeld(key.id,false));
  if(practice)cancelPractice('Performance stopped. Try again when you are ready.');
  if(message)notify('All notes released.');
}
document.addEventListener('keydown',event=>{
  if(event.code==='Escape') { allQuiet(true); return; }
  if(event.repeat || event.ctrlKey || event.altKey || event.metaKey || isTyping(event.target))return;
  const key=keyByCode.get(event.code); if(!key)return;
  event.preventDefault(); pressKey(key,`keyboard-${event.code}`);
});
document.addEventListener('keyup',event=>{if(keyByCode.has(event.code))releaseKey(`keyboard-${event.code}`);});
$('#piano-keys').addEventListener('pointerdown',event=>{
  const button=event.target.closest('[data-key-id]'); if(!button || event.button>0)return;
  event.preventDefault(); button.focus({preventScroll:true});
  const source=`pointer-${event.pointerId}`; pointerNotes.set(event.pointerId,source);
  button.setPointerCapture?.(event.pointerId); pressKey(keyById.get(button.dataset.keyId),source);
});
for(const name of ['pointerup','pointercancel','lostpointercapture'])document.addEventListener(name,event=>{const source=pointerNotes.get(event.pointerId);if(source){releaseKey(source);pointerNotes.delete(event.pointerId);}});
$('#piano-keys').addEventListener('click',event=>{
  if(event.detail!==0)return; // Keyboard/screen-reader activation of a focused pad.
  const button=event.target.closest('[data-key-id]');if(!button)return;
  const source=`accessible-${button.dataset.keyId}`;pressKey(keyById.get(button.dataset.keyId),source);setTimeout(()=>releaseKey(source),350);
});
$('#piano-keys').addEventListener('focusin',event=>{const button=event.target.closest('[data-key-id]');if(button)inspectKey(keyById.get(button.dataset.keyId));});
$('#release-notes').addEventListener('click',()=>allQuiet(true));

function renderClocks() {
  $('#clock-grid').innerHTML=clocks.map((clock,index)=>`<article class="clock-card ${clock.enabled?'is-enabled':''}" data-index="${index}" style="--clock-color:${colours[index]}"><div class="clock-header"><label class="clock-enable"><input type="checkbox" data-setting="enabled" ${clock.enabled?'checked':''} aria-label="Enable clock ${index+1}"><span>Clock ${String(index+1).padStart(2,'0')}</span></label><span class="clock-state">${clock.enabled?'Ready':'Off'}</span></div><div class="clock-fields"><label class="bpm-field">BPM<input type="number" data-setting="bpm" min="1" max="240" step="1" value="${clock.bpm}" aria-label="Clock ${index+1} BPM"></label><label class="beats-field">Beats / bar<input type="number" data-setting="beats" min="1" max="16" step="1" value="${clock.beats}" aria-label="Clock ${index+1} beats per bar"></label><label class="voice-field">Sound<select data-setting="voice" aria-label="Clock ${index+1} sound">${voiceOptions.map(([id,label])=>`<option value="${id}" ${clock.voice===id?'selected':''}>${label}</option>`).join('')}</select></label><label class="phase-field">Start offset <span>(beats)</span><input data-setting="phase" type="number" min="0" max="16" step="0.25" value="${clock.phase}" aria-label="Clock ${index+1} start offset"></label></div><div class="beat-pattern" aria-label="Clock ${index+1} beat pattern">${clock.pattern.map((value,beat)=>`<button type="button" class="beat-dot" data-beat="${beat}" data-value="${value}" title="Beat ${beat+1}: ${['silent','normal','accent'][value]}. Press to change." aria-label="Clock ${index+1}, beat ${beat+1}: ${['silent','normal','accent'][value]}">${beat+1}</button>`).join('')}</div><label class="clock-volume">Volume<input type="range" data-setting="volume" min="0" max="100" value="${Math.round(clock.volume*100)}" aria-label="Clock ${index+1} volume"></label><div class="clock-progress" aria-hidden="true"><span></span></div></article>`).join('');
}
function changeClock(index,field,value) {
  if(practice)cancelPractice('Clock settings changed. Start the performance again.');
  const current=clocks[index];
  let changed={...current,[field]:value};
  if(field==='beats')changed.pattern=Array.from({length:Math.max(1,Math.min(16,Math.round(Number(value)||1)))},(_,beat)=>current.pattern[beat]??(beat===0?2:1));
  clocks[index]=normalizeClock(changed,index);
  $('#rhythm-preset').value='custom';syncAudio();
  // Preserve range dragging; recreate cards only after discrete field changes.
  if(field!=='volume')renderClocks();
  if(mode==='reason' && !practice)renderPractice();
}
$('#clock-grid').addEventListener('change',event=>{
  const field=event.target.dataset.setting;if(!field)return;
  const index=Number(event.target.closest('.clock-card').dataset.index);
  const value=field==='enabled'?event.target.checked:field==='voice'?event.target.value:field==='volume'?Number(event.target.value)/100:Number(event.target.value);
  changeClock(index,field,value);
});
$('#clock-grid').addEventListener('input',event=>{if(event.target.dataset.setting==='volume'){const index=Number(event.target.closest('.clock-card').dataset.index);clocks[index].volume=Number(event.target.value)/100;syncAudio();}});
$('#clock-grid').addEventListener('click',event=>{
  const button=event.target.closest('[data-beat]');if(!button)return;
  const index=Number(button.closest('.clock-card').dataset.index);const beat=Number(button.dataset.beat);
  const pattern=[...clocks[index].pattern];pattern[beat]=(pattern[beat]+1)%3;changeClock(index,'pattern',pattern);
});
$('#rhythm-preset').addEventListener('change',event=>{
  const name=event.target.value;if(name==='custom')return;
  if(practice)cancelPractice('New rhythm loaded. Start the performance again.');
  engine.stop();clocks=createDefaultClocks();
  const presets={steady:[[80,4]],'three-two':[[90,3],[60,2]],'odd-even':[[100,5],[80,4]],nested:[[120,4],[60,4],[30,4]],six:[[60,2],[90,3],[120,4],[150,5],[180,6],[210,7]]};
  const chosen=presets[name];
  clocks=clocks.map((clock,index)=>normalizeClock({...clock,enabled:index<chosen.length,bpm:chosen[index]?.[0]??80,beats:chosen[index]?.[1]??clock.beats,voice:voiceOptions[index][0],pattern:Array.from({length:chosen[index]?.[1]??clock.beats},(_,i)=>i===0?2:1),phase:0},index));
  renderClocks();syncAudio();renderPractice();notify('Rhythm loaded. Press Start clocks when ready.');
});
$('#master-volume').value=Number.isFinite(saved.master)?Math.max(0,Math.min(100,saved.master)):65;
$('#piano-sound').checked=saved.piano!==false;
$('#cue-mode').value=['continuous','fade','silent'].includes(saved.cue)?saved.cue:'continuous';
$('#master-volume').addEventListener('input',syncAudio);
$('#piano-sound').addEventListener('change',()=>{syncAudio();$('#audio-state').textContent=$('#piano-sound').checked?'Piano ready':'Key sound off';});
$('#cue-mode').addEventListener('change',syncAudio);
$('#transport-toggle').addEventListener('click',async()=>{
  if(practice){cancelPractice('Performance cancelled.');return;}
  if(engine.running){allQuiet();engine.pause();}else await runAudioAction(()=>engine.start());
});
$('#transport-stop').addEventListener('click',()=>{allQuiet();engine.stop();lastBeat.clear();$$('.beat-dot').forEach(dot=>dot.classList.remove('is-current'));});

function formatTime(seconds) { const total=Math.max(0,Math.floor(seconds));return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`; }
function renderPhrase() {
  $('#recording-status').textContent=recordStart!==null?'Recording…':recording.length?`${recording.length} notes`:'No recording yet';
  $('#replay-button').disabled=recordStart!==null || !recording.length;
  $('#export-button').disabled=recordStart!==null || !recording.length;
  $('#phrase-strip').innerHTML=recording.length?recording.slice(-30).map(event=>{const key=keyById.get(event.keyId);return `<span class="phrase-note" data-form="${key.form}" title="${safeText(key.name)} · ${event.onset.toFixed(2)} seconds"><kbd>${safeText(key.key)}</kbd><span>${safeText(key.category)}</span><small>${event.onset.toFixed(1)}s</small></span>`;}).join(''):'<p>Your notes appear here as you play.</p>';
}
function stopRecording() {
  if(recordStart===null)return;
  releaseInputs();recordStart=null;clearTimeout(recordingTimer);$('#record-button').textContent='● Record keys';$('#record-button').classList.remove('is-recording');
  store('relacality.phrase.v1',recording);renderPhrase();
}
$('#record-button').addEventListener('click',async()=>{
  if(recordStart!==null){stopRecording();return;}
  await runAudioAction(()=>{
    allQuiet();releaseInputs();recording=[];recordStart=performance.now();$('#record-button').textContent='■ Finish recording';$('#record-button').classList.add('is-recording');renderPhrase();
    recordingTimer=setTimeout(()=>{stopRecording();notify('Three-minute recording complete.');},180000);
  });
});
function playEvents(events,bpm,options={}) {
  allQuiet();const secondsPerBeat=60/bpm;const start=engine.context.currentTime+.12;
  const end=Math.max(...events.map(event=>(event.onset+event.duration)*secondsPerBeat));
  playback={start,end:start+end,events:[...events].sort((a,b)=>a.onset-b.onset),bpm,cursor:0,token:generation,type:options.type??'phrase'};
  schedulePlayback();
  $('#replay-button').textContent='■ Stop replay';
}
function schedulePlayback() {
  if(!playback || !engine.context)return;
  const secondsPerBeat=60/playback.bpm;
  while(playback.cursor<playback.events.length){
    const index=playback.cursor;const event=playback.events[index];const time=playback.start+event.onset*secondsPerBeat;
    if(time>engine.context.currentTime+.75)break;
    const key=keyById.get(event.keyId);
    if(key)engine.scheduleNote(`playback-${playback.token}-${index}`,key.midi,time,Math.max(.05,event.duration*secondsPerBeat),.68);
    playback.cursor++;
  }
}
$('#replay-button').addEventListener('click',async()=>{if(playback){allQuiet();return;}if(recording.length)await runAudioAction(()=>{engine.pause();playEvents(recording,60);});});
$('#export-button').addEventListener('click',()=>{
  const data={format:'relacality-phrase',version:1,createdAt:new Date().toISOString(),units:'seconds',events:recording.map(event=>({...event,name:keyById.get(event.keyId)?.name})),clocks,world:$('#world-notes').value};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`relacality-phrase-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
const storedPhrase=readStored('relacality.phrase.v1',[]);
recording=Array.isArray(storedPhrase)?storedPhrase.filter(event=>event && keyById.has(event.keyId)&&Number.isFinite(event.onset)&&event.onset>=0&&event.onset<=180&&Number.isFinite(event.duration)&&event.duration>=0&&event.duration<=180).slice(0,5000):[];
$('#world-notes').value=String(readStored('relacality.world.v1','')).slice(0,20000);
$('#world-notes').addEventListener('input',()=>store('relacality.world.v1',$('#world-notes').value));

function scoreHTML(world,label,showTimes=true) {
  const max=Math.max(world.lengthBeats||0,...world.events.map(event=>event.onset+event.duration),1);
  return `<div class="world-score"><h3>${safeText(label)}</h3><div class="world-events">${world.events.map(event=>{const key=keyById.get(event.keyId);return `<div class="world-event" data-form="${key.form}"><kbd>${safeText(key.key)}</kbd><span><strong>${safeText(event.entity)} · ${safeText(key.name)}</strong><small>${showTimes?`Starts ${number(event.onset)} · holds ${number(event.duration)} beat${event.duration===1?'':'s'}`:''}${event.durationRequired?' · hold required':''}</small></span><span class="event-visual" aria-hidden="true"><i style="left:${event.onset/max*85}%;width:${Math.max(4,event.duration/max*85)}%"></i></span></div>`;}).join('')}</div></div>`;
}
function number(value) { return Number(value.toFixed(2)).toString(); }
function levelSelect() {const labels=mode==='match'?['Bindings & perspectives','Longer intervals','Timing changes']:['Order & delay','Overlap','Nested time'];return `<label for="game-level">Challenge<select id="game-level">${labels.map((label,index)=>`<option value="${index+1}" ${level===index+1?'selected':''}>${index+1} · ${label}</option>`).join('')}</select></label>`;}
function renderPractice() {
  const panel=$('#practice-panel');panel.hidden=mode==='free';if(mode==='free')return;
  if(mode==='reason') {
    if(!challenge)challenge=generateChallenge(level);
    panel.innerHTML=`<div class="practice-header"><div><p class="eyebrow">REASON & PLAY</p><h2>${safeText(challenge.title)}</h2></div><div class="practice-settings">${levelSelect()}<label for="practice-bpm">Pace · Clock 1<input id="practice-bpm" type="number" min="1" max="240" value="${clocks[0].bpm}"></label><button id="next-challenge" class="button secondary" type="button">New world ↗</button></div></div><div class="practice-body"><ol class="premise-list">${challenge.premises.map(premise=>`<li>${safeText(premise)}</li>`).join('')}</ol><p class="game-question"><strong>${safeText(challenge.question)}</strong></p><div class="answer-options">${challenge.options.map(option=>`<button type="button" class="answer-button" data-answer="${safeText(option.id)}" ${questionAnswered?'disabled':''}>${safeText(option.label)}</button>`).join('')}</div><p id="reason-feedback" class="game-feedback" role="status">${questionAnswered?safeText(challenge.explanation):'Read the clues, then choose your answer.'}</p><div id="revealed-score" ${questionAnswered?'':'hidden'}>${scoreHTML(challenge,'Play this world')}<div class="performance-controls"><button id="perform-world" class="button primary" type="button">▶ Perform the score</button><button id="listen-world" class="button secondary" type="button">Hear the score</button><span class="small-note">Four-beat count-in · ${clocks[0].bpm} BPM · follows Clock 1’s tempo, even when silent</span></div><div id="performance-status" class="stage-message" role="status">Ready when you are.</div><div id="performance-results" class="score-stats"></div><p class="transfer-prompt">${safeText(challenge.domainPrompt)}</p><p class="small-note">${safeText(challenge.transferPrompts?.[0]??'')}</p></div></div>`;
    $('#world-prompt').textContent=challenge.domainPrompt;
  } else {
    if(!comparison)comparison=generateComparison(level);
    panel.innerHTML=`<div class="practice-header"><div><p class="eyebrow">WORLD MATCH</p><h2>Does the whole structure match?</h2></div><div class="practice-settings">${levelSelect()}<button id="next-challenge" class="button secondary" type="button">New pair ↗</button></div></div><p>One consistent entity map must preserve every category, perspective and relative timing. Whole-world tempo changes are allowed.</p><div class="comparison-grid">${scoreHTML(comparison.reference,'World A')}${scoreHTML(comparison.candidate,'World B')}</div><div class="performance-controls"><button class="button secondary" data-listen="reference" type="button">▶ Hear A · ${comparison.reference.tempo??90} BPM</button><button class="button secondary" data-listen="candidate" type="button">▶ Hear B · ${comparison.candidate.tempo??90} BPM</button></div><div class="answer-options"><button class="answer-button" type="button" data-match="true" ${comparisonAnswered?'disabled':''}>Match</button><button class="answer-button" type="button" data-match="false" ${comparisonAnswered?'disabled':''}>No match</button></div><p id="match-feedback" class="game-feedback" role="status">${comparisonAnswered?safeText(comparison.explanation):'Compare the attachments and relationships, then decide.'}</p><p class="small-note"><span id="decision-tally">${answered.correct} correct / ${answered.total} decisions this visit.</span> Sound is a cue; the labelled score carries entity identities.</p>`;
    $('#world-prompt').textContent='Give each world a different concrete setting. Can you preserve who does what, when, and for how long using one consistent mapping?';
  }
}
function newChallenge() {allQuiet();stopRecording();questionAnswered=false;comparisonAnswered=false;challenge=generateChallenge(level);comparison=generateComparison(level);renderPractice();}
$$('[data-mode]').forEach(button=>button.addEventListener('click',()=>{
  if(mode===button.dataset.mode)return;allQuiet();stopRecording();mode=button.dataset.mode;
  $$('[data-mode]').forEach(item=>{const selected=item===button;item.classList.toggle('is-active',selected);item.setAttribute('aria-pressed',String(selected));});
  renderPractice();
}));
$('#practice-panel').addEventListener('change',event=>{
  if(event.target.id==='game-level'){level=Number(event.target.value);newChallenge();}
  if(event.target.id==='practice-bpm')changeClock(0,'bpm',Number(event.target.value));
});
$('#practice-panel').addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.id==='next-challenge'){newChallenge();return;}
  if(button.dataset.answer && !questionAnswered) {
    questionAnswered=true;const correct=button.dataset.answer===challenge.answerId;answered.total++;if(correct)answered.correct++;
    $$('#practice-panel [data-answer]').forEach(option=>{option.disabled=true;option.classList.toggle('correct',option.dataset.answer===challenge.answerId);if(option===button&&!correct)option.classList.add('incorrect');});
    $('#reason-feedback').textContent=`${correct?'Correct.':'Let’s trace it.'} ${challenge.explanation}`;$('#revealed-score').hidden=false;return;
  }
  if(button.dataset.match && !comparisonAnswered) {
    comparisonAnswered=true;const correct=(button.dataset.match==='true')===comparison.isMatch;answered.total++;if(correct)answered.correct++;
    $$('#practice-panel [data-match]').forEach(option=>{option.disabled=true;option.classList.toggle('correct',(option.dataset.match==='true')===comparison.isMatch);if(option===button&&!correct)option.classList.add('incorrect');});
    $('#match-feedback').textContent=`${correct?'Correct.':'Look at the relationship.'} ${comparison.explanation}`;$('#decision-tally').textContent=`${answered.correct} correct / ${answered.total} decisions this visit.`;return;
  }
  if(button.id==='perform-world'){if(practice){cancelPractice('Performance cancelled.');return;}await startPerformance();}
  if(button.id==='listen-world')await runAudioAction(()=>{stopRecording();engine.pause();playEvents(challenge.events,clocks[0].bpm);notify('Listen to the category sequence, then try the score.');});
  if(button.dataset.listen)await runAudioAction(()=>{stopRecording();engine.pause();const world=comparison[button.dataset.listen];playEvents(world.events,world.tempo??90);});
});
async function startPerformance() {
  await runAudioAction(async()=>{
  allQuiet();stopRecording();engine.stop();const token=generation;await engine.start();
  if(token!==generation){engine.stop();return;}
  const beatSeconds=60/clocks[0].bpm;
  practice={type:'perform',beatSeconds,startElapsed:4*beatSeconds,events:[],lastLabel:'',challengeId:challenge.id};
  $('#perform-world').textContent='■ Cancel performance';$('#performance-results').innerHTML='';$('#practice-panel').classList.add('is-performing');
  $('#listen-world').disabled=true;$('#next-challenge').disabled=true;$('#game-level').disabled=true;$('#practice-bpm').disabled=true;
  });
}
function cancelPractice(message) {
  if(!practice)return;
  releaseInputs();practice=null;engine.stop();$('#practice-panel').classList.remove('is-performing');
  if($('#perform-world'))$('#perform-world').textContent='▶ Perform the score';
  for(const id of ['listen-world','next-challenge','game-level','practice-bpm'])if($('#'+id))$('#'+id).disabled=false;
  if($('#performance-status'))$('#performance-status').textContent=message;
}
function finishPerformance() {
  if(!practice)return;releaseInputs();const result=evaluatePerformance(challenge,practice.events,{toleranceBeats:.25});
  cancelPractice(result.feedback);
  $('#performance-results').innerHTML=`<div><strong>${Math.round(result.identityAccuracy)}%</strong><span>Correct notes</span></div><div><strong>${Math.round(result.timingAccuracy)}%</strong><span>On time · ±¼ beat</span></div><div><strong>${result.meanAbsErrorBeats===null?'—':number(result.meanAbsErrorBeats)}</strong><span>Mean error · beats</span></div>${result.durationAccuracy!==null&&result.durationAccuracy!==undefined?`<div><strong>${Math.round(result.durationAccuracy)}%</strong><span>Required holds</span></div>`:''}`;
}
let lastSecond=-1;
function frame() {
  const elapsed=engine.elapsed||0;
  $('#transport-toggle').innerHTML=engine.running?'<span aria-hidden="true">Ⅱ</span> Pause clocks':'<span aria-hidden="true">▶</span> '+(elapsed>0?'Resume clocks':'Start clocks');
  $('#transport-stop').disabled=!engine.running && elapsed===0;
  if(Math.floor(elapsed)!==lastSecond){$('#transport-time').textContent=formatTime(elapsed);lastSecond=Math.floor(elapsed);}
  $('#transport-status').textContent=engine.running?($('#cue-mode').value==='silent'?'Running · visual cues':'Running'):elapsed>0?'Paused':'Ready';
  $$('.clock-card').forEach((card,index)=>{
    const phase=engine.getClockPhase(index);const active=engine.running && clocks[index].enabled;
    card.classList.toggle('is-ticking',active && performance.now()-(lastBeat.get(index)??-1000)<110);
    card.querySelector('.clock-progress span').style.transform=`scaleX(${active && phase.beatIndex>=0?phase.fraction:0})`;
    let text=clocks[index].enabled?(engine.running?`Beat ${phase.beatIndex+1} / ${clocks[index].beats}`:elapsed?'Paused':'Ready'):'Off';
    if(active && phase.beatIndex<0)text='Waiting';
    card.querySelector('.clock-state').textContent=text;
  });
  if(practice) {
    const beats=(elapsed-practice.startElapsed)/practice.beatSeconds;
    const label=beats<0?`Count in · ${Math.max(1,Math.ceil(-beats))}${practice.beatSeconds>2?' · '+Math.ceil(-beats*practice.beatSeconds)+'s to start':''}`:`Play · beat ${Math.floor(beats)}`;
    if(label!==practice.lastLabel){$('#performance-status').textContent=label;practice.lastLabel=label;}
    if(beats>challenge.lengthBeats+.4)finishPerformance();
  }
  if(playback && engine.context) {
    schedulePlayback();
    const t=(engine.context.currentTime-playback.start)/(60/playback.bpm);
    const sounding=new Set(playback.events.filter(event=>t>=event.onset&&t<event.onset+event.duration).map(event=>event.keyId));
    KEYS.forEach(key=>paintHeld(key.id,sounding.has(key.id)||[...held.values()].some(entry=>entry.key.id===key.id)));
    if(engine.context.currentTime>playback.end+.15){playback=null;$('#replay-button').textContent='▶ Replay';}
  }
  requestAnimationFrame(frame);
}
function leavePage() {allQuiet();stopRecording();engine.pause();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)leavePage();});
window.addEventListener('blur',leavePage);
window.addEventListener('pagehide',()=>{leavePage();engine.stop();});
renderKeys();renderClocks();syncAudio();renderPhrase();renderPractice();
if(!storageAvailable)$('#storage-status').textContent='Browser storage is unavailable. You can still play and export a phrase.';
requestAnimationFrame(frame);
