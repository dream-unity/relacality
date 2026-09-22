import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine, CLOCK_VOICES, beatDuration, nextBeatTime, normalizeClock, createDefaultClocks } from '../audio-engine.js';

class FakeParam {
  constructor(value = 0) { this.value = value; this.calls = []; }
  setValueAtTime(...args) { this.calls.push(['set', ...args]); this.value = args[0]; return this; }
  linearRampToValueAtTime(...args) { this.calls.push(['linear', ...args]); return this; }
  exponentialRampToValueAtTime(...args) { this.calls.push(['exponential', ...args]); return this; }
  setTargetAtTime(...args) { this.calls.push(['target', ...args]); this.value = args[0]; return this; }
  cancelScheduledValues(...args) { this.calls.push(['cancel', ...args]); return this; }
  cancelAndHoldAtTime(...args) { this.calls.push(['hold', ...args]); return this; }
}
class FakeNode {
  connect(target) { (this.connections ??= []).push(target); return this; }
  disconnect() { this.disconnected = true; }
}
class FakeContext {
  constructor() { this.currentTime = 10; this.state = 'running'; this.destination = new FakeNode(); this.sources = []; }
  createGain() { return Object.assign(new FakeNode(), { gain: new FakeParam(1) }); }
  createDynamicsCompressor() {
    this.compressorCreated = true;
    return Object.assign(new FakeNode(), Object.fromEntries(['threshold','knee','ratio','attack','release'].map(key => [key, new FakeParam()])));
  }
  createWaveShaper() { return Object.assign(new FakeNode(), { curve: null, oversample: 'none' }); }
  createOscillator() {
    const node = Object.assign(new FakeNode(), {
      frequency: new FakeParam(440), start(time) { this.startTime = time; }, stop(time = 0) { this.stopTime = time; },
    });
    this.sources.push(node);
    return node;
  }
  async resume() { this.state = 'running'; }
  close() { this.state = 'closed'; }
  addEventListener(name, fn) { this.listener = fn; }
  removeEventListener() { this.listener = null; }
  advance(time) {
    this.currentTime = time;
    for (const source of this.sources) {
      if (source.stopTime <= time && !source.ended) { source.ended = true; source.onended?.(); }
    }
  }
}

async function withEngine(options, run) {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext;
  const engine = new AudioEngine(options);
  try { await run(engine); }
  finally { engine.dispose(); globalThis.AudioContext = original; }
}

test('all six clocks are independent; odd, even and single-beat cycles normalize', () => {
  const defaults = createDefaultClocks();
  assert.equal(defaults.length, 6);
  assert.equal(new Set(defaults.map(c => c.voice)).size, 6);
  assert.deepEqual(defaults.map(c => c.beats), [4, 3, 5, 7, 2, 6]);
  assert.equal(defaults.filter(c => c.enabled).length, 1);
  defaults[0].pattern[0] = 0;
  assert.equal(defaults[1].pattern[0], 2);
  for (let beats = 1; beats <= 16; beats++) {
    const clock = normalizeClock({ beats });
    assert.equal(clock.pattern.length, beats);
    assert.equal(clock.pattern[0], 2);
  }
});

test('BPM limits and absolute event timing do not accumulate drift', () => {
  assert.equal(beatDuration(1), 60);
  assert.equal(beatDuration(240), 0.25);
  assert.equal(beatDuration(0), 60);
  assert.equal(beatDuration(900), 0.25);
  for (const bpm of [1, 7, 61, 127, 239, 240]) {
    const last = nextBeatTime(100, bpm, 1_000_000, 0.5);
    assert.ok(Math.abs(last - (100 + 1_000_000.5 * 60 / bpm)) < 1e-7);
  }
  assert.equal(nextBeatTime(20, 60, 4, 2), 26);
});

