import { KEYS, KEY_BY_ID } from './ontology.js';

const clampLevel = level => Math.max(1, Math.min(3, Math.floor(Number(level) || 1)));
const randomInt = (rng, low, high) => low + Math.floor(Math.max(0, Math.min(.999999999999, rng())) * (high - low + 1));
const shuffle = (items, rng) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(rng, 0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};
const round = value => Math.round(value * 1e6) / 1e6;
const beatLabel = beat => `${beat} ${beat === 1 ? 'beat' : 'beats'}`;
const describe = (entity, key) => `${entity} (${key.name})`;

/** A solved, auditable temporal problem plus the phrase the player performs. */
export function generateChallenge(level = 1, rng = Math.random) {
  level = clampLevel(level);
  const keys = shuffle(KEYS, rng).slice(0, level + 2);
  const key = index => keys[index];
  const label = index => describe('ABCDE'[index], key(index));
  const event = (index, onset, duration = .35, durationRequired = false) => ({
    keyId: key(index).id, entity: 'ABCDE'[index], onset, duration, durationRequired,
  });
  const variant = randomInt(rng, 0, 1);
  let title, premises, question, answer, explanation, events, lengthBeats, relationLabel;
  if (level === 1) {
    const firstGap = randomInt(rng, 1, 3), secondGap = randomInt(rng, 1, 2);
    answer = firstGap + secondGap;
    title = variant ? 'Read it backwards' : 'Follow the thread';
    premises = variant ? [
      `${label(0)} begins at beat 0.`,
      `${label(1)} begins ${beatLabel(secondGap)} before ${label(2)}.`,
      `${label(0)} begins ${beatLabel(firstGap)} before ${label(1)}.`,
    ] : [
      `${label(0)} begins at beat 0.`,
      `${label(1)} begins ${beatLabel(firstGap)} after A.`,
      `${label(2)} begins ${beatLabel(secondGap)} after B.`,
    ];
    question = `At which beat does ${label(2)} begin?`;
    explanation = `B begins at 0 + ${firstGap} = ${firstGap}. C begins at ${firstGap} + ${secondGap} = ${answer}. Reversing the wording does not reverse the order of events.`;
    events = [event(0, 0), event(1, firstGap), event(2, answer)];
    lengthBeats = answer + 2;
    relationLabel = 'Order and delay';
  } else if (level === 2) {
    const entry = randomInt(rng, 1, 2);
    const innerDuration = randomInt(rng, 2, 3);
    answer = entry + innerDuration;
    title = variant ? 'Pass the pulse' : 'Inside the sustained note';
    premises = [
      `${label(0)} starts at beat 0 and is held for 6 beats.`,
      `${label(1)} starts ${beatLabel(entry)} after A and is held for ${beatLabel(innerDuration)}.`,
      `${label(2)} starts exactly when B ends. Tap C.`,
      `${label(3)} starts exactly when A ends. Tap D.`,
    ];
    question = `At which beat does ${label(2)} begin?`;
    explanation = `B starts at beat ${entry} and lasts ${beatLabel(innerDuration)}, so it ends at ${entry} + ${innerDuration} = ${answer}. C begins there. A is still held until beat 6; D begins at beat 6.`;
    events = [event(0, 0, 6, true), event(1, entry, innerDuration, true), event(2, answer), event(3, 6)];
    lengthBeats = 8;
    relationLabel = 'Overlap and endpoints';
  } else {
    const outerDuration = variant ? 6 : 4;
    const midpoint = outerDuration / 2;
    answer = midpoint + 1;
    title = 'A world inside a world';
    premises = [
      `${label(0)} starts at beat 0 and is held for ${beatLabel(outerDuration)}. This marks the outer interval.`,
      `${label(1)} starts 1 beat after A and ends 1 beat before A ends. Hold B for that inner interval.`,
      `${label(2)} starts halfway through B's interval. Tap C.`,
      `${label(3)} starts 1 beat after C. Tap D.`,
      `${label(4)} starts when A ends. Tap E.`,
    ];
    question = `At which beat does ${label(3)} begin?`;
    explanation = `B runs from beat 1 to beat ${outerDuration - 1}. Its midpoint is (1 + ${outerDuration - 1}) ÷ 2 = ${midpoint}, when C begins. D begins at ${midpoint} + 1 = ${answer}. E begins at beat ${outerDuration}. The interval labels specify timing, not automatic causation.`;
    events = [event(0, 0, outerDuration, true), event(1, 1, outerDuration - 2, true), event(2, midpoint), event(3, answer), event(4, outerDuration)];
    lengthBeats = outerDuration + 2;
    relationLabel = 'Nested intervals';
  }
  const alternatives = shuffle(Array.from({ length: 8 }, (_, index) => index).filter(value => value !== answer), rng).slice(0, 3);
  const options = shuffle([answer, ...alternatives], rng).map(value => ({ id: `beat-${value}`, label: `Beat ${value}` }));
  return {
    id: `temporal-${level}-${events.map(e => `${e.keyId}:${e.onset}:${e.duration}`).join('|')}`,
    level, title, premises, question, options, answerId: `beat-${answer}`, explanation,
    events, lengthBeats, relationLabel,
    domainPrompt: 'Imagine one coherent world. Each letter is one entity; its category and Inner, Outer or Archetypal form stay attached to it. Give each category its stated meaning, then embody the required timing. Timing alone does not establish a causal link.',
    transferPrompts: [
      'Rebuild the same pattern in a distant domain. Keep every category, perspective, entity role and relative interval.',
      'Say which event occurs first, which intervals overlap, and what stays unchanged if the whole phrase becomes slower.',
      'Change one interval or category attachment. Predict what changes before you replay it. State an extra rule explicitly if you want to infer a causal consequence.',
    ],
  };
}

