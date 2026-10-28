'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.OPENAI_API_KEY = 'synthetic-local-only';
const { scoreInterview } = require('../src/services/interviewScoring');
const { buildInterviewAnalysisV2Prompt, normalizeInterviewAnalysisV2Result } = require('../src/services/interviewAnalysisV2');
const { VERSION, calculateQualityScore } = require('../src/services/interviewQualityScoring');
const quality = {response_specificity:80,answer_directness:75,answer_consistency:85,communication_structure:76};
const role = {title:'Synthetic operations lead', rubric:{questions:[{text:'Describe a workflow you improved.'},{text:'How did you measure the result?'}]}};
const transcript='INTERVIEWER: Describe a workflow you improved.\nCANDIDATE: I led a review of our approval process and removed a duplicate review. I introduced a checklist so our team reduced turnaround from five days to two.\nINTERVIEWER: How did you measure the result?\nCANDIDATE: I used four weeks of cycle time before and after and checked that error rates did not rise.';
const parsed = {summary:'Concrete ownership and a practical measured improvement demonstrate strong job-relevant evidence.',overall:10,role_fit:10,technical_strength:10,communication_quality:10,evidence_strength:80,ai_aided_risk:'high',ai_aided_risk_reason:'Synthetic informational flag.',answer_quality_scores:quality,question_evaluations:[{question_order:1,score:84,scorable:true,anchor:'strong',missing_reason:'none',evidence:'Removed duplicate review.'},{question_order:2,score:78,scorable:true,anchor:'strong',missing_reason:'none',evidence:'Measured cycle time and errors.'}]};
async function mocked(value,fn){const old=global.fetch;let body;global.fetch=async(_,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})};};try{return await fn(()=>body);}finally{global.fetch=old;}}
test('new scorer recomputes 80/20, canonical fields agree, perception and risk cannot lower score',async()=>{
 await mocked(parsed,async request=>{
 const result=await scoreInterview({transcriptText:transcript,roleContext:role,scoringVersion:VERSION,perceptionScores:{clarity:1,confidence:2,engagement:3,emotion:'private-emotion-marker'}});
 assert.equal(result.transcript_scores.overall,81);
 for(const k of ['role_fit','technical_strength','communication_quality']) assert.equal(result.transcript_scores[k],81);
 assert.equal(result.scoring_summary.answer_quality,79);
 assert.equal(result.transcript_scores.ai_aided_risk,'high');
 assert.equal(Object.keys(result.transcript_scores).length,7);
 assert.match(result.summary,/Strong \(81\/100\)/);
 const prompt=request().messages[1].content;
 assert.match(prompt,/realistic job-level anchors/);assert.doesNotMatch(prompt,/private-emotion-marker|"clarity":1|off-screen eye tracking|not enough by themselves|scripted\/read-aloud|perception data, and|AI-aided delivery patterns/);
 });
});
test('missing quality fails closed; an unasked question does not penalize the candidate',async()=>{
 await mocked({...parsed,answer_quality_scores:{}},async()=>assert.rejects(()=>scoreInterview({transcriptText:transcript,roleContext:role,scoringVersion:VERSION}),/invalid_answer_quality_scores/));
 await mocked({...parsed,question_evaluations:[parsed.question_evaluations[0],{question_order:2,score:null,scorable:false,anchor:'unscored',missing_reason:'technical_issue',evidence:'Interrupted before question.'}]},async()=>{
  const r=await scoreInterview({transcriptText:transcript,roleContext:role,scoringVersion:VERSION});assert.equal(r.transcript_scores.overall,83);assert.equal(r.scoring_summary.unscored_questions,1);
 });
});
test('no eligible role questions leaves score unavailable',async()=>{
 await mocked({...parsed,question_evaluations:parsed.question_evaluations.map((e)=>({...e,score:null,scorable:false,anchor:'unscored',missing_reason:'interviewer_process'}))},async()=>{
 const r=await scoreInterview({transcriptText:transcript,roleContext:role,scoringVersion:VERSION});assert.equal(r.transcript_scores.overall,null);assert.equal(r.scoring_summary,null);
 });
});
test('new analysis omits perception and preserves the authoritative four values',()=>{
 const summary=calculateQualityScore(parsed.question_evaluations,quality);
 const prompt=buildInterviewAnalysisV2Prompt({transcript,scoring_summary:summary,perception_scores:{clarity:3},perception_analysis_text:'PRIVATE_PERCEPTION'});
 assert.doesNotMatch(prompt,/PRIVATE_PERCEPTION|"perception_scores"/);assert.match(prompt,/authoritative_scoring_summary/);
 const result=normalizeInterviewAnalysisV2Result({scores:{response_specificity:1},evidence_summary:'Concrete workflow example.',evidence:['Reduced turnaround from five days to two.']},summary);
 assert.equal(result.version,'path_a_v1_role_quality_v3');assert.deepEqual(result.scores,quality);
 assert.throws(()=>normalizeInterviewAnalysisV2Result({},summary),/missing_quality_analysis_evidence/);
});
test('fractional means retain precision and round only the final sum',()=>{
 const result=calculateQualityScore([80,81,82].map(score=>({scorable:true,score})),{...quality,response_specificity:81});
 assert.equal(result.answer_quality,79.25);assert.equal(result.overall,81);
});

test('v3 without an authoritative score strips perception and cannot publish independent quality numbers',()=>{
 const prompt=buildInterviewAnalysisV2Prompt({transcript,interview_quality_version:VERSION,scoring_summary:null,perception_scores:{clarity:99},perception_analysis_text:'PRIVATE_PERCEPTION'});
 assert.doesNotMatch(prompt,/PRIVATE_PERCEPTION|"perception_scores"|Use final Tavus perception/);
 assert.throws(()=>normalizeInterviewAnalysisV2Result({scores:{response_specificity:90},evidence:['example'],evidence_summary:'example'},null,VERSION),/quality_score_unavailable/);
 const {publicQualityAnalysis}=require('../src/services/interviewQualityScoring');
 assert.equal(publicQualityAnalysis({scores:{response_specificity:90}},null,VERSION),null);
});
