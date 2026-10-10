'use strict';
// Synthetic-only visual acceptance artifacts; no database access or credentials.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { buildFixture } = require('../demo/northstar');
const { buildCandidateReportPayload } = require('../src/render/candidateReportData');
const { buildCandidateReportHtml, getCandidateReportPdfOptions } = require('../src/render/candidateReport');
const { buildMembershipAgreementHtml } = require('../src/render/membershipAgreement');
const { htmlToPdf } = require('../src/render/pdfRenderer');

async function main() {
  const output = path.resolve(process.argv[2] || 'tmp/pdfs/review-brief');
  fs.mkdirSync(output, { recursive:true });
  const data=buildFixture(new Date('2026-10-09T16:00:00Z'), { syntheticSignals:true });
  const scenarios=data.candidates.map((candidate,i) => ({
    key:'demo-'+(i+1), candidate, interview:data.interviews[i], client:data.clients[0],
    role:data.roles.find(r => r.id === candidate.role_id), exposeAdvanced:true, syntheticDemo:true,
  }));
  const base=structuredClone(scenarios[0]);
  base.syntheticDemo=false; base.client={ name:'Fictional Validation Company' }; base.candidate.name='Synthetic Validation Candidate';
  const missing={ ...structuredClone(base), key:'missing', candidate:{ name:'Synthetic Unassessed Candidate' }, interview:null };
  const text=structuredClone(base); text.key='text'; text.interview.perception_scores={ mode:'text', unavailable:true };
  const insufficient=structuredClone(base); insufficient.key='insufficient'; insufficient.interview.has_substantive_response=false; insufficient.interview.failure_code='NO_SUBSTANTIVE_CANDIDATE_RESPONSE';
  const closed=structuredClone(base); closed.key='closed-gate'; closed.exposeAdvanced=false;
  const empty=structuredClone(base); empty.key='empty-v2'; empty.interview.interview_analysis_v2={};
  const conditions=structuredClone(base); conditions.key='conditions-only'; conditions.interview.interview_analysis_v2={ conditions:{ audio_quality_issues:'minor' } };
  const risk=structuredClone(base); risk.key='risk-only'; risk.interview.interview_analysis_v2={ risk:{ integrity_risk:'medium', reason:'Clarify the inconsistency.' } };
  const video=structuredClone(base); video.key='unavailable-video'; video.interview.perception_scores={ mode:'video', unavailable:true };
  const long=structuredClone(base); long.key='long';
  long.candidate.analysis_summary.summary=('Long synthetic resume with relevant job examples. ').repeat(65)+'RESUME_END_SENTINEL';
  long.interview.interview_summary=('Long synthetic interview summary with specific evidence. ').repeat(65)+'SUMMARY_END_SENTINEL';
  long.interview.interview_analysis_v2.evidence=Array.from({length:10},(_,i) => ('Synthetic evidence item '+i+'. Detailed actions and results for review. ').repeat(12)+' EVIDENCE_END_'+i);
  long.interview.interview_analysis_v2.limitations=Array.from({length:7},(_,i) => 'Synthetic limitation '+i+': '+('Self-reported context requires follow-up. ').repeat(8)+'LIMIT_END_'+i);
  scenarios.push(missing,text,insufficient,closed,empty,conditions,risk,video,long);
  for (const input of scenarios) {
    const payload=buildCandidateReportPayload(input), html=buildCandidateReportHtml(payload);
    assert(!/<script|src="https?:/i.test(html));
    const pdf=await htmlToPdf(html,getCandidateReportPdfOptions(payload));
    fs.writeFileSync(path.join(output,input.key+'.pdf'),pdf);
    fs.writeFileSync(path.join(output,input.key+'.html'),html);
    if (process.argv.includes('--update-demo') && input.key.startsWith('demo-')) {
      fs.writeFileSync(path.join(__dirname,'../demo/reports',input.candidate.id+'.pdf'),pdf);
    }
    console.log(input.key+': '+pdf.length+' bytes');
  }
  const { html }=buildMembershipAgreementHtml({ client_legal_name:'Synthetic Company', primary_admin_name:'Synthetic Owner', admin_email:'owner@example.invalid', membership_tier:'basic', initial_term_start:'2026-10-09', initial_renewal_date:'2027-10-09', billing_option:'monthly' });
  fs.writeFileSync(path.join(output,'agreement-default.pdf'),await htmlToPdf(html));
}
main().catch(error => { console.error(error); process.exitCode=1; });