/* Pair repeated keys in order while maximising the number of correct keys,
 * then minimising timing error. A spurious early press cannot consume the
 * correct later press as it can with greedy matching. */
function alignKey(expected, actual) {
  const a = [...expected].sort((x, y) => x.event.onset - y.event.onset);
  const b = [...actual].sort((x, y) => x.event.onset - y.event.onset);
  const table = Array.from({ length: a.length + 1 }, () => Array(b.length + 1));
  table[0][0] = { count: 0, error: 0, pairs: [] };
  const best = options => options.filter(Boolean).sort((x, y) => y.count - x.count || x.error - y.error)[0];
  for (let i = 0; i <= a.length; i++) {
    for (let j = 0; j <= b.length; j++) {
      if (i === 0 && j === 0) continue;
      const candidates = [i ? table[i - 1][j] : null, j ? table[i][j - 1] : null];
      if (i && j) {
        const previous = table[i - 1][j - 1];
        candidates.push({ count: previous.count + 1, error: previous.error + Math.abs(a[i - 1].event.onset - b[j - 1].event.onset), pairs: [...previous.pairs, [a[i - 1], b[j - 1]]] });
      }
      table[i][j] = best(candidates);
    }
  }
  return table[a.length][b.length].pairs;
}

/** Scores are 0–100. Onsets/durations and errors are in beats, never seconds. */
export function evaluatePerformance(challenge, events, { toleranceBeats = .24 } = {}) {
  const expected = Array.isArray(challenge?.events) ? challenge.events : [];
  const actual = (Array.isArray(events) ? events : []).filter(e => e && typeof e.keyId === 'string' && Number.isFinite(e.onset));
  const tolerance = Number.isFinite(toleranceBeats) ? Math.max(.001, toleranceBeats) : .24;
  const matches = [];
  const matchedExpected = new Set(), matchedActual = new Set();
  const ids = new Set(expected.map(e => e.keyId));
  for (const id of ids) {
    const targets = expected.map((event, index) => ({ event, index })).filter(item => item.event.keyId === id);
    const presses = actual.map((event, index) => ({ event, index })).filter(item => item.event.keyId === id);
    for (const [target, press] of alignKey(targets, presses)) {
      matchedExpected.add(target.index); matchedActual.add(press.index);
      const errorBeats = press.event.onset - target.event.onset;
      const durationErrorBeats = Number.isFinite(press.event.duration) ? press.event.duration - target.event.duration : null;
      matches.push({ keyId: id, expected: target.event, actual: press.event, expectedIndex: target.index, actualIndex: press.index,
        errorBeats, timingCorrect: Math.abs(errorBeats) <= tolerance + 1e-9,
        durationErrorBeats, durationCorrect: !target.event.durationRequired || (durationErrorBeats !== null && Math.abs(durationErrorBeats) <= tolerance + 1e-9),
      });
    }
  }
  matches.sort((a, b) => a.expectedIndex - b.expectedIndex);
  const missed = expected.filter((_, index) => !matchedExpected.has(index));
  const extra = actual.filter((_, index) => !matchedActual.has(index));
  const denominator = expected.length + actual.length;
  const identityAccuracy = denominator ? 200 * matches.length / denominator : 0;
  const timingAccuracy = denominator ? 200 * matches.filter(m => m.timingCorrect).length / denominator : 0;
  const holdTargets = expected.filter(e => e.durationRequired);
  const durationAccuracy = holdTargets.length ? 100 * matches.filter(m => m.expected.durationRequired && m.durationCorrect).length / holdTargets.length : null;
  const components = [identityAccuracy, timingAccuracy, ...(durationAccuracy === null ? [] : [durationAccuracy])];
  const accuracy = components.reduce((sum, score) => sum + score, 0) / components.length;
  const meanAbsErrorBeats = matches.length ? matches.reduce((sum, match) => sum + Math.abs(match.errorBeats), 0) / matches.length : null;
  const issues = [];
  if (missed.length) issues.push(`${missed.length} missed ${missed.length === 1 ? 'note' : 'notes'}`);
  if (extra.length) issues.push(`${extra.length} extra ${extra.length === 1 ? 'note' : 'notes'}`);
  const offTime = matches.filter(m => !m.timingCorrect).length;
  if (offTime) issues.push(`${offTime} ${offTime === 1 ? 'onset' : 'onsets'} outside ±${tolerance} beats`);
  const offHold = holdTargets.length - matches.filter(m => m.expected.durationRequired && m.durationCorrect).length;
  if (offHold) issues.push(`${offHold} held ${offHold === 1 ? 'interval needs' : 'intervals need'} adjustment`);
  return { accuracy: round(accuracy), timingAccuracy: round(timingAccuracy), identityAccuracy: round(identityAccuracy),
    durationAccuracy: durationAccuracy === null ? null : round(durationAccuracy), meanAbsErrorBeats,
    matches, missed, extra, feedback: !expected.length ? 'Choose a phrase to practise first.' : issues.length ? `${issues.join('; ')}. Replay the phrase slowly and preserve the entity–category attachments.` : 'Every category arrived on time, with all required held intervals preserved.',
  };
}