test('configuration preserves intentional silence and sanitizes corrupt values', () => {
  const normalized = normalizeClock({ bpm: Infinity, beats: 500, volume: 0, voice: 'bad', phase: -12, pattern: [0, 1, 2, 9, -1, 'bad'] }, 2);
  assert.equal(normalized.bpm, 80);
  assert.equal(normalized.beats, 16);
  assert.equal(normalized.volume, 0);
  assert.equal(normalized.phase, 0);
  assert.equal(normalized.voice, CLOCK_VOICES[2]);
  assert.deepEqual(normalized.pattern.slice(0, 7), [0, 1, 2, 2, 0, 1, 1]);
  assert.equal(normalizeClock({ beats: 0, bpm: -100, volume: 4, phase: 900 }).beats, 1);
  assert.equal(normalizeClock({ volume: -4 }).volume, 0);
  assert.equal(normalizeClock({ phase: 900 }).phase, 16);
});

test('callbacks wait until audio time and scheduling never bursts after a long stall', async () => {
  const events = [];
  await withEngine({ onBeat: event => events.push(event) }, async engine => {
    engine.setClocks([{ enabled: true, bpm: 240, beats: 3 }]);
    await engine.start();
    assert.equal(events.length, 0);
    assert.equal(engine.context.sources.length, 1);
    const firstTime = engine.context.sources[0].startTime;
    engine.context.advance(firstTime + 0.01);
    engine._tick();
    assert.equal(events.length, 1);
    assert.equal(events[0].beatIndex, 0);
    assert.ok(events[0].time <= engine.context.currentTime);
    const count = engine.context.sources.length;
    engine.context.advance(firstTime + 3600.001);
    engine._tick();
    assert.equal(events.length, 1, 'old visual events are dropped');
    assert.ok(engine.context.sources.length - count <= 1, 'one horizon of audio; no catch-up burst');
    assert.ok(engine.context.sources.slice(count).every(source => source.startTime >= engine.context.currentTime));
  });
});

test('pause cancels queued audio, resume preserves progress, stop returns to zero', async () => {
  await withEngine({}, async engine => {
    engine.setClocks([{ enabled: true, bpm: 60, beats: 4 }]);
    await engine.start();
    const epoch = engine._epoch;
    engine.context.advance(epoch + 2.4);
    engine._tick();
    const before = engine.getClockPhase(0);
    engine.pause();
    assert.equal(engine.running, false);
    assert.equal(engine._events.length, 0);
    assert.equal(engine._clicks.size, 0);
    assert.equal(engine._interval, null);
    assert.ok(Math.abs(engine.elapsed - 2.4) < 1e-8);
    engine.context.advance(epoch + 20);
    assert.deepEqual(engine.getClockPhase(0), before);
    await engine.start();
    assert.ok(Math.abs(engine.elapsed - 2.4) < 1e-8, 'resume preroll never moves the timeline backwards');
    engine.context.advance(engine._epoch + 3.01);
    assert.equal(engine.getClockPhase(0).beatIndex, 3);
    engine.stop();
    assert.equal(engine.elapsed, 0);
    assert.equal(engine.running, false);
    await engine.start();
    assert.equal(engine._events[0].beatIndex, 0);
  });
});

test('pause at an exact beat boundary does not replay the already-heard beat on resume', async () => {
  await withEngine({}, async engine => {
    engine.setClocks([{ enabled: true, bpm: 60, beats: 4 }]);
    await engine.start();
    engine.context.advance(engine._epoch + 1);
    engine.pause();
    await engine.start();
    assert.equal(engine._nextIndices[0], 2);
    assert.equal(engine._events.length, 0);
  });
});

