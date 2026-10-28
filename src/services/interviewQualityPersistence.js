'use strict';
const crypto = require('node:crypto');
const { VERSION, publicScoringSummary } = require('./interviewQualityScoring');

async function applyInterviewQualityScore({ db, interview, scored, questions, analysisV2 = null }) {
  const { data, error } = await db.rpc('apply_interview_quality_score', {
    p_interview_id: interview.id,
    p_expected_updated_at: interview.updated_at,
    p_expected_transcript_hash: crypto.createHash('sha256').update(interview.transcript || '').digest('hex'),
    p_scores: scored.transcript_scores, p_summary: scored.summary,
    p_scoring_summary: publicScoringSummary(scored.scoring_summary),
    p_details: scored.scoring_details || null, p_questions: questions, p_analysis_v2: analysisV2,
  });
  if (error) throw new Error('quality_score_persistence_failed');
  const result = Array.isArray(data) ? data[0] : data;
  if (!['applied', 'already_applied'].includes(result?.outcome)) throw new Error('quality_score_superseded');
  return { outcome: result.outcome, version: VERSION };
}
module.exports = { applyInterviewQualityScore };
