/**
 * Relacality audio transport. Notes are locally synthesized: no recordings,
 * network request, speech engine or third-party audio service is involved.
 * Scheduling is based on AudioContext time, never accumulated timer intervals.
 */
export const CLOCK_VOICES = Object.freeze(['wood', 'bell', 'click', 'rim', 'glass', 'pulse']);
const DEFAULT_BEATS = [4, 3, 5, 7, 2, 6];
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const whole = (value, fallback, min, max) => clamp(Math.round(finite(value, fallback)), min, max);
const MAX_NOTE_SECONDS = 3600;

// A piano-like attack loses its bright partials, while a quiet fundamental
// remains audible for duration-based tasks, including very slow beat cycles.
function pianoLevel(level, age) {
  if (age <= 0) return 0;
  if (age < 0.006) return level * age / 0.006;
  if (age <= 0.3) return level * 0.46 ** ((age - 0.006) / 0.294);
  if (age <= 2.8) return level * 0.46 * (0.2 / 0.46) ** ((age - 0.3) / 2.5);
  if (age <= 8) return level * 0.2 * (0.12 / 0.2) ** ((age - 2.8) / 5.2);
  return level * 0.12;
}

function currentNoteLevel(note, time) {
  if (note.releaseAt !== undefined && time >= note.releaseAt) {
    return note.releaseLevel * Math.max(0, 1 - (time - note.releaseAt) / note.releaseDuration);
  }
  const age = time - note.start;
  if (age <= note.duration) return pianoLevel(note.level, age);
  return pianoLevel(note.level, note.duration) * Math.max(0, 1 - (age - note.duration) / 0.12);
}

export function beatDuration(bpm) {
  return 60 / whole(bpm, 80, 1, 240);
}

/** Absolute time of an event; the index is the zero-based beat number. */
export function nextBeatTime(epoch, bpm, index, phase = 0) {
  return finite(epoch, 0) + (Math.max(0, finite(index, 0)) + finite(phase, 0)) * beatDuration(bpm);
}

export function normalizeClock(input = {}, index = 0) {
  input = input && typeof input === 'object' ? input : {};
  const beats = whole(input.beats, DEFAULT_BEATS[index % 6] || 4, 1, 16);
  const rawVoice = typeof input.voice === 'number' ? CLOCK_VOICES[whole(input.voice, 0, 0, 5)] : input.voice;
  return {
    id: String(input.id ?? `clock-${index + 1}`),
    name: String(input.name ?? `Metronome ${index + 1}`).slice(0, 48),
    enabled: input.enabled === undefined ? index === 0 : Boolean(input.enabled),
    bpm: whole(input.bpm, 80, 1, 240),
    beats,
    voice: CLOCK_VOICES.includes(rawVoice) ? rawVoice : CLOCK_VOICES[index % 6],
    volume: clamp(finite(input.volume, 0.5), 0, 1),
    phase: clamp(finite(input.phase, 0), 0, 16),
    pattern: Array.from({ length: beats }, (_, beat) => {
      const supplied = Array.isArray(input.pattern) ? input.pattern[beat] : undefined;
      return supplied === undefined ? (beat === 0 ? 2 : 1) : whole(supplied, 1, 0, 2);
    }),
  };
}

export function createDefaultClocks() {
  return Array.from({ length: 6 }, (_, index) => normalizeClock({}, index));
}

export class AudioEngine {
  constructor({ onBeat = () => {}, onTransport = () => {} } = {}) {
    this.onBeat = onBeat;
    this.onTransport = onTransport;
    this.clocks = createDefaultClocks();
    this._context = null;
    this._running = false;
    this._offset = 0;
    this._epoch = 0;
    this._masterVolume = 0.65;
    this._pianoEnabled = true;
    this._cueMode = 'continuous';
    this._notes = new Map();
    this._voices = new Set();
    this._clicks = new Set();
    this._events = [];
    this._nextIndices = [];
    this._interval = null;
    this._generation = 0;
    this._pendingStart = false;
    this._lookahead = 0.12;
  }