test('phase delays, muted beats and zero volume retain a visible cycle without sounding', async () => {
  const events = [];
  await withEngine({ onBeat: event => events.push(event) }, async engine => {
    engine.setClocks([{ enabled: true, bpm: 240, beats: 3, phase: 2, pattern: [0, 1, 2], volume: 0 }]);
    await engine.start();
    assert.deepEqual(engine.getClockPhase(0), { beatIndex: -1, fraction: 0 });
    engine.context.advance(engine._epoch + 0.49);
    engine._tick();
    engine.context.advance(engine._epoch + 0.51);
    engine._tick();
    assert.equal(events.length, 1);
    assert.equal(events[0].accent, 0);
    assert.equal(engine.context.sources.length, 0);
    assert.equal(engine.getClockPhase(0).beatIndex, 0);
  });
});

test('six simultaneous clocks schedule all voices once and live editing cancels stale audio', async () => {
  await withEngine({}, async engine => {
    engine.setClocks(createDefaultClocks().map(clock => ({ ...clock, enabled: true })));
    await engine.start();
    assert.equal(engine.context.sources.length, 6);
    assert.equal(engine._events.length, 6);
    const oldSources = [...engine.context.sources];
    engine.setClocks([{ enabled: true, bpm: 1, beats: 1 }]);
    assert.ok(oldSources.every(source => source.stopTime === 0));
    assert.equal(engine._events.length, 1);
    assert.equal(engine.clocks.length, 1);
    engine.setClocks(Array(20).fill({ enabled: false }));
    assert.equal(engine.clocks.length, 6);
  });
});

test('piano is independently mutable, zero volume is real, repeats are bounded and stop releases notes', async () => {
  await withEngine({}, async engine => {
    assert.equal(engine.noteOn('a', 60), false, 'no accidental creation outside a user gesture');
    await engine.unlock();
    engine.setMasterVolume(0);
    assert.equal(engine._master.gain.value, 0);
    assert.equal(engine.noteOn('silent', 60, 0), false);
    for (let n = 0; n < 100; n++) engine.noteOn('same-key', 60);
    assert.ok(engine._voices.size <= 32);
    assert.equal(engine._notes.size, 1);
    const active = engine._notes.get('same-key');
    engine.noteOff('same-key');
    assert.equal(engine._notes.size, 0);
    assert.ok(active.sources.every(source => source.stopTime <= engine.context.currentTime + 0.14));
    engine.noteOn('b', 61);
    engine.setPianoEnabled(false);
    assert.equal(engine._notes.size, 0);
    assert.equal(engine.noteOn('c', 62), false);
    engine.setPianoEnabled(true);
    engine.noteOn('d', 63);
    engine.stop();
    assert.equal(engine._notes.size, 0);
    engine.context.advance(engine.context.currentTime + 0.2);
    assert.equal(engine._voices.size, 0);
  });
});

test('a stop while unlock is pending prevents the delayed start', async () => {
  await withEngine({}, async engine => {
    let finish;
    engine.unlock = () => new Promise(resolve => { finish = resolve; });
    const started = engine.start();
    engine.stop();
    finish();
    assert.equal(await started, false);
    assert.equal(engine.running, false);
    assert.equal(engine._interval, null);
  });
});

test('OS audio suspension pauses transport and releases held keys', async () => {
  await withEngine({}, async engine => {
    await engine.start();
    engine.noteOn('held', 60);
    engine.context.state = 'suspended';
    engine.context.listener();
    assert.equal(engine.running, false);
    assert.equal(engine._notes.size, 0);
  });
});

test('fade alternates four audible and four silent bars independently; silent preserves callbacks', async () => {
  const events = [];
  await withEngine({ onBeat: event => events.push(event) }, async engine => {
    engine.setClocks([{ enabled: true, bpm: 60, beats: 3 }, { enabled: true, bpm: 60, beats: 4 }]);
    engine.setCueMode('fade');
    await engine.start();
    const epoch = engine._epoch;
    engine.context.advance(epoch + 11.95);
    engine._tick();
    engine.context.advance(epoch + 12.01);
    engine._tick();
    const matching = events.filter(event => Math.abs(event.time - epoch - 12) < 1e-7);
    assert.equal(matching.length, 2);
    assert.equal(matching.find(event => event.clockIndex === 0).audible, false);
    assert.equal(matching.find(event => event.clockIndex === 1).audible, true);
    engine.setCueMode('silent');
    engine.context.advance(epoch + 12.95);
    engine._tick();
    engine.context.advance(epoch + 13.01);
    engine._tick();
    assert.ok(events.slice(-2).every(event => !event.audible));
  });
});

