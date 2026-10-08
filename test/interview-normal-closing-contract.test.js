'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'normal-closing-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'normal-closing-anon-key';

const {
  NORMAL_COMPLETION_FAREWELL_TEXT,
  buildConversationalContext,
} = require('../handlers/createTavusInterview');
const { isTerminalInterviewToolName } = require('../src/lib/tavusTerminalTool');

const ROOT = path.join(__dirname, '..');
const { systemPrompt: personaPrompt, buildPersonaPatch } = require('../scripts/patchTavusQaP1Persona');
const {
  INTERVIEW_CLOSING_PROMPT_LINES,
  CLOSING_PROCESS_ANSWER,
  CLOSING_UNAVAILABLE_ANSWER,
  CLOSING_INTERNAL_ANSWER,
} = require('../src/lib/interviewClosingContract');
const { normalizeEndReason } = require('../routes/tavus');
const webhookSource = fs.readFileSync(path.join(ROOT, 'routes', 'webhook.js'), 'utf8');

function occurrences(value, search) {
  return String(value).split(search).length - 1;
}

function escapedRegex(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

test('normal completion contract is exact, singular, and application-owned', () => {
  const context = buildConversationalContext(
    'Avery',
    'Customer Service Representative',
    'Synthetic Company',
    ['Describe a customer issue you resolved.'],
    '',
    10,
  );

  assert.equal(NORMAL_COMPLETION_FAREWELL_TEXT, 'Thank you for your time. I am ending the session now.');
  assert.equal(occurrences(context, 'Do you have any questions before we wrap up?'), 1);
  assert.match(context, /say exactly: "Thank you for your time\. I am ending the session now\."/);
  assert.match(context, /Never repeat this closing question/);
  assert.match(context, /Never say or imply "we'll be in touch"/);
  assert.doesNotMatch(context, /call(?:\/use)? the existing end_interview tool/i);
  for (const prompt of [context, personaPrompt]) {
    assert.doesNotMatch(prompt, /end_call|response_to_user|natural_conclusion/);
    assert.match(prompt, /Session termination is handled by the application/);
  }
});

test('closing denials are explicitly answers and cannot use the unavailable-information fallback', () => {
  const context = buildConversationalContext(
    'Avery',
    'Customer Service Representative',
    '',
    ['Describe a customer issue you resolved.'],
  );
  for (const phrase of ['no', 'none', "I don't have any", 'no questions', 'nothing else', 'none that I can think of']) {
    assert.match(context, escapedRegex(phrase));
    assert.match(personaPrompt, escapedRegex(phrase));
  }
  assert.match(context, /closing answer, not a candidate question/i);
  assert.match(context, /Never use the unavailable-information fallback for a closing answer/i);
  assert.match(personaPrompt, /They are not live candidate questions and must never trigger the unavailable-information response/i);
});

test('refusal or inability exhausts the one allowed follow-up', () => {
  const context = buildConversationalContext(
    'Avery',
    'Customer Service Representative',
    '',
    ['Describe a customer issue you resolved.'],
  );
  assert.match(context, /A refusal, inability to answer, or statement that the candidate cannot think of an example completes the permitted follow-up/);
  assert.match(context, /Never ask a second follow-up, hypothetical, rephrased question, alternate question, or another request for an example/);
  assert.match(personaPrompt, /Never ask a second follow-up, hypothetical, rephrased question, alternate question, or another request for an example/);
});

test('persona and dynamic context use the identical bounded wrap-up contract', () => {
  const context = buildConversationalContext('Avery', 'Synthetic Role', '', ['Describe your work.']);
  for (const prompt of [context, personaPrompt]) {
    for (const line of INTERVIEW_CLOSING_PROMPT_LINES) assert.ok(prompt.includes(line), line);
    assert.match(prompt, /answer at most one candidate question/);
    assert.match(prompt, /explicit request to finish during wrap-up/);
    assert.match(prompt, /override every earlier redirect or refusal rule/);
    assert.match(prompt, /never say "Let's continue", return to a structured question/);
    for (const answer of [CLOSING_PROCESS_ANSWER, CLOSING_UNAVAILABLE_ANSWER, CLOSING_INTERNAL_ANSWER]) {
      assert.ok(prompt.includes(`"${answer} ${NORMAL_COMPLETION_FAREWELL_TEXT}"`));
    }
    assert.match(prompt, /Never say or imply "we'll be in touch"/);
    assert.doesNotMatch(prompt, /responses will be available|an acknowledgment/);
    assert.match(prompt, /including what happens after the interview/);
    for (const line of prompt.split('\n').filter((line) => /say exactly:.*Let's continue|Then repeat or briefly restate the active question|For example, say: "Please focus/.test(line))) {
      assert.match(line, /^- While a structured question is unfinished,/);
    }
  }
});

test('prompt-only QA patch changes only system_prompt and refuses other personas', () => {
  assert.deepEqual(buildPersonaPatch({ promptOnly: true, personaId: 'pa40626945f5' }), [
    { op: 'replace', path: '/system_prompt', value: personaPrompt },
  ]);
  for (const personaId of ['p75bb8779b7d', 'p7cb30e9c407', 'unknown', undefined]) {
    assert.throws(() => buildPersonaPatch({ promptOnly: true, personaId }), /requires the verified QA persona/);
  }
  const run = (personaId) => spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'patchTavusQaP1Persona.js'), '--prompt-only',
  ], {
    encoding: 'utf8',
    env: { ...process.env, TAVUS_API_KEY: 'synthetic-not-used', TAVUS_PERSONA_ID: personaId },
  });
  const qa = run('pa40626945f5');
  assert.equal(qa.status, 0, qa.stderr);
  const patch = JSON.parse(qa.stdout.slice(qa.stdout.indexOf('[\n')));
  assert.deepEqual(patch, [{ op: 'replace', path: '/system_prompt', value: personaPrompt }]);
  for (const personaId of ['p75bb8779b7d', 'p7cb30e9c407', 'unknown']) {
    const other = run(personaId);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /requires the verified QA persona pa40626945f5/);
  }
});