  get context() { return this._context; }
  get running() { return this._running; }
  get elapsed() {
    return this._running && this._context
      ? Math.max(this._offset, this._context.currentTime - this._epoch)
      : this._offset;
  }

  async unlock() {
    if (!this._context) {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error('This browser does not support Web Audio. Please use a current browser.');
      this._context = new Context({ latencyHint: 'interactive' });
      this._master = this._context.createGain();
      this._master.gain.value = this._masterVolume;
      // A compressor limits dense chords and six simultaneous click accents.
      this._compressor = this._context.createDynamicsCompressor();
      this._compressor.threshold.value = -12;
      this._compressor.knee.value = 12;
      this._compressor.ratio.value = 5;
      this._compressor.attack.value = 0.003;
      this._compressor.release.value = 0.15;
      this._master.connect(this._compressor);
      this._compressor.connect(this._context.destination);
      this._stateChange = () => {
        if (this._running && ['suspended', 'interrupted', 'closed'].includes(this._context.state)) {
          this.pause('audio-suspended');
        }
      };
      this._context.addEventListener?.('statechange', this._stateChange);
    }
    if (this._context.state === 'suspended' || this._context.state === 'interrupted') {
      await this._context.resume();
    }
    return this._context;
  }

  setMasterVolume(value) {
    this._masterVolume = clamp(finite(value, 0.65), 0, 1);
    if (this._master) this._master.gain.setTargetAtTime(this._masterVolume, this._context.currentTime, 0.015);
  }

  setPianoEnabled(enabled) {
    this._pianoEnabled = Boolean(enabled);
    if (!enabled) this.releaseAll();
  }

  setCueMode(mode) {
    this._cueMode = ['continuous', 'fade', 'silent'].includes(mode) ? mode : 'continuous';
    this._cancelClicks();
    if (this._running) {
      this._alignNextIndices(this._context.currentTime + 0.006);
      this._tick();
    }
  }

  setClocks(clocks) {
    const incoming = Array.isArray(clocks) ? clocks.slice(0, 6) : [];
    this.clocks = incoming.map((clock, index) => normalizeClock(clock, index));
    this._cancelClicks();
    if (this._running) {
      this._alignNextIndices(this._context.currentTime + 0.006);
      this._tick();
    }
  }

  /** Safe to call repeatedly; a pending browser permission cannot restart a stopped transport. */
  async start() {
    if (this._running || this._pendingStart) return this._running;
    const token = ++this._generation;
    this._pendingStart = true;
    try {
      await this.unlock();
      if (token !== this._generation) return false;
      this._epoch = this._context.currentTime + 0.035 - this._offset;
      this._running = true;
      this._alignNextIndices(this._context.currentTime, true);
      this._interval = setInterval(() => this._tick(), 20);
      this._tick();
      this.onTransport({ running: true, elapsed: this.elapsed, reason: 'start' });
      return true;
    } finally {
      if (token === this._generation) this._pendingStart = false;
    }
  }

  pause(reason = 'pause') {
    ++this._generation;
    this._pendingStart = false;
    this._offset = this.elapsed;
    this._running = false;
    this._clearInterval();
    this._cancelClicks();
    this.releaseAll(true);
    this.onTransport({ running: false, elapsed: this._offset, reason });
  }

  stop() {
    ++this._generation;
    this._pendingStart = false;
    this._running = false;
    this._offset = 0;
    this._clearInterval();
    this._cancelClicks();
    this.releaseAll(true);
    this._nextIndices = [];
    this.onTransport({ running: false, elapsed: 0, reason: 'stop' });
  }

  _clearInterval() {
    if (this._interval !== null) clearInterval(this._interval);
    this._interval = null;
  }

  getClockPhase(index) {
    const clock = this.clocks[index];
    if (!clock) return { beatIndex: -1, fraction: 0 };
    const position = this.elapsed / beatDuration(clock.bpm) - clock.phase;
    if (position < 0) return { beatIndex: -1, fraction: 0 };
    return { beatIndex: Math.floor(position) % clock.beats, fraction: position - Math.floor(position) };
  }