test('future notes use precise audio times; cancelling playback stops notes before their start', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    const start = engine.context.currentTime + 2;
    assert.equal(engine.scheduleNote('future', 60, start, 0.5), true);
    const note = engine._notes.get('future');
    assert.ok(note.sources.every(source => source.startTime === start));
    assert.ok(note.sources.every(source => Math.abs(source.stopTime - start - 0.63) < 1e-8));
    engine.releaseAll(true);
    assert.ok(note.sources.every(source => source.stopTime < source.startTime));
    assert.equal(engine._notes.size, 0);
    assert.equal(engine.scheduleNote('invalid', 60, start, -1), false);
  });
});

test('held piano notes remain sustained beyond five seconds and end promptly on key release', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    engine.noteOn('held', 60);
    const note = engine._notes.get('held');
    assert.equal(note.duration, 3600);
    engine.context.advance(note.start + 10);
    assert.ok(note.sources.every(source => !source.ended && source.stopTime > engine.context.currentTime));
    const sustain = note.envelope.gain.calls.find(call => call[0] === 'exponential' && call[2] === note.start + 8);
    assert.ok(sustain[1] > 0.01, 'the sustained tone remains audible');
    engine.noteOff('held');
    assert.ok(note.sources.every(source => Math.abs(source.stopTime - engine.context.currentTime - 0.13) < 1e-8));
    engine.context.advance(engine.context.currentTime + 0.14);
    assert.ok(note.sources.every(source => source.ended));
  });
});

test('scheduled notes honor six-minute durations at 1 BPM and release exactly at their duration', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    for (const duration of [5.01, 12, 360, 3600]) {
      const start = engine.context.currentTime + 1;
      assert.equal(engine.scheduleNote(`long-${duration}`, 60, start, duration), true);
      const note = engine._notes.get(`long-${duration}`);
      assert.equal(note.duration, duration);
      assert.ok(note.sources.every(source => Math.abs(source.stopTime - start - duration - 0.13) < 1e-8));
      const releaseStart = note.envelope.gain.calls.find(call => call[0] === 'exponential' && call[2] === start + duration);
      const releaseEnd = note.envelope.gain.calls.find(call => call[0] === 'linear' && call[2] === start + duration + 0.12);
      assert.ok(releaseStart[1] > 0);
      assert.equal(releaseEnd[1], 0);
    }
  });
});

test('a future note cancelled immediately before its start cannot produce a release pop', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    const now = engine.context.currentTime;
    engine.scheduleNote('near-future', 60, now + 0.004, 360);
    const note = engine._notes.get('near-future');
    engine.noteOff('near-future');
    assert.ok(note.sources.every(source => source.stopTime === now && source.stopTime < source.startTime));
    const lastSet = note.envelope.gain.calls.filter(call => call[0] === 'set').at(-1);
    assert.deepEqual(lastSet, ['set', 0, now]);
    assert.equal(note.releaseLevel, 0);
  });
});

test('live keys start at the current render time with the same short attack as metronome clicks', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    const now = engine.context.currentTime;
    engine.noteOn('live', 60);
    const note = engine._notes.get('live');
    assert.equal(note.start, now, 'no added scheduling pad for a live key');
    assert.ok(note.sources.every(source => source.startTime === now));
    const attack = note.envelope.gain.calls.find(call => call[0] === 'linear');
    assert.deepEqual(attack, ['linear', note.level, now + 0.0015]);
    engine.context.advance(now + 0.00075);
    engine.noteOff('live');
    assert.ok(Math.abs(note.releaseLevel - note.level / 2) < 1e-9, 'early release follows the shortened envelope');
  });
});

