'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCandidateQuestions, extractCandidateQuestionsLegacy } = require('../src/services/unansweredCandidateQuestions');
const { INTERVIEW_DELIVERY_STYLE_LINES } = require('../src/services/interviewDeliveryStyle');
const closing = { role: 'assistant', content: 'Do you have any questions before we wrap up?' };
const candidate = content => ({ role: 'user', content });
const agent = content => ({ role: 'assistant', content });
const deferred = agent("I don't have that information. The hiring team can answer that outside the interview. Thank you for your time. I am ending the session now.");

test('employer question survives a deferral and farewell, legacy policy stays unchanged', () => {
  const turns = [closing, candidate('Is this role remote or in-office?'), deferred];
  assert.deepEqual(extractCandidateQuestions(turns), ['Is this role remote or in-office?']);
  assert.deepEqual(extractCandidateQuestionsLegacy(turns), []);
});

test('indirect employer requests without question marks are retained', () => {
  assert.deepEqual(extractCandidateQuestions([closing, candidate('I kind of just want to know more about the offer'), deferred]), ['I kind of just want to know more about the offer']);
});

test('no-question statements, reported questions, rubric requests and repeats stay excluded', () => {
  for (const text of ['None at the moment, thank you.', 'I do not.', "I don't have any questions.", 'A customer asked me what the contract was?', 'What are the scoring criteria?', 'Could you repeat the question?']) {
    assert.deepEqual(extractCandidateQuestions([closing, candidate(text), deferred]), [], text);
  }
});

test('clear topic-matched answers resolve only their own question', () => {
  const turns = [closing, candidate('What is the onboarding sequence?'), candidate('What is the training schedule?'), agent('The onboarding sequence starts with registration and orientation.')];
  assert.deepEqual(extractCandidateQuestions(turns), ['What is the training schedule?']);
});

test('generic acknowledgment and unrelated replies do not resolve pending questions', () => {
  for (const reply of ['Thanks.', 'Understood.', 'The interview is now complete.', "I can't share internal evaluation details during the interview."]) {
    assert.deepEqual(extractCandidateQuestions([closing, candidate('What is the onboarding sequence?'), agent(reply)]), ['What is the onboarding sequence?']);
  }
});

test('long closing questions are not dropped by the old word-count heuristic', () => {
  const text = 'Could you explain the onboarding process? ' + 'I would like to understand the first week and the resources available. '.repeat(5);
  assert.deepEqual(extractCandidateQuestions([closing, candidate(text), deferred]), [text.trim()]);
});

test('reprocessing is deterministic and duplicate questions stay deduplicated', () => {
  const turns = [closing, candidate('What is the onboarding sequence?'), candidate('What is the onboarding sequence?'), deferred];
  assert.deepEqual(extractCandidateQuestions(turns), ['What is the onboarding sequence?']);
  assert.deepEqual(extractCandidateQuestions(turns), extractCandidateQuestions(turns));
});

test('delivery style preserves pause and fair-treatment constraints without answer evaluation', () => {
  const text = INTERVIEW_DELIVERY_STYLE_LINES.join('\n');
  assert.match(text, /same respectful manner for every candidate/);
  assert.match(text, /does not consume or add a follow-up/);
  assert.match(text, /Never call an answer great/);
  assert.match(text, /not inferred emotions/);
});
