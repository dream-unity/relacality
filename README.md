# Relacality

A playable ontological piano and temporal relational reasoning game for Dream Unity. There are **27 permanently assigned keys**: nine archetypal forms, nine inner forms, and nine outer forms. Six independently configurable metronomes provide optional accompaniment.

## Play

Open the deployed site in a current browser. A key press or a transport button enables audio. No sign-in, microphone permission, external audio service, or account is needed.

For local development, run `npm start` (Node and Python 3 installed) and open `http://localhost:4173`. This is a static ES-module application; serve it over HTTP rather than opening `index.html` as a local file.

## The 27 keys

| Category | Archetypal | Inner | Outer |
| --- | --- | --- | --- |
| All | Q | A | Z |
| Difference | W | S | X |
| Action | E | D | C |
| Division | R | F | V |
| Connection | T | G | B |
| Multiplication / Unfoldment | Y | H | N |
| Projection | U | J | M |
| Encompassment | I | K | , |
| Completion | O | L | . |

These are physical keyboard positions. Every form also has its own touch pad, pitch, name and definition. Keyboard playing is suspended while typing into a form field. Hold a key to sustain it; release to end it. Escape releases notes and cancels a performance or replay.

Category, perspective, entity and timing remain distinct. These ontology meanings are a vocabulary for constructing imagined worlds; musical intervals do not automatically establish causal relationships.

## Three modes

- **Free play:** improvise with all 27 keys, with or without accompaniment. Record up to three minutes of key presses and held durations, replay the phrase, and export it as JSON. Recordings, world notes and settings remain in the current browser.
- **Reason & play:** infer a missing event time from explicit premises, then perform the revealed phrase. Levels cover order and delay, overlapping intervals, and nested intervals. A four-beat count-in precedes beat 0. Performance pace follows Clock 1's BPM, even when that clock is disabled. Enabled clocks accompany the performance. Results distinguish correct keys, onset timing and required holds.
- **World match:** compare complete temporal worlds with repeated entities and multiple aspects. One consistent entity renaming must preserve category, perspective, role attachments, relative onset times and durations. A uniform positive time scaling and a common start-time shift are ignored. Close nonmatches swap entity attachments, alter a perspective, or move only one event. The labelled score carries entity identities; audio alone does not encode them.

Da Vinci prompts invite constructing one coherent world, expressing its structure in a distant domain, and predicting what a changed relationship would alter. These open-ended constructions are not automatically graded. Scores measure the displayed practice task and are not intelligence scores.

## Six independent clocks

Each clock has:

- **1–240 BPM**, in whole beats per minute.
- **1–16 beats per bar**, including odd, even and single-beat metres.
- One of six sounds: Wood, Bell, Click, Rim, Glass or Pulse.
- An independent volume and start offset of 0–16 beats (quarter-beat steps in the UI).
- A per-beat pattern: normal, accent or silent. A silent beat keeps its time slot.
- A separate enable switch. All six may run together, or all may be switched off.

All clocks share the transport start but maintain independent tempi. The 3-against-2 preset uses 90 and 60 BPM with three- and two-beat bars, so their bar starts coincide. Other presets cover 5-against-4, nested tempi and six synchronized bar lengths.

The global cue setting supports continuous sound, visual-only timing, and four audible bars followed by four silent bars **independently for each clock**. Key sound has a separate switch. Pause preserves elapsed time and phase; Stop resets to zero. Hiding or leaving the page pauses the clocks and cancels an active practice attempt.

## Audio and measurement

Audio is locally synthesized using Web Audio. The piano has a short attack, decaying harmonics and a quiet sustain until release. A one-hour safety ceiling applies to a single held or scheduled note. Up to 32 simultaneous piano voices are supported; actual hardware key rollover may impose a lower limit on keyboard chords. Touch input has independent pointer handling.

Metronomes are scheduled against `AudioContext.currentTime` with lookahead. Event times are calculated from an epoch instead of accumulating timer intervals. Late background beats are skipped rather than emitted as a burst. Recording replay uses a rolling scheduling window. Pause, stop and cancellation release queued audio.

Timing feedback uses the device's input and audio clocks. It is useful practice feedback, not calibrated laboratory measurement; wireless output may introduce latency. The standard onset/hold tolerance is ±0.25 beats. Incorrect, missing and additional notes affect the scores. No audio is recorded from a microphone.

## Checks

`npm test` runs the pure engine and scheduling regressions with Node 22 or newer. `node tests/browser.mjs` runs the browser checks when Playwright and Chromium are installed. The browser test uses `CHROMIUM_EXECUTABLE_PATH` when provided and supports the Codex primary runtime's Playwright installation.

The test suite checks category/key uniqueness, generated deductions, full-world matching, score behaviour, all six clock voices, extreme tempi, odd/even patterns, cancellation, silent bars and sustained notes. Browser checks cover keyboard and touch input, transport, recording, game flows and responsive layout.

## Files

- `ontology.js` — meanings and the 27-key mapping.
- `audio-engine.js` — piano synthesis and six-clock transport.
- `game-engine.js` — problem generation, matching and separate performance measures.
- `app.js` — accessible keyboard/touch controls, game flow and local preferences.
- `index.html`, `styles.css` — the responsive instrument and guide.

There are no runtime package dependencies, analytics or remote data stores.