test('the shared piano and click output uses a bounded memoryless limiter without compressor look-ahead', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    assert.equal(engine.context.compressorCreated, undefined);
    assert.equal(engine._limiter.oversample, 'none');
    assert.deepEqual(engine._master.connections, [engine._headroom]);
    assert.deepEqual(engine._headroom.connections, [engine._limiter]);
    assert.deepEqual(engine._limiter.connections, [engine.context.destination]);
    assert.equal(engine._headroom.gain.value, 1 / 8);
    const curve = engine._limiter.curve;
    assert.ok(curve instanceof Float32Array);
    assert.equal(curve[2048], 0, 'silence remains silence');
    for (let i = 0; i < curve.length; i++) {
      const signal = (i / 2048 - 1) * 8;
      assert.ok(Number.isFinite(curve[i]) && Math.abs(curve[i]) < 0.971, 'all possible output values remain below full scale');
      if (i) assert.ok(curve[i] >= curve[i - 1], 'the knee is monotonic');
      if (Math.abs(signal) <= 0.75) assert.ok(Math.abs(curve[i] - signal) < 1e-7, 'ordinary signal levels retain their gain');
    }
    engine.noteOn('live', 60);
    assert.deepEqual(engine._notes.get('live').envelope.connections, [engine._master]);
    engine._click(engine.clocks[0], engine.context.currentTime, 1);
    assert.ok([...engine._clicks].every(click => click.gain.connections[0] === engine._master));
  });
});

test('presentation time extrapolates valid output timestamps and rejects invalid reports safely', async () => {
  const originalPerformance = globalThis.performance;
  globalThis.performance = { now: () => 2000 };
  try {
    await withEngine({}, async engine => {
      await engine.unlock();
      const ctx = engine.context;
      ctx.baseLatency = 0.01;
      ctx.outputLatency = 0.04;
      ctx.getOutputTimestamp = () => ({ contextTime: 9.88, performanceTime: 1980 });
      assert.ok(Math.abs(engine.presentationTime - 9.9) < 1e-9);
      assert.ok(Math.abs(engine.outputDelay - 0.05) < 1e-9, 'the displayed delay comes from latency APIs, not the render/output timestamp difference');
      delete ctx.outputLatency;
      assert.ok(Math.abs(engine.presentationTime - 9.9) < 1e-9, 'timestamp alignment remains available without a latency API');
      assert.equal(engine.outputDelay, null, 'baseLatency alone does not estimate the complete output stage');
      ctx.outputLatency = 0.04;
      for (const stamp of [
        { contextTime: 0, performanceTime: 0 },
        { contextTime: NaN, performanceTime: 1980 },
        { contextTime: 9.9, performanceTime: Infinity },
        { contextTime: -1, performanceTime: 1980 },
        { contextTime: 9.9, performanceTime: 2001 },
        { contextTime: 8, performanceTime: 999 },
        { contextTime: 11, performanceTime: 1980 },
        { contextTime: 9.5, performanceTime: 1000 },
      ]) {
        ctx.getOutputTimestamp = () => stamp;
        assert.ok(Math.abs(engine.presentationTime - 9.95) < 1e-9, JSON.stringify(stamp));
        assert.ok(Math.abs(engine.outputDelay - 0.05) < 1e-9);
      }
      ctx.getOutputTimestamp = () => { throw new Error('unavailable'); };
      assert.equal(engine.presentationTime, 9.95);
      ctx.currentTime = 0.02;
      assert.equal(engine.presentationTime, 0, 'startup presentation time never becomes negative');
      assert.equal(engine.outputDelay, 0.05, 'the device estimate is independent of the age of the context');
    });
  } finally { globalThis.performance = originalPerformance; }
});

