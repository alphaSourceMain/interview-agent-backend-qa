'use strict';

const VERSION = 'role_quality_v3';
const WEIGHTS = Object.freeze({ role_answers: 80, answer_quality: 20 });
const QUALITY_KEYS = Object.freeze(['response_specificity', 'answer_directness', 'answer_consistency', 'communication_structure']);

function numericScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value) : null;
}
function normalizeQualityScores(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = Object.fromEntries(QUALITY_KEYS.map(key => [key, numericScore(value[key])]));
  return Object.values(out).some(score => score === null) ? null : out;
}
function scoreBand(score) {
  if (!Number.isFinite(score)) return 'Unavailable';
  return score < 60 ? 'Below baseline' : score < 75 ? 'Adequate' : score < 90 ? 'Strong' : 'Exceptional';
}
function calculateQualityScore(questionEvaluations, qualityInput) {
  const scores = (Array.isArray(questionEvaluations) ? questionEvaluations : [])
    .filter(item => item?.scorable === true && numericScore(item.score) !== null)
    .map(item => numericScore(item.score));
  if (!scores.length) return null;
  const quality = normalizeQualityScores(qualityInput);
  if (!quality) throw new Error('invalid_answer_quality_scores');
  const roleTotal = scores.reduce((sum, score) => sum + score, 0);
  const qualityTotal = Object.values(quality).reduce((sum, score) => sum + score, 0);
  const roleAnswers = roleTotal / scores.length;
  const answerQuality = qualityTotal / QUALITY_KEYS.length;
  // Integer numerator avoids double rounding and floating-point tie drift.
  const overall = Math.round((roleTotal * 80 * 4 + qualityTotal * 20 * scores.length) / (100 * scores.length * 4));
  return {
    version: VERSION, role_answers: roleAnswers, answer_quality: answerQuality,
    overall, weights: { ...WEIGHTS }, answer_quality_scores: quality,
    scorable_questions: scores.length,
    unscored_questions: (questionEvaluations || []).filter(item => item?.scorable === false).length,
  };
}
function publicScoringSummary(value) {
  if (!value || value.version !== VERSION || value.weights?.role_answers !== 80 || value.weights?.answer_quality !== 20) return null;
  const quality = normalizeQualityScores(value.answer_quality_scores);
  const mean = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  const role = mean(value.role_answers), answer = mean(value.answer_quality), overall = numericScore(value.overall);
  if (!quality || role === null || answer === null || overall === null) return null;
  const count = value.scorable_questions;
  if (!Number.isInteger(count) || count < 1 || count > 25 || !Number.isInteger(value.unscored_questions) || value.unscored_questions < 0) return null;
  const roleTotal = Math.round(role * count);
  const qualityTotal = Object.values(quality).reduce((sum, score) => sum + score, 0);
  if (Math.abs(role - roleTotal / count) > 1e-8 || answer !== qualityTotal / 4 || overall !== Math.round((roleTotal * 80 * 4 + qualityTotal * 20 * count) / (100 * count * 4))) return null;
  return { version: VERSION, role_answers: role, answer_quality: answer, overall,
    weights: { ...WEIGHTS }, answer_quality_scores: quality,
    scorable_questions: Number.isInteger(value.scorable_questions) && value.scorable_questions > 0 ? value.scorable_questions : null,
    unscored_questions: Number.isInteger(value.unscored_questions) && value.unscored_questions >= 0 ? value.unscored_questions : null };
}
function publicQualityAnalysis(value, summary) {
  const quality = publicScoringSummary(summary);
  if (!quality) return value || null;
  const current = value && value.version === 'path_a_v1_role_quality_v3' ? value : {};
  return { ...current, version: 'path_a_v1_role_quality_v3', scores: { ...quality.answer_quality_scores } };
}
function isQualityInterview(interview) { return interview?.interview_quality_version === VERSION; }

module.exports = { VERSION, WEIGHTS, QUALITY_KEYS, numericScore, normalizeQualityScores,
  calculateQualityScore, publicScoringSummary, scoreBand, isQualityInterview, publicQualityAnalysis };