/* A trace is the full set of category/form events belonging to one entity.
 * Comparing multisets of traces allows ONE consistent entity renaming, not
 * independent renaming at each event. Global shift and positive time scale
 * are immaterial; relative onsets, durations and explicit roles are retained. */
function canonicalWorld(world) {
  if (!world || !Array.isArray(world.events) || world.events.length > 128) return null;
  if (!world.events.length) return '[]';
  if (world.events.some(e => !e || !Number.isFinite(e.onset) || !Number.isFinite(e.duration ?? 0) || (e.duration ?? 0) < 0 || e.entity === undefined || typeof e.keyId !== 'string')) return null;
  const origin = Math.min(...world.events.map(e => e.onset));
  const end = Math.max(...world.events.map(e => e.onset + (e.duration ?? 0)));
  const scale = end - origin || 1;
  const entities = new Map();
  for (const event of world.events) {
    const key = KEY_BY_ID.get(event.keyId);
    const binding = { keyId: event.keyId, categoryId: event.categoryId ?? key?.categoryId ?? null,
      form: event.form ?? key?.form ?? null, role: event.role ?? null };
    const trace = entities.get(event.entity) || [];
    trace.push(JSON.stringify({ ...binding, onset: round((event.onset - origin) / scale), duration: round((event.duration ?? 0) / scale) }));
    entities.set(event.entity, trace);
  }
  return JSON.stringify([...entities.values()].map(trace => JSON.stringify(trace.sort())).sort());
}

export function compareWorlds(a, b) {
  const left = canonicalWorld(a), right = canonicalWorld(b);
  return left !== null && right !== null && left === right;
}

/** Close alternatives preserve much of the pattern but alter a real binding. */
export function generateComparison(level = 1, rng = Math.random) {
  level = clampLevel(level);
  const keys = shuffle(KEYS, rng).slice(0, 6);
  const duration = level === 1 ? .4 : 1;
  const reference = { events: keys.map((key, index) => ({ keyId: key.id, entity: 'ABC'[index % 3], onset: index, duration })), lengthBeats: 7, tempo: 90 };
  const multiplier = [1, 1.5, 2][randomInt(rng, 0, 2)];
  const renamed = { A: 'X', B: 'Y', C: 'Z' };
  const candidate = { events: reference.events.map(event => ({ ...event, entity: renamed[event.entity], onset: event.onset * multiplier, duration: event.duration * multiplier })), lengthBeats: reference.lengthBeats * multiplier, tempo: 90 };
  const shouldMatch = rng() < .5;
  let explanation, changeLabel;
  if (shouldMatch) {
    explanation = 'One consistent map, A → X, B → Y and C → Z, preserves every category, form, entity attachment and relative interval. A uniform change of time scale does not change this structure.';
    changeLabel = multiplier === 1 ? 'Renamed entities' : 'Renamed entities and uniform time scaling';
  } else {
    const change = randomInt(rng, 0, level === 1 ? 1 : 2);
    if (change === 0) {
      [candidate.events[3].entity, candidate.events[4].entity] = [candidate.events[4].entity, candidate.events[3].entity];
      explanation = 'Two later category events have exchanged their entity attachments. The notes and timing remain familiar, but no single consistent entity map preserves both appearances of every entity.';
      changeLabel = 'Swapped entity attachments';
    } else if (change === 1) {
      const original = KEY_BY_ID.get(candidate.events[4].keyId);
      const nextForm = { archetypal: 'inner', inner: 'outer', outer: 'archetypal' }[original.form];
      candidate.events[4].keyId = `${nextForm}-${original.categoryId}`;
      explanation = `One ${original.category} event has changed from ${original.form} to ${nextForm}. Timing and entity identity are preserved, but the complete ontological configuration differs.`;
      changeLabel = 'Changed perspective';
    } else {
      candidate.events[3].onset += .5 * multiplier;
      explanation = 'Only one onset moved. Because the other intervals stayed fixed, no uniform change of tempo can restore all relative intervals.';
      changeLabel = 'Changed relative interval';
    }
  }
  candidate.events = shuffle(candidate.events, rng);
  return { reference, candidate, isMatch: compareWorlds(reference, candidate), explanation, changeLabel };
}