  _alignNextIndices(now, resuming = false) {
    this._nextIndices = this.clocks.map(clock => Math.max(0,
      Math.ceil((now - this._epoch) / beatDuration(clock.bpm) - clock.phase - 1e-8),
      resuming && this._offset > 0
        ? Math.floor(this._offset / beatDuration(clock.bpm) - clock.phase + 1e-8) + 1
        : 0));
  }

  _tick() {
    if (!this._running || this._context.state !== 'running') return;
    const now = this._context.currentTime;
    const horizon = now + this._lookahead;
    // Flush only events that have reached their audio time. Old events after a
    // background stall are discarded, so the visualizer never catches up in a burst.
    const future = [];
    for (const event of this._events) {
      if (event.time > now) future.push(event);
      else if (now - event.time < 0.15) this.onBeat(event);
    }
    this._events = future;
    this.clocks.forEach((clock, clockIndex) => {
      if (!clock.enabled) return;
      const duration = beatDuration(clock.bpm);
      // Skip missed beats mathematically; never loop over hours of background time.
      const earliest = Math.max(0, Math.ceil((now - this._epoch) / duration - clock.phase - 1e-8));
      let index = Math.max(this._nextIndices[clockIndex] || 0, earliest);
      let time = nextBeatTime(this._epoch, clock.bpm, index, clock.phase);
      while (time <= horizon) {
        const beatIndex = index % clock.beats;
        const accent = clock.pattern[beatIndex];
        const audible = this._cueMode === 'continuous' || (this._cueMode === 'fade' && Math.floor(index / (clock.beats * 4)) % 2 === 0);
        if (audible && accent && clock.volume > 0) this._click(clock, time, accent);
        this._events.push({ clockIndex, beatIndex, time, accent, audible: audible && accent > 0 && clock.volume > 0 });
        index += 1;
        time = nextBeatTime(this._epoch, clock.bpm, index, clock.phase);
      }
      this._nextIndices[clockIndex] = index;
    });
  }

