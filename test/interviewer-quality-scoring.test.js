'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateQualityScore, publicScoringSummary, VERSION } = require('../src/services/interviewQualityScoring');
const quality = value => Object.fromEntries(['response_specificity', 'answer_directness', 'answer_consistency', 'communication_structure'].map(k => [k, value]));
const answered = score => ({ scorable: true, score });

test('headline uses the approved 80/20 formula, excluding process failures', () => {
  const result = calculateQualityScore([answered(80), answered(60), { scorable: false, score: null }], quality(80));
  assert.equal(result.role_answers, 70);
  assert.equal(result.answer_quality, 80);
  assert.equal(result.overall, 72);
  assert.equal(result.scorable_questions, 2);
  assert.equal(result.unscored_questions, 1);
});
test('no-response and unscored evidence never receive a baseline bump', () => {
  assert.equal(calculateQualityScore([], quality(90)), null);
  assert.equal(calculateQualityScore([{ scorable: false, score: null }], quality(90)), null);
  assert.equal(calculateQualityScore([answered(0)], quality(0)).overall, 0);
});
test('quality output requires four finite bounded scores', () => {
  for (const input of [{}, quality(null), quality('90'), quality(101), quality(NaN)]) {
    assert.throws(() => calculateQualityScore([answered(70)], input), /invalid_answer_quality_scores/);
  }
});
test('public metadata projects only safe fields and validates formula', () => {
  const result = calculateQualityScore([answered(88)], quality(72));
  const safe = publicScoringSummary({ ...result, private_rubric: 'do not expose', prompt: 'internal' });
  assert.equal(safe.version, VERSION);
  assert.equal(safe.overall, 85);
  assert.equal(Object.hasOwn(safe, 'private_rubric'), false);
  assert.equal(publicScoringSummary({ ...result, overall: 100 }), null);
  assert.equal(publicScoringSummary({ ...result, weights: { role_answers: 50, answer_quality: 50 } }), null);
});
test('perception and emotion are not part of the formula', () => {
  const result = calculateQualityScore([answered(72)], { ...quality(84), confidence: 0, emotion: 'negative' });
  assert.equal(result.overall, 74);
  assert.deepEqual(Object.keys(result.answer_quality_scores), Object.keys(quality(84)));
});
