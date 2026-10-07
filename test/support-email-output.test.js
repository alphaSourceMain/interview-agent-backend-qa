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