test('unavailable delay measurements remain unknown and invalid latency values cannot corrupt the timeline', async () => {
  await withEngine({}, async engine => {
    assert.equal(engine.outputDelay, null);
    assert.equal(engine.presentationTime, 0);
    await engine.unlock();
    assert.equal(engine.outputDelay, null);
    assert.equal(engine.presentationTime, engine.context.currentTime);
    for (const value of [-1, NaN, Infinity, '0.1', 999]) {
      engine.context.baseLatency = value;
      engine.context.outputLatency = value;
      assert.equal(engine.outputDelay, null);
      assert.equal(engine.presentationTime, engine.context.currentTime);
    }
    engine.context.baseLatency = 0;
    assert.equal(engine.outputDelay, null, 'base latency alone is not a complete output estimate');
    engine.context.outputLatency = 0;
    assert.equal(engine.outputDelay, 0, 'a genuine reported zero is different from an unavailable estimate');
    engine.context.outputLatency = 0.08;
    assert.equal(engine.presentationTime, 9.92);
  });
});

test('beat callbacks and clock phases follow estimated audible time while scheduling stays ahead on render time', async () => {
  const events = [];
  await withEngine({ onBeat: event => events.push(event) }, async engine => {
    await engine.unlock();
    engine.context.baseLatency = 0.01;
    engine.context.outputLatency = 0.09;
    engine.setClocks([{ enabled: true, bpm: 240, beats: 4 }]);
    await engine.start();
    const epoch = engine._epoch;
    engine.context.advance(epoch + 0.01);
    engine._tick();
    assert.equal(events.length, 0, 'a rendered beat is not highlighted before it is estimated to reach output');
    engine.context.advance(epoch + 0.11);
    engine._tick();
    assert.equal(events.length, 1);
    assert.equal(events[0].beatIndex, 0);
    engine.context.advance(epoch + 0.4);
    engine._tick();
    engine.context.advance(epoch + 0.51);
    engine._tick();
    assert.ok(Math.abs(engine.elapsed - 0.51) < 1e-9);
    assert.ok(Math.abs(engine.presentationElapsed - 0.41) < 1e-9);
    assert.equal(engine.getClockPhase(0).beatIndex, 1);
    assert.ok(engine.context.sources.some(source => Math.abs(source.startTime - epoch - 0.5) < 1e-9), 'render scheduler still queues upcoming output in advance');
  });
});

test('one chord starts all 27 keys on the same audio timestamp after graph preparation', async () => {
  await withEngine({}, async engine => {
    const chord = Array.from({ length: 27 }, (_, index) => ({ id: `key-${index}`, midi: 48 + index }));
    assert.equal(engine.noteOnBatch(chord), 0, 'batch input also requires an unlocked audio context');
    await engine.unlock();
    const ctx = engine.context;
    const createOscillator = ctx.createOscillator.bind(ctx);
    ctx.createOscillator = () => {
      ctx.currentTime += 0.0005; // Simulate substantial graph setup across render quanta.
      return createOscillator();
    };
    assert.equal(engine.noteOnBatch(chord), 27);
    assert.equal(engine._notes.size, 27);
    assert.equal(engine._voices.size, 27);
    const onset = ctx.currentTime;
    for (const note of engine._notes.values()) {
      assert.equal(note.start, onset, 'every note uses the render time after all graph setup');
      assert.ok(note.sources.every(source => source.startTime === onset));
      assert.deepEqual(note.envelope.gain.calls[0], ['set', 0, onset]);
      assert.equal(note.live, true);
    }
    assert.equal(new Set(ctx.sources.map(source => source.startTime)).size, 1);
  });
});