  _click(clock, time, accent) {
    const ctx = this._context;
    const gain = ctx.createGain();
    const source = ctx.createOscillator();
    const settings = {
      wood: [720, 260, 0.055, 'sine'],
      bell: [1400, 1300, 0.13, 'sine'],
      click: [2300, 1000, 0.028, 'triangle'],
      rim: [470, 330, 0.045, 'triangle'],
      glass: [2050, 1900, 0.12, 'sine'],
      pulse: [160, 120, 0.075, 'sine'],
    }[clock.voice];
    const pitch = accent === 2 ? 1.35 : 1;
    source.type = settings[3];
    source.frequency.setValueAtTime(settings[0] * pitch, time);
    source.frequency.exponentialRampToValueAtTime(settings[1] * pitch, time + settings[2]);
    const peak = clock.volume * (accent === 2 ? 0.34 : 0.22);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + settings[2]);
    gain.gain.linearRampToValueAtTime(0, time + settings[2] + 0.005);
    source.connect(gain);
    gain.connect(this._master);
    const click = { source, gain };
    this._clicks.add(click);
    source.onended = () => {
      this._clicks.delete(click);
      source.disconnect();
      gain.disconnect();
    };
    source.start(time);
    source.stop(time + settings[2] + 0.01);
  }

  _cancelClicks() {
    this._events = [];
    for (const click of this._clicks) {
      try { click.source.stop(); } catch { /* Already ended. */ }
      click.gain.disconnect();
    }
    this._clicks.clear();
  }

  noteOn(id, midi, velocity = 0.75) {
    return this._playNote(id, midi, this._context?.currentTime + 0.002, MAX_NOTE_SECONDS, velocity);
  }

  scheduleNote(id, midi, startAudioTime, durationSeconds, velocity = 0.75) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
    return this._playNote(id, midi, startAudioTime, durationSeconds, velocity);
  }

  _playNote(id, midi, startAudioTime, durationSeconds, velocity) {
    if (!this._context || this._context.state !== 'running' || !this._pianoEnabled) return false;
    if (finite(velocity, 0.75) <= 0) return false;
    if (this._notes.has(id)) this.noteOff(id);
    const ctx = this._context;
    const time = Math.max(ctx.currentTime + 0.002, finite(startAudioTime, ctx.currentTime + 0.002));
    const duration = clamp(finite(durationSeconds, MAX_NOTE_SECONDS), 0.025, MAX_NOTE_SECONDS);
    const end = time + duration + 0.13;
    // Future phrase notes do not consume simultaneous polyphony. Both the
    // pending queue and overlapping voices are bounded, including key repeats.
    const overlapping = [...this._voices].filter(note => note.start <= time && note.end > time);
    const evict = overlapping.length >= 32 ? overlapping[0]
      : this._voices.size >= 256 ? this._voices.values().next().value : null;
    if (evict) {
      this._releaseNote(evict, true);
      evict.envelope.disconnect();
      this._voices.delete(evict);
    }
    const frequency = 440 * 2 ** ((clamp(finite(midi, 60), 21, 108) - 69) / 12);
    const level = clamp(finite(velocity, 0.75), 0, 1) * 0.26;
    const envelope = ctx.createGain();
    envelope.gain.value = 0;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(level, time + 0.006);
    for (const point of [0.3, 2.8, 8]) {
      if (point < duration) envelope.gain.exponentialRampToValueAtTime(pianoLevel(level, point), time + point);
    }
    envelope.gain.exponentialRampToValueAtTime(pianoLevel(level, duration), time + duration);
    envelope.gain.linearRampToValueAtTime(0, time + duration + 0.12);
    envelope.connect(this._master);
    const sources = [];
    const partials = [];
    [[1, 1, 'triangle'], [2, 0.28, 'sine'], [3.002, 0.13, 'sine'], [4.006, 0.035, 'sine']].forEach(([ratio, weight, type]) => {
      const source = ctx.createOscillator();
      const partial = ctx.createGain();
      source.type = type;
      source.frequency.value = frequency * ratio;
      partial.gain.setValueAtTime(weight, time);
      if (ratio > 1) partial.gain.exponentialRampToValueAtTime(0.005, time + 1.2 / Math.sqrt(ratio));
      source.connect(partial);
      partial.connect(envelope);
      source.start(time);
      source.stop(end);
      sources.push(source);
      partials.push(partial);
    });
    const note = { id, sources, partials, envelope, start: time, end, duration, level, released: false };
    this._notes.set(id, note);
    this._voices.add(note);
    sources[0].onended = () => {
      this._voices.delete(note);
      if (this._notes.get(id) === note) this._notes.delete(id);
      sources.forEach(source => source.disconnect());
      partials.forEach(partial => partial.disconnect());
      envelope.disconnect();
    };
    return true;
  }

  _releaseNote(note, immediate = false) {
    if (!note || (note.released && !immediate)) return;
    const time = this._context.currentTime;
    const current = currentNoteLevel(note, time);
    note.released = true;
    note.releaseAt = time;
    note.releaseLevel = current;
    note.releaseDuration = immediate ? 0.008 : 0.12;
    note.end = time + (immediate ? 0.012 : 0.13);
    const param = note.envelope.gain;
    if (time <= note.start) {
      // A cancelled future note must remain zero even if its oscillator would
      // start during the release tail. Do not hold the GainNode default value.
      param.cancelScheduledValues(time);
      param.setValueAtTime(0, time);
      note.end = time;
      note.envelope.disconnect();
      this._voices.delete(note);
    } else if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
    else {
      param.cancelScheduledValues(time);
      param.setValueAtTime(current, time);
    }
    param.linearRampToValueAtTime(0, time + (immediate ? 0.008 : 0.12));
    note.sources.forEach(source => {
      try { source.stop(note.end); } catch { /* Already ended. */ }
    });
    if (this._notes.get(note.id) === note) this._notes.delete(note.id);
  }

  noteOff(id) { this._releaseNote(this._notes.get(id)); }
  releaseAll(immediate = false) { for (const note of [...this._voices]) this._releaseNote(note, immediate); }

  dispose() {
    this.stop();
    this._context?.removeEventListener?.('statechange', this._stateChange);
    this._master?.disconnect();
    this._compressor?.disconnect();
    this._context?.close();
  }
}
