import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(resolve(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules', 'playwright'))); }
const artifactDir = process.env.BROWSER_ARTIFACT_DIR || resolve(root, '..');
await mkdir(artifactDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (path !== root && !path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const file = path === root ? resolve(root, 'index.html') : path;
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || '/tmp/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
let checks = 0;
const pass = label => { checks++; process.stdout.write(`ok ${checks} - ${label}\n`); };
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const keyCodes = ['KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM','Comma','Period'];
const keyCode = label => label === ',' ? 'Comma' : label === '.' ? 'Period' : 'Key' + label.toUpperCase();
const text = selector => page.locator(selector).innerText();
const fillNumber = async (label, value) => { await page.getByLabel(label, { exact: true }).fill(String(value)); await page.getByLabel(label, { exact: true }).press('Tab'); };
const waitText = (selector, wanted) => page.waitForFunction(({ selector, wanted }) => document.querySelector(selector)?.textContent.includes(wanted), { selector, wanted });

// Observe the real browser audio graph, without exposing internals in production.
await page.addInitScript(() => {
  window.__audioProbe = { starts: [], analyser: null };
  for (const Type of [window.OscillatorNode, window.AudioBufferSourceNode]) {
    const start = Type.prototype.start;
    Type.prototype.start = function (...args) {
      window.__audioProbe.starts.push({ kind: this.constructor.name, type: this.type, frequency: this.frequency?.value, at: args[0] ?? this.context.currentTime, lead: (args[0] ?? this.context.currentTime) - this.context.currentTime });
      return start.apply(this, args);
    };
  }
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...args) {
    const output = connect.call(this, target, ...args);
    if (target instanceof AudioDestinationNode && !window.__audioProbe.analyser) {
      const analyser = this.context.createAnalyser(); analyser.fftSize = 2048;
      connect.call(this, analyser); window.__audioProbe.analyser = analyser;
    }
    return output;
  };
});

try {
  await page.goto(url); await page.locator('.piano-key').last().waitFor();
  assert.equal(await page.locator('.piano-key').count(), 27);
  assert.equal(new Set(await page.locator('.piano-key').evaluateAll(nodes => nodes.map(node => node.dataset.keyId))).size, 27);
  pass('27 distinct dedicated category keys render');
  assert.deepEqual(await page.locator('.key-row').evaluateAll(rows => rows.map(row => row.querySelectorAll('.piano-key').length)), [9,9,9]);
  pass('Archetypal, Inner and Outer each have nine keys');
  for (let i = 0; i < keyCodes.length; i++) {
    await page.keyboard.down(keyCodes[i]);
    assert.equal(await page.locator('.piano-key.is-held').count(), 1, keyCodes[i]);
    assert.equal(await page.locator('.piano-key').nth(i).getAttribute('aria-pressed'), 'true', keyCodes[i]);
    await page.keyboard.up(keyCodes[i]);
    assert.equal(await page.locator('.piano-key.is-held').count(), 0, keyCodes[i]);
  }
  pass('All 27 physical key codes press and release their own pad');
  await page.keyboard.down('KeyQ'); await page.keyboard.down('KeyA'); await page.keyboard.down('KeyZ');
  assert.equal(await page.locator('.piano-key.is-held').count(), 3);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  for (const key of ['KeyQ','KeyA','KeyZ']) await page.keyboard.up(key);
  pass('Polyphonic chords and Escape release all notes');
  await page.keyboard.down('KeyW'); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.up('KeyW');
  assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  pass('Focus loss releases held keys');
  await page.getByLabel('Your world and its counterpart').fill('A station and an ecosystem preserve timing.');
  await page.keyboard.down('KeyQ'); assert.equal(await page.locator('.piano-key.is-held').count(), 0); await page.keyboard.up('KeyQ');
  pass('Typing world notes does not play the instrument');
  await page.locator('#piano-title').click();
  await page.keyboard.down('KeyA'); await wait(100);
  const peak = await page.evaluate(() => { const a = window.__audioProbe.analyser; if (!a) return 0; const data = new Float32Array(a.fftSize); a.getFloatTimeDomainData(data); return Math.max(...data.map(Math.abs)); });
  await page.keyboard.up('KeyA'); assert.ok(peak > .00001, `Piano peak ${peak}`);
  pass('Real Web Audio piano output contains a nonzero waveform');
  const immediate = await page.evaluate(() => {
    const before = window.__audioProbe.starts.length;
    document.dispatchEvent(new KeyboardEvent('keydown', {code:'KeyD', bubbles:true}));
    const starts = window.__audioProbe.starts.slice(before);
    document.dispatchEvent(new KeyboardEvent('keyup', {code:'KeyD', bubbles:true}));
    return starts;
  });
  assert.equal(immediate.length, 4, 'Live oscillators start before the input handler returns, without awaiting a Promise');
  assert.ok(immediate.every(start => start.lead <= .0001), 'Live notes have no added scheduling delay');
  pass('A warm key press starts audio synchronously with no artificial scheduling lead');
  await page.waitForFunction(() => /Estimated audio output delay:|Output delay unavailable/.test(document.querySelector('#audio-latency').textContent));
  pass('Audio output delay is reported as an estimate or explicitly unavailable');
  let chordStart = await page.evaluate(() => window.__audioProbe.starts.length);
  for (const code of keyCodes) await page.keyboard.down(code);
  assert.equal(await page.locator('.piano-key.is-held').count(), 27);
  assert.equal(await text('#held-count'), '27 / 27 held');
  assert.equal(await page.evaluate(before => window.__audioProbe.starts.length-before, chordStart), 108);
  for (const code of keyCodes) await page.keyboard.up(code);
  assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  pass('All 27 direct keyboard events can remain held together and release cleanly');
  for (const [code, expected] of [['Digit1',9],['Digit2',9],['Digit3',9],['Digit4',27],['Numpad1',9],['Numpad2',9],['Numpad3',9],['Numpad4',27]]) {
    chordStart = await page.evaluate(() => window.__audioProbe.starts.length);
    await page.keyboard.down(code);
    assert.equal(await page.locator('.piano-key.is-held').count(), expected, code);
    const starts = await page.evaluate(before => window.__audioProbe.starts.slice(before), chordStart);
    assert.equal(starts.length, expected*4, code);
    assert.equal(new Set(starts.map(start => start.at)).size, 1, `${code} shares one audio onset`);
    await page.keyboard.up(code);
    assert.equal(await page.locator('.piano-key.is-held').count(), 0, code);
  }
  pass('Number-row and numpad shortcuts play 9/9/9/27 notes with one exact audio onset');
  await page.keyboard.down('KeyQ');
  chordStart = await page.evaluate(() => window.__audioProbe.starts.length);
  await page.keyboard.down('Digit1');
  assert.equal(await page.evaluate(before => window.__audioProbe.starts.length-before, chordStart), 32);
  await page.keyboard.up('Digit1');
  assert.equal(await page.locator('.piano-key.is-held').count(), 1);
  assert.equal(await page.locator('.piano-key').first().getAttribute('aria-pressed'), 'true');
  await page.keyboard.up('KeyQ');
  await page.keyboard.down('Digit4');
  chordStart = await page.evaluate(() => window.__audioProbe.starts.length);
  await page.keyboard.down('Digit2'); await page.keyboard.down('KeyA');
  assert.equal(await page.evaluate(before => window.__audioProbe.starts.length-before, chordStart), 0);
  await page.keyboard.up('Digit4'); assert.equal(await page.locator('.piano-key.is-held').count(), 9);
  await page.keyboard.up('Digit2'); assert.equal(await page.locator('.piano-key.is-held').count(), 1);
  await page.keyboard.up('KeyA'); assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  pass('Overlapping whole chords, rows and individual keys neither duplicate voices nor release another hold');
  for (const [chord, expected] of [['archetypal',9],['inner',9],['outer',9],['all',27]]) {
    const button = page.locator(`[data-chord="${chord}"]`); await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox(); await page.mouse.move(box.x+box.width/2, box.y+box.height/2); await page.mouse.down();
    assert.equal(await page.locator('.piano-key.is-held').count(), expected);
    await page.mouse.move(4,4); await page.mouse.up();
    assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  }
  pass('All four on-screen chord buttons hold and release even when the pointer leaves the button');
  for (const code of ['Enter','Space']) {
    await page.locator('[data-chord="all"]').focus();
    chordStart = await page.evaluate(() => window.__audioProbe.starts.length);
    await page.keyboard.down(code); assert.equal(await page.locator('.piano-key.is-held').count(), 27);
    await wait(40); await page.keyboard.up(code); await wait(80);
    assert.equal(await page.locator('.piano-key.is-held').count(), 0);
    assert.equal(await page.evaluate(before => window.__audioProbe.starts.length-before, chordStart), 108, `${code} must not synthesize a second chord`);
  }
  await page.locator('[data-chord="all"]').evaluate(button => button.click());
  assert.equal(await page.locator('.piano-key.is-held').count(), 27);
  await page.waitForFunction(() => document.querySelectorAll('.piano-key.is-held').length===0);
  pass('Enter and Space hold once; screen-reader click activation plays a single short chord');
  await page.locator('#latch-keys').click();
  for (const code of keyCodes) await page.keyboard.press(code);
  assert.equal(await page.locator('.piano-key.is-held').count(), 27);
  assert.equal(await page.locator('.piano-key.is-latched').count(), 27);
  await page.keyboard.press('KeyQ'); assert.equal(await page.locator('.piano-key.is-held').count(), 26);
  await page.locator('#latch-keys').click(); assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  await page.keyboard.down('KeyQ'); await page.locator('#latch-keys').click(); await page.keyboard.press('KeyW');
  assert.equal(await page.locator('.piano-key.is-held').count(), 2);
  await page.locator('#latch-keys').click(); assert.equal(await page.locator('.piano-key.is-held').count(), 1);
  await page.keyboard.up('KeyQ'); assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  pass('Latch builds any 27-note chord one key at a time; disabling it preserves a physical hold');
  await page.locator('#latch-keys').click(); await page.keyboard.press('KeyW'); await page.keyboard.down('Digit4');
  await page.keyboard.press('Escape'); await page.keyboard.up('Digit4');
  assert.equal(await page.locator('.piano-key.is-held').count(), 0); assert.equal(await page.locator('.piano-key.is-latched').count(), 0);
  assert.equal(await text('#held-count'), '0 / 27 held');
  await page.keyboard.press('KeyW'); await page.keyboard.down('Digit3');
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.up('Digit3');
  assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  await page.locator('#latch-keys').click();
  pass('Escape and focus loss clear combined latch and chord holds without stuck keys');
  await page.locator('#world-notes').focus();
  for (const code of ['Digit1','Digit2','Digit3','Digit4']) await page.keyboard.press(code);
  assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  await page.getByLabel('Clock 1 BPM', {exact:true}).focus(); await page.keyboard.press('Digit4');
  assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  await page.getByLabel('Clock 1 BPM', {exact:true}).fill('80'); await page.getByLabel('Clock 1 BPM', {exact:true}).press('Tab');
  pass('Chord shortcuts remain inactive while typing text or numeric clock settings');
  await page.locator('#piano-title').click(); await page.keyboard.down('Digit4'); await wait(100);
  const fullChordPeak = await page.evaluate(() => { const a=window.__audioProbe.analyser; const data=new Float32Array(a.fftSize); a.getFloatTimeDomainData(data); return Math.max(...data.map(Math.abs)); });
  await page.keyboard.up('Digit4');
  assert.ok(fullChordPeak>.00001 && fullChordPeak<=1, `27-note output peak ${fullChordPeak}`);
  pass('A full 27-note chord produces bounded nonzero native audio');
  await page.locator('#record-button').click(); await waitText('#recording-status', 'Recording');
  await page.keyboard.down('Digit4'); await wait(120); await page.keyboard.up('Digit4');
  await page.locator('#record-button').click();
  const chordDownloadPromise=page.waitForEvent('download'); await page.locator('#export-button').click();
  const chordDownload=await chordDownloadPromise; const chordExport=JSON.parse(await readFile(await chordDownload.path(),'utf8'));
  assert.equal(chordExport.events.length,27); assert.equal(new Set(chordExport.events.map(event=>event.keyId)).size,27);
  assert.equal(new Set(chordExport.events.map(event=>event.onset)).size,1);
  assert.equal(new Set(chordExport.events.map(event=>event.duration)).size,1);
  assert.ok(chordExport.events[0].duration>=.1);
  pass('Export records all 27 chord notes once with identical onsets and hold durations');
  assert.equal(await page.locator('.clock-card').count(), 6); pass('Six independent metronome controls render');
  for (let i = 1; i <= 6; i++) {
    await fillNumber(`Clock ${i} BPM`, 1); assert.equal(await page.getByLabel(`Clock ${i} BPM`, { exact: true }).inputValue(), '1');
    await fillNumber(`Clock ${i} BPM`, 240); assert.equal(await page.getByLabel(`Clock ${i} BPM`, { exact: true }).inputValue(), '240');
    const beats = [1,3,4,5,7,16][i-1]; await fillNumber(`Clock ${i} beats per bar`, beats);
    assert.equal(await page.locator(`.clock-card[data-index="${i-1}"] .beat-dot`).count(), beats);
    await page.getByLabel(`Enable clock ${i}`, { exact: true }).check();
  }
  assert.equal(await text('#enabled-count'), '6 / 6 clocks');
  pass('Each clock accepts both 1 and 240 BPM; odd/even metres span 1–16 beats');
  const dot = page.locator('.clock-card[data-index="1"] [data-beat="1"]');
  assert.equal(await dot.getAttribute('data-value'), '1');
  for (const expected of ['2','0','1']) { await dot.click(); assert.equal(await dot.getAttribute('data-value'), expected); }
  pass('Beat editing cycles normal, accent and silent without losing beat slots');
  const scheduledBefore = await page.evaluate(() => window.__audioProbe.starts.length);
  await page.locator('#transport-toggle').click(); await waitText('#transport-status', 'Running'); await wait(350);
  assert.equal(await page.locator('.clock-state').evaluateAll(nodes => nodes.filter(node => /Beat/.test(node.textContent)).length), 6);
  await page.waitForFunction(before => window.__audioProbe.starts.length >= before + 6, scheduledBefore, { timeout: 2500 });
  pass('Six enabled metronomes advance and schedule real audio together');
  await page.locator('#transport-toggle').click(); await waitText('#transport-status', 'Paused');
  const paused = await text('#transport-time'); await wait(300); assert.equal(await text('#transport-time'), paused);
  await page.locator('#transport-toggle').click(); await waitText('#transport-status', 'Running');
  await page.locator('#transport-stop').click(); await waitText('#transport-status', 'Ready');
  assert.equal(await text('#transport-time'), '00:00'); assert.equal(await page.locator('#transport-stop').isDisabled(), true);
  pass('Pause, resume and stop retain or reset the clock as labelled');
  await page.locator('#cue-mode').selectOption('silent');
  const silentBefore = await page.evaluate(() => window.__audioProbe.starts.length);
  await page.locator('#transport-toggle').click(); await waitText('#transport-status', 'visual cues'); await wait(300);
  assert.equal(await page.evaluate(() => window.__audioProbe.starts.length), silentBefore);
  await page.locator('#transport-stop').click(); await page.locator('#cue-mode').selectOption('continuous');
  pass('Visual-only metronomes advance without audio nodes');
  for(let i=2;i<=6;i++) await page.getByLabel(`Enable clock ${i}`, {exact:true}).uncheck();
  for(const voice of ['wood','bell','click','rim','glass','pulse']) {
    await page.getByLabel('Clock 1 sound', {exact:true}).selectOption(voice);
    const before = await page.evaluate(() => window.__audioProbe.starts.length);
    await page.locator('#transport-toggle').click();
    await page.waitForFunction(count => window.__audioProbe.starts.length > count, before, {timeout:2500});
    await page.locator('#transport-stop').click();
  }
  pass('Each of the six metronome sounds independently schedules real audio');
  await page.locator('#master-volume').fill('0'); await page.getByLabel('Clock 1 volume', { exact: true }).fill('0');
  await page.reload();
  assert.equal(await page.locator('#master-volume').inputValue(), '0');
  assert.equal(await page.getByLabel('Clock 1 volume', { exact: true }).inputValue(), '0');
  assert.match(await page.locator('#world-notes').inputValue(), /station/);
  pass('Zero master/clock volume and written worlds survive reload');
  await page.locator('#master-volume').fill('65'); await page.getByLabel('Clock 1 volume', { exact: true }).fill('50');
  await page.locator('#rhythm-preset').selectOption('three-two');
  assert.equal(await page.getByLabel('Clock 1 BPM', { exact: true }).inputValue(), '90');
  assert.equal(await page.getByLabel('Clock 2 BPM', { exact: true }).inputValue(), '60');
  assert.equal(await page.getByLabel('Clock 1 beats per bar', { exact: true }).inputValue(), '3');
  assert.equal(await page.getByLabel('Clock 2 beats per bar', { exact: true }).inputValue(), '2');
  assert.equal(await text('#enabled-count'), '2 / 6 clocks');
  pass('Three-against-two preset uses 90:60 BPM and 3:2 grouping');
  await page.locator('#record-button').click(); await waitText('#recording-status', 'Recording');
  for (const key of ['KeyQ','KeyG','Period']) { await page.keyboard.down(key); await wait(80); await page.keyboard.up(key); await wait(40); }
  await page.locator('#record-button').click(); assert.equal(await text('#recording-status'), '3 notes');
  pass('Recording captures keyboard notes and holds');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-button').click(); const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.format, 'relacality-phrase'); assert.equal(exported.events.length, 3);
  assert.equal(exported.units, 'seconds'); assert.ok(exported.events.every(event => event.duration > .04)); assert.ok(exported.events[2].onset > exported.events[0].onset);
  pass('Exported JSON preserves phrase identities, sequence and hold lengths');
  await page.locator('#replay-button').click(); await waitText('#replay-button', 'Stop replay');
  await page.waitForFunction(() => document.querySelectorAll('.piano-key.is-held').length > 0);
  await waitText('#replay-button', '▶ Replay');
  assert.equal(await page.locator('.piano-key.is-held').count(), 0);
  pass('Recorded phrase replays with visible notes and completes cleanly');
  await page.reload(); assert.equal(await text('#recording-status'), '3 notes'); pass('Recorded phrase survives reload');
  await page.locator('[data-mode="reason"]').click();
  assert.equal(await page.locator('.premise-list li').count(), 3);
  const premises = await page.locator('.premise-list li').allTextContents();
  const answer = premises.slice(1).map(premise => Number(premise.match(/begins (\d+) beats? (?:before|after)/)?.[1])).reduce((a,b) => a+b, 0);
  assert.ok(Number.isFinite(answer)); await page.getByRole('button', { name: `Beat ${answer}`, exact: true }).click();
  assert.match(await text('#reason-feedback'), /^Correct\./); assert.equal(await page.locator('#revealed-score').isVisible(), true);
  assert.equal(await page.locator('[data-answer]:disabled').count(), 4);
  pass('Reasoning answer derived independently from displayed clues reveals the score once');
  await fillNumber('Pace · Clock 1', 240);
  await page.locator('#perform-world').click(); await waitText('#performance-status', 'Count in');
  await page.locator('#performance-results strong').first().waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#performance-results strong').nth(0).innerText(), '0%');
  assert.equal(await page.locator('#performance-results strong').nth(1).innerText(), '0%');
  pass('An empty timed attempt correctly scores zero notes and zero timing');
  const score = await page.locator('#revealed-score .world-event').evaluateAll(nodes => nodes.map(node => ({ key: node.querySelector('kbd').textContent.trim(), onset: Number(node.querySelector('small').textContent.match(/Starts ([\d.]+)/)[1]) })));
  await page.locator('#perform-world').click();
  await page.waitForFunction(() => document.querySelector('#performance-status')?.textContent === 'Play · beat 0');
  const playStart = performance.now();
  for (const event of score.sort((a,b) => a.onset-b.onset)) {
    await wait(Math.max(0, playStart + event.onset*250 - performance.now()));
    await page.keyboard.down(keyCode(event.key)); await wait(45); await page.keyboard.up(keyCode(event.key));
  }
  await page.locator('#performance-results strong').first().waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#performance-results strong').nth(0).innerText(), '100%');
  assert.ok(parseInt(await page.locator('#performance-results strong').nth(1).innerText(),10) >= 66);
  pass('Real keyboard performance of the visible score earns correct-note and timing credit');
  await page.locator('#perform-world').click(); await waitText('#performance-status', 'Count in'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#practice-panel').evaluate(node => node.classList.contains('is-performing')), false);
  assert.equal(await page.locator('#performance-results').innerText(), '');
  pass('Escape cancels performance without recording a misleading result');
  await page.locator('#perform-world').click(); await page.locator('[data-mode="free"]').click();
  assert.equal(await page.locator('#practice-panel').isVisible(), false); await waitText('#transport-status', 'Ready');
  pass('Switching mode cancels the running performance');
  await page.locator('[data-mode="match"]').click(); assert.equal(await page.locator('.comparison-grid .world-score').count(), 2);
  await page.locator('[data-match="true"]').click(); assert.equal(await page.locator('[data-match]:disabled').count(), 2);
  assert.match(await text('#match-feedback'), /Correct\.|Look at the relationship\./);
  await page.locator('#next-challenge').click();
  const tally = (await page.locator('#practice-panel > .small-note').innerText()).match(/(\d+) decisions/)[1];
  await page.locator('[data-match="false"]').click();
  await page.locator('[data-match="false"]').evaluate(button => button.click());
  await page.locator('#next-challenge').click();
  const nextTally = (await page.locator('#practice-panel > .small-note').innerText()).match(/(\d+) decisions/)[1];
  assert.equal(Number(nextTally),Number(tally)+1);
  pass('World matching disables repeat answers and counts one decision per pair');
  await page.locator('#game-level').selectOption('3'); assert.deepEqual(await page.locator('.world-score').evaluateAll(worlds => worlds.map(world => world.querySelectorAll('.world-event').length)), [6,6]);
  pass('Advanced World match retains all six bound events in both worlds');
  await page.locator('[data-mode="free"]').click(); await page.locator('#rhythm-preset').selectOption('six');
  await page.screenshot({ path: resolve(artifactDir,'relacality-desktop.png'), fullPage: true });
  for (const width of [1365,390,360]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(dimensions.body <= dimensions.viewport+1, `${width}px layout scrolls to ${dimensions.body}`);
    if(width!==1365) await page.screenshot({ path: resolve(artifactDir,`relacality-mobile-${width}.png`), fullPage:true });
  }
  pass('Desktop, 390px and 360px layouts have no horizontal page overflow');
  await page.setViewportSize({width:390,height:844}); await page.locator('.piano-key').first().click();
  assert.match(await text('#active-key-name'), /All/); pass('Mobile-sized pointer activation plays a labelled pad');
  assert.deepEqual(errors, []); pass('Complete browser flows emit no uncaught or console errors');
  process.stdout.write(`Verified ${checks} browser scenarios. Screenshots: ${artifactDir}\n`);
} finally {
  await browser.close(); await new Promise(done => server.close(done));
}