test('all 27 physical key inputs can remain held and release independently', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    for (let index = 0; index < 27; index++) assert.equal(engine.noteOn(`key-${index}`, 48 + index), true);
    const held = [...engine._notes.values()];
    engine.context.advance(engine.context.currentTime + 0.1);
    for (let index = 0; index < 9; index++) engine.noteOff(`key-${index}`);
    assert.equal(engine._notes.size, 18);
    assert.ok(held.slice(0, 9).every(note => note.released));
    assert.ok(held.slice(9).every(note => !note.released && !note.envelope.disconnected));
    engine.context.advance(engine.context.currentTime + 0.2);
    assert.equal(engine._voices.size, 18);
    assert.ok(held.slice(9).every(note => engine._notes.get(note.id) === note));
  });
});

test('rapid 27-note chord releases and restrikes never lose newly held voices', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    const chord = Array.from({ length: 27 }, (_, index) => ({ id: `key-${index}`, midi: 48 + index }));
    for (let strike = 0; strike < 20; strike++) {
      assert.equal(engine.noteOnBatch(chord), 27);
      assert.equal(engine._notes.size, 27);
      assert.ok(engine._voices.size <= 32, 'tails remain bounded even before they naturally end');
      assert.ok([...engine._notes.values()].every(note => !note.released && !note.envelope.disconnected));
      engine.context.advance(engine.context.currentTime + 0.01);
      for (const { id } of chord) engine.noteOff(id);
    }
    engine.context.advance(engine.context.currentTime + 0.2);
    assert.equal(engine._notes.size, 0);
    assert.equal(engine._voices.size, 0);
  });
});

test('retriggering a row evicts newer release tails before older still-held keys', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    const chord = Array.from({ length: 27 }, (_, index) => ({ id: `key-${index}`, midi: 48 + index }));
    engine.noteOnBatch(chord);
    const sustained = [...engine._notes.values()].slice(0, 18);
    for (let strike = 0; strike < 20; strike++) {
      engine.context.advance(engine.context.currentTime + 0.01);
      assert.equal(engine.noteOnBatch(chord.slice(18)), 9);
      assert.equal(engine._notes.size, 27);
      assert.ok(engine._voices.size <= 32);
      for (const note of sustained) {
        assert.equal(engine._notes.get(note.id), note, 'unchanged input keeps its original sustained voice');
        assert.equal(note.released, false);
        assert.notEqual(note.envelope.disconnected, true);
      }
    }
  });
});

test('scheduled playback cannot evict held live keys when its overlapping voice budget is full', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    for (let index = 0; index < 32; index++) engine.noteOn(`held-${index}`, 48 + index);
    const held = [...engine._notes.values()];
    assert.equal(engine.scheduleNote('extra-playback', 60, engine.context.currentTime + 0.02, 0.5), false);
    assert.equal(engine._notes.size, 32);
    assert.ok(held.every(note => engine._notes.get(note.id) === note && !note.released));
    engine.noteOff('held-31');
    engine.context.advance(engine.context.currentTime + 0.2);
    assert.equal(engine.scheduleNote('extra-playback', 60, engine.context.currentTime + 0.02, 0.5), true);
    assert.ok(held.slice(0, 31).every(note => engine._notes.get(note.id) === note && !note.released));
  });
});

test('batch input deduplicates IDs, ignores silent entries, and respects piano muting', async () => {
  await withEngine({}, async engine => {
    await engine.unlock();
    assert.equal(engine.noteOnBatch(null), 0);
    assert.equal(engine.noteOnBatch([null, {}, { id: 'silent', midi: 60, velocity: 0 }, { id: 'a', midi: 60 }, { id: 'a', midi: 64 }]), 1);
    assert.equal(engine._notes.size, 1);
    assert.ok(Math.abs(engine._notes.get('a').sources[0].frequency.value - 440 * 2 ** ((64 - 69) / 12)) < 1e-8);
    engine.setPianoEnabled(false);
    assert.equal(engine.noteOnBatch([{ id: 'b', midi: 62 }]), 0);
    assert.equal(engine._notes.size, 0);
  });
});