test('importing the persona prompt never loads dotenv or starts a vendor call', () => {
  const probe = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...args) {
      assert.notEqual(name, 'dotenv');
      if (name === '../src/lib/tavusHttpClient') return {
        createTavusHttpClient() { throw new Error('Unexpected vendor client'); }
      };
      return load.call(this, name, ...args);
    };
    const prompt = require('./scripts/patchTavusQaP1Persona');
    assert.equal(typeof prompt.systemPrompt, 'string');
    assert.equal(prompt.buildPersonaPatch({ promptOnly: true, personaId: 'pa40626945f5' }).length, 1);
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, '');
});

test('timed avatar farewell is recorded as normal completion without changing failure reasons', () => {
  assert.equal(normalizeEndReason('time_limit_avatar_farewell_complete'), 'completed_normally');
  assert.equal(normalizeEndReason(' TIME_LIMIT_AVATAR_FAREWELL_COMPLETE '), 'completed_normally');
  assert.equal(normalizeEndReason('progress_stalled'), 'watchdog_timeout');
  assert.equal(normalizeEndReason('disconnected'), 'reconnect_failed');
  assert.equal(normalizeEndReason('manual'), 'candidate_ended');
  assert.equal(normalizeEndReason('unknown'), 'vendor_end_event');
});

test('backend terminal tool contract supports current and legacy names', () => {
  assert.equal(isTerminalInterviewToolName('end_call'), true);
  assert.equal(isTerminalInterviewToolName(' END_CALL '), true);
  assert.equal(isTerminalInterviewToolName('end_interview'), true);
  assert.equal(isTerminalInterviewToolName('unknown_tool'), false);
  assert.match(webhookSource, /isTerminalInterviewToolName\(toolName\)/);
  assert.doesNotMatch(webhookSource, /toolName === 'end_interview'/);
});
