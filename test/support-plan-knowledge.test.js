'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { readKnowledgeFiles, buildSupportVoicePrompt, MAX_PROMPT_BYTES } = require('../src/services/supportVoiceKnowledge');

test('support knowledge includes current membership terms and retains audience-specific answers', () => {
  const { snapshot, version } = readKnowledgeFiles();
  assert.equal(version, '2026-10-23.1');
  const items = [...snapshot.dashboard.faq_sections.flatMap(s => s.items),
    ...snapshot.public.faq_sections.flatMap(s => s.items), ...snapshot.public.support_questions];
  const pairs = items.map(q => JSON.stringify([q.question, q.answer]));
  assert.equal(new Set(pairs).size, pairs.length);
  const answer = q => items.find(item => item.question === q)?.answer;
  assert.match(answer('How does pricing work?'), /\$1,200.*\$1,950.*\$3,300.*\$2,100.*\$3,600.*\$6,500/);
  assert.match(answer('Is monthly billing a month-to-month membership?'), /3-, 6-, or 12-month commitment/);
  assert.match(answer('When does my membership term start?'), /agreement-generation date/);
  assert.match(answer('How do renewal, cancellation, and refunds work?'), /not the date access or payment obligations end/);
  assert.match(answer('How does Enterprise billing work?'), /per-completed-interview rate/);
  assert.match(answer('What support comes with each membership?'), /not a live human conversation/);
  assert.doesNotMatch(JSON.stringify(items), /\$299 monthly|\$599 monthly|installment option for a 12-month membership/);
  assert.ok(snapshot.dashboard.product_updates.length > 1 && snapshot.public.product_updates.length > 1);
});

test('updated static knowledge fits the unchanged voice ceiling with and without caller-approved escalation', () => {
  for (const handoff of [false, true]) {
    const p = buildSupportVoicePrompt({ handoff });
    assert.ok(p.promptBytes < MAX_PROMPT_BYTES);
    assert.match(p.prompt, /cannot access or inspect the caller's account/);
    if (handoff) assert.match(p.prompt, /Only after an explicit yes call send_support_message/);
    else assert.match(p.prompt, /Do not use tools, functions, MCP/);
  }
});
