const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDraft } = require('../src/lib/supportEmailPolicy');
for (const answer of ['Candidate reports: open them from the dashboard.', 'You can review transcripts and resumes from the candidate report.',
  'Email support@alphasourceai.com for account-specific help.', 'Contact support @ alphasourceai . com.', 'Please do not share your password or API key.']) {
  test('public static terms allowed: ' + answer, () => assert.equal(validateDraft({ answer, human_review: false }).humanReview, true));
}
for (const answer of ['-----BEGIN PRIVATE KEY-----', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature', '123-45-6789', '4242 4242 4242 4242',
  'Password: abcdef', 'Your API key is abcdef', 'Candidate name: Jane Doe', 'Candidate email = personal@example.invalid',
  'Candidate score: 95', 'Transcript: private conversation', 'Candidate report: name: Jane, score 95',
  'Call +1 (720) 555-1234', 'Email person @ example . invalid', 'secret\t=\tvalue', 'ｐａｓｓｗｏｒｄ： value',
  'Hello\u202e hidden', 'We processed your refund', 'We will reply within 2 hours']) {
  test('unsafe generated output rejected: ' + answer, () => assert.throws(() => validateDraft({ answer, human_review: true }), /INVALID_DRAFT/));
}
for (const phone of ['(605) 599-8008', '605-599-8008', '605.599.8008', '6055998008', '+1 (605) 599-8008', '1-605-599-8008']) {
  test('published company support phone allowed: ' + phone, () => assert.doesNotThrow(() => validateDraft({answer:'Call AI Customer Support at '+phone+'.',human_review:false})));
}
for (const phone of ['(605) 599-8009', '+2 (605) 599-8008', '06055998008', '60559980080', '160559980080',
  '99605599800899', '6055998008 6055998008', '6055998008 and 7205551234', '7205551234 then 6055998008']) {
  test('support phone exception cannot hide other numeric data: ' + phone, () => assert.throws(() => validateDraft({answer:'Call '+phone+'.',human_review:false}),/INVALID_DRAFT/));
}
test('public phone does not bypass other safety checks',()=>{
  for(const answer of ['Call 6055998008. Password: secret', 'Call 6055998008. We processed your refund', 'Call 6055998008 or email person@example.invalid']) {
    assert.throws(()=>validateDraft({answer,human_review:false}),/INVALID_DRAFT/);
  }
});
