import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, FORMS, KEYS } from '../ontology.js';
import { generateChallenge, evaluatePerformance, compareWorlds, generateComparison } from '../game-engine.js';

function rng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }

test('all 27 categories have a distinct permanent keyboard key and complete meaning', () => {
  assert.equal(CATEGORIES.length, 9); assert.equal(FORMS.length, 3); assert.equal(KEYS.length, 27);
  for (const field of ['id', 'code', 'key', 'midi']) assert.equal(new Set(KEYS.map(key => key[field])).size, 27);
  for (const form of FORMS) assert.equal(KEYS.filter(key => key.form === form.id).length, 9);
  assert.deepEqual(KEYS.map(key => key.key).join(''), 'QWERTYUIOASDFGHJKLZXCVBNM,.');
  assert.ok(KEYS.every(key => key.description.length > 10));
  assert.match(KEYS.find(key => key.id === 'inner-completion').description, /sufficiency/);
});

test('generated deductions and timelines agree through all three levels', () => {
  const random = rng(813);
  const seen = new Set();
  for (let level = 1; level <= 3; level++) for (let trial = 0; trial < 300; trial++) {
    const challenge = generateChallenge(level, random);
    assert.equal(challenge.level, level);
    assert.equal(challenge.events.length, level + 2);
    assert.equal(challenge.options.length, 4);
    assert.equal(new Set(challenge.options.map(option => option.id)).size, 4);
    assert.equal(challenge.options.filter(option => option.id === challenge.answerId).length, 1);
    const derivedEvent = challenge.events[level === 3 ? 3 : 2];
    assert.equal(challenge.answerId, `beat-${derivedEvent.onset}`);
    assert.ok(challenge.events.every(event => event.onset >= 0 && event.onset + event.duration <= challenge.lengthBeats));
    assert.ok(challenge.lengthBeats <= 8);
    assert.equal(evaluatePerformance(challenge, challenge.events).accuracy, 100);
    challenge.events.forEach(event => seen.add(event.keyId));
    if (level === 2) {
      assert.equal(challenge.events[2].onset, challenge.events[1].onset + challenge.events[1].duration);
      assert.equal(challenge.events[3].onset, challenge.events[0].duration);
    }
    if (level === 3) {
      const [outer, inner, middle, successor, close] = challenge.events;
      assert.equal(inner.onset, outer.onset + 1);
      assert.equal(inner.onset + inner.duration, outer.onset + outer.duration - 1);
      assert.equal(middle.onset, inner.onset + inner.duration / 2);
      assert.equal(successor.onset, middle.onset + 1);
      assert.equal(close.onset, outer.onset + outer.duration);
    }
  }
  assert.equal(seen.size, 27);
});

test('performance separates identity, onset and explicitly required holds', () => {
  const challenge = { events: [{ keyId: 'a', onset: 0, duration: 3, durationRequired: true }, { keyId: 'b', onset: 2, duration: .4 }] };
  assert.equal(evaluatePerformance(challenge, []).accuracy, 0);
  const late = evaluatePerformance(challenge, challenge.events.map(event => ({ ...event, onset: event.onset + 1 })));
  assert.equal(late.identityAccuracy, 100); assert.equal(late.timingAccuracy, 0); assert.equal(late.durationAccuracy, 100);
  const short = evaluatePerformance(challenge, [{ keyId: 'a', onset: 0, duration: .1 }, challenge.events[1]]);
  assert.equal(short.identityAccuracy, 100); assert.equal(short.timingAccuracy, 100); assert.equal(short.durationAccuracy, 0);
  const extra = evaluatePerformance(challenge, [...challenge.events, { keyId: 'wrong', onset: 2 }]);
  assert.equal(extra.extra.length, 1); assert.ok(extra.accuracy < 100);
  const wrong = evaluatePerformance(challenge, [{ keyId: 'wrong', onset: 0 }, challenge.events[1]]);
  assert.equal(wrong.missed.length, 1); assert.equal(wrong.extra.length, 1);
});

test('alignment of repeated keys chooses nearest valid sequence instead of early extras', () => {
  const challenge = { events: [{ keyId: 'a', onset: 1 }, { keyId: 'a', onset: 3 }] };
  const events = [{ keyId: 'a', onset: -3 }, { keyId: 'a', onset: 1.05 }, { keyId: 'a', onset: 3.05 }];
  const result = evaluatePerformance(challenge, events);
  assert.equal(result.matches.length, 2); assert.equal(result.extra[0].onset, -3);
  assert.ok(Math.abs(result.meanAbsErrorBeats - .05) < 1e-10);
  assert.ok(result.matches.every(match => match.timingCorrect));
});

test('timing tolerance handles both sides and nonfinite input without a false perfect result', () => {
  const challenge = { events: [{ keyId: 'a', onset: 1 }] };
  assert.equal(evaluatePerformance(challenge, [{ keyId: 'a', onset: 1.24 }]).timingAccuracy, 100);
  assert.equal(evaluatePerformance(challenge, [{ keyId: 'a', onset: .75 }]).timingAccuracy, 0);
  assert.equal(evaluatePerformance(challenge, [{ keyId: 'a', onset: NaN }]).accuracy, 0);
  assert.equal(evaluatePerformance({ events: [] }, []).accuracy, 0);
});

test('complete world comparison allows consistent rename and time scaling', () => {
  const source = { events: [
    { entity: 'A', keyId: 'inner-action', onset: 0, duration: 1 },
    { entity: 'B', keyId: 'outer-projection', onset: 2, duration: 2 },
    { entity: 'A', keyId: 'inner-connection', onset: 4, duration: .5 },
  ] };
  const transformed = { events: source.events.map(event => ({ ...event, entity: event.entity === 'A' ? 'X' : 'Y', onset: event.onset * 1.7 + 3, duration: event.duration * 1.7 })).reverse() };
  assert.ok(compareWorlds(source, transformed));
  transformed.events[0].entity = 'Y';
  assert.equal(compareWorlds(source, transformed), false);
  assert.equal(compareWorlds(null, source), false);
});

test('relative duration, perspective and role are independently significant', () => {
  const source = { events: [{ keyId: 'inner-action', entity: 'A', onset: 0, duration: 1, role: 'source' }, { keyId: 'outer-action', entity: 'B', onset: 2, duration: 1 }] };
  for (const change of [event => event.duration = 2, event => event.keyId = 'outer-action', event => event.role = 'receiver']) {
    const candidate = structuredClone(source); change(candidate.events[0]);
    assert.equal(compareWorlds(source, candidate), false);
  }
});

test('generated comparison labels agree with independently introduced changes', () => {
  const random = rng(4901), counts = { match: 0, mismatch: 0 }, mutations = new Set();
  for (let level = 1; level <= 3; level++) for (let i = 0; i < 250; i++) {
    const trial = generateComparison(level, random);
    assert.equal(compareWorlds(trial.reference, trial.candidate), trial.isMatch);
    const expectedMatch = trial.changeLabel.startsWith('Renamed');
    assert.equal(trial.isMatch, expectedMatch, trial.changeLabel);
    counts[trial.isMatch ? 'match' : 'mismatch']++;
    mutations.add(trial.changeLabel);
  }
  assert.ok(counts.match > 250 && counts.mismatch > 250);
  assert.ok(mutations.has('Swapped entity attachments'));
  assert.ok(mutations.has('Changed perspective'));
  assert.ok(mutations.has('Changed relative interval'));
});
