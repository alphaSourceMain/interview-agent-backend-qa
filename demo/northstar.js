'use strict';
const { DEMO_CLIENT_ID, uuid } = require('../src/lib/salesDemo');

// Authored examples, not assessments of real people or results of model scoring.
const roles = [
  { id: uuid(100), title: 'Account Executive', description: 'Northstar Talent Partners (fictional) seeks an Account Executive to develop staffing accounts, conduct discovery, manage a disciplined CRM pipeline, and close consultative B2B engagements. Three years of relevant B2B selling, measurable quota outcomes, careful qualification, and ethical expectation-setting are preferred.', questions: [
    ['Discovery and qualification', 'Describe a discovery call that changed your sales approach. What did you learn and what did you do?', 30],
    ['Pipeline discipline', 'How do you manage your pipeline and forecast? Give a concrete example.', 25],
    ['Objection handling', 'Tell me about a price objection and how you handled it without overpromising.', 25],
    ['Client handoff', 'How do you hand a newly won account to the delivery team?', 20],
  ] },
  { id: uuid(200), title: 'Customer Support Specialist', description: 'Northstar Talent Partners (fictional) seeks a Customer Support Specialist to resolve candidate and client inquiries through clear written communication, evidence-led troubleshooting, appropriate escalation, and accurate case notes. Experience with help-desk systems and handling confidential information is preferred.', questions: [
    ['Customer communication', 'Describe a frustrated customer interaction and how you responded.', 30],
    ['Troubleshooting', 'Walk me through diagnosing a customer who cannot access their account.', 30],
    ['Prioritization and escalation', 'How do you prioritize competing tickets and decide when to escalate?', 20],
    ['Documentation and privacy', 'What do you record in case notes and what information should you avoid collecting?', 20],
  ] },
];

const people = [
  { n: 1001, role: 0, name: 'Avery Morgan', level: 'Strong evidence', resume: 92, experience: 95, skills: 92, education: 85, points: [94, 92, 90, 91], confidence: 94,
    headline: 'B2B account executive with five years in professional-services sales.',
    experienceText: ['Account Executive | Lumen Ridge Services (fictional) | 2022-2026', 'Managed a $1.1M annual quota; reached 112% in 2025 and 108% in 2024. Owned discovery, account plans, and delivery handoffs.', 'Business Development Representative | Summit Field Partners (fictional) | 2020-2022', 'Built qualified outbound meetings and maintained CRM decision-maker and next-step records.'],
    skillsText: 'Consultative discovery, CRM forecasting, multithreaded account plans, pricing conversations, delivery handoffs.', educationText: 'BA, Business Administration | Fictional Northstar College | 2020',
    answers: [
      'A regional client asked for twenty placements in four weeks. I asked about coverage gaps, attrition, and manager availability. The real constraint was weekend coverage, not headcount. I mapped the five critical shifts and brought delivery into a scoping call. We proposed eight initial placements with weekly checkpoints instead of promising twenty. The first cohort covered all five shifts and the client expanded after six weeks.',
      'Every Friday I inspect stage age, a dated next step, the decision process, and a customer-confirmed timeline. In Q3 I removed two verbal commitments from commit because procurement had not approved terms. That reduced my forecast from $310,000 to $245,000; we closed $238,000. My manager could plan delivery capacity using the smaller, defensible number.',
      'A buyer said our fee was eighteen percent above another offer. I clarified the scope and showed our agreed service levels, not unsupported competitor claims. I offered a smaller pilot at the published rate rather than a discount I could not authorize. The buyer selected the pilot. I documented the assumptions and did not guarantee a hiring outcome.',
      'Before handoff I review the signed scope, contacts, success measures, promised timelines, and open risks with delivery. The client joins a kickoff. For one account I highlighted a pending security review and assigned an owner before work began. I stayed through the first checkpoint and confirmed the customer understood the next steps.',
    ], followUp: 'Validate quota attainment with references and ask how the approach scales across several concurrent accounts.', limitation: 'Results are self-reported within an authored demonstration. No employer verification or recorded interview exists.' },
  { n: 1002, role: 0, name: 'Jordan Ellis', level: 'Mixed evidence', resume: 76, experience: 77, skills: 80, education: 70, points: [78, 68, 76, 72], confidence: 78,
    headline: 'Two years of inside sales with developing ownership of the full account cycle.',
    experienceText: ['Inside Sales Representative | Cedar Vale Software (fictional) | 2024-2026', 'Supported a $480,000 team pipeline and reported 96% of individual activity targets. Joined discovery calls and prepared CRM summaries.', 'Sales Coordinator | Arc Harbor Supply (fictional) | 2022-2024', 'Prepared proposals, coordinated meetings, and maintained customer contact records.'],
    skillsText: 'CRM updates, product demonstrations, proposal coordination, inbound qualification.', educationText: 'Associate degree, Business | Fictional Lakeshore College | 2022',
    answers: [
      'A prospect wanted a product demonstration. I asked about team size and their current process, then learned their manager was not involved. I added a manager discovery meeting before the demo. It helped us explain the right workflow, although I did not track the eventual operational result.',
      'I review opportunities each Monday and update dates. I use my judgment about how positive the calls feel. Last month two deals moved to the next quarter after purchasing delays. I had included both in commit. I am starting to require a confirmed decision date but cannot give a forecast-accuracy figure yet.',
      'When a customer raised price, I asked what budget they had and reviewed the basic package. My manager approved a smaller scope. I did not promise a discount independently. The customer kept talking with us, but I did not personally own the closing decision.',
      'I send an email with the contract and contact names to the account team. I try to attend the kickoff. I do not yet use a standard checklist for risks or customer success measures; our account manager fills those in.',
    ], followUp: 'Probe forecast criteria and ask for a complete, personally owned close-to-delivery example.', limitation: 'Limited direct ownership evidence; no inference about capability outside the specific examples provided.' },
  { n: 1003, role: 0, name: 'Taylor Reed', level: 'Limited evidence', resume: 58, experience: 50, skills: 65, education: 62, points: [52, 48, 54, 50], confidence: 62,
    headline: 'Retail sales associate exploring a first B2B account executive position.',
    experienceText: ['Sales Associate | Pine Meadow Retail (fictional) | 2023-2026', 'Assisted customers, met daily service targets, and processed purchases. No B2B quota ownership claimed.', 'Customer Service Associate | Oak Lane Market (fictional) | 2021-2023', 'Resolved routine returns and maintained accurate transaction records.'],
    skillsText: 'Customer service, retail product knowledge, transaction accuracy; introductory CRM course.', educationText: 'Sales foundations certificate | Fictional Open Learning Institute | 2025',
    answers: [
      'I usually explain the features first and ask whether the price works. In retail I helped someone compare two products. I have not run a business discovery call or mapped decision-makers, so I would need a process and coaching.',
      'I keep a personal list and contact people when I have time. I have not used a formal opportunity pipeline or forecast model. I would mark a deal likely when a customer seemed interested, but I cannot provide an accuracy example.',
      'I would tell the customer we are the best and try to get a lower price approved. I do not yet know how to compare staffing service levels. I would ask my manager before making a guarantee or offering a discount.',
      'I would send the buyer information to the next team. I have not done an account kickoff and cannot give an example of documenting delivery risks. A checklist would help me know what to include.',
    ], followUp: 'Use a practical discovery exercise and assess whether a junior sales pathway is more appropriate.', limitation: 'Limited role-specific experience was explicitly acknowledged. Do not equate a low demo score with a general hiring recommendation.' },
  { n: 2001, role: 1, name: 'Casey Bennett', level: 'Strong evidence', resume: 90, experience: 92, skills: 93, education: 82, points: [93, 92, 91, 94], confidence: 95,
    headline: 'Support specialist with four years of structured help-desk experience.',
    experienceText: ['Support Specialist | Harbor Path Systems (fictional) | 2022-2026', 'Handled 35-45 cases daily using a ticketing system, documented reproducible defects, and coached new support staff.', 'Customer Service Associate | Spruce Point Services (fictional) | 2020-2022', 'Managed scheduling questions and routine account inquiries.'],
    skillsText: 'Ticket triage, structured troubleshooting, customer updates, escalation notes, privacy-safe verification.', educationText: 'Associate degree, Information Systems | Fictional Riverbend College | 2020',
    answers: [
      'A customer had lost access before a deadline. I acknowledged the impact, repeated the goal, and gave a twenty-minute update commitment rather than promising an immediate fix. I checked access logs, involved the account administrator, and sent updates until restored. I documented the cause and confirmed they could complete the task.',
      'I first check the exact error, URL, and whether others are affected. I verify identity using our approved process, never ask for a password, and check account state and service health. If a safe browser check fails, I record the steps and escalate with a redacted screenshot. I verify the customer can sign in before closing.',
      'I prioritize safety or access-wide incidents, then business impact and SLA. Yesterday I linked six duplicate reports to one outage and escalated once with affected counts. A single how-to question received an update while I worked the incident. I documented owners and next update times.',
      'I record the reported issue, timestamps, troubleshooting, outcome, and next owner. I exclude passwords, authentication tokens, and unnecessary personal information. Screenshots are redacted. For a suspected security issue I use the restricted escalation route instead of copying details broadly.',
    ], followUp: 'Validate case-quality examples and discuss adapting the process to staffing-client workflows.', limitation: 'Authored synthetic evidence, not a verified operational support history or media-based evaluation.' },
  { n: 2002, role: 1, name: 'Riley Chen', level: 'Mixed evidence', resume: 75, experience: 74, skills: 79, education: 72, points: [80, 72, 69, 76], confidence: 80,
    headline: 'Customer service professional developing technical support and escalation skills.',
    experienceText: ['Customer Service Representative | Willow Bridge Commerce (fictional) | 2023-2026', 'Handled order questions and account changes. Used standard templates and escalated technical cases to a lead.', 'Service Desk Intern | Meadowbrook Services (fictional) | 2022-2023', 'Categorized inbound tickets and assisted with customer follow-ups.'],
    skillsText: 'Customer updates, ticket categorization, basic browser checks, template-based case notes.', educationText: 'Customer service certificate | Fictional Westfield Training Center | 2022',
    answers: [
      'A customer was upset about an order delay. I acknowledged it and checked the order, then explained the next delivery estimate. I followed up the next day. I did not have a written update schedule, but the customer thanked me for checking back.',
      'I ask what error they see and suggest trying another browser. If that fails I send it to the lead. I have not routinely checked service health or account state myself. I would not ask for their password, and I would record the exact error.',
      'I usually work oldest tickets first, but would move an urgent issue up if my lead asked. I do not yet use a formal impact matrix. Once I escalated several related tickets separately and later learned we should link them under one incident.',
      'I write the issue and what I tried in the ticket. I never record a password. I am still learning which screenshots require redaction and when a case should go to the restricted security queue.',
    ], followUp: 'Use a triage exercise to test business-impact prioritization and privacy-safe escalation notes.', limitation: 'Specific gaps concern process maturity, not unobserved personal traits.' },
  { n: 2003, role: 1, name: 'Morgan Blake', level: 'Limited evidence', resume: 57, experience: 52, skills: 60, education: 63, points: [61, 47, 50, 48], confidence: 63,
    headline: 'Administrative assistant seeking a first dedicated support role.',
    experienceText: ['Administrative Assistant | Elm Crest Studio (fictional) | 2023-2026', 'Scheduled appointments, answered general inquiries, and maintained office records.', 'Reception Volunteer | Fictional Community Workshop | 2022-2023', 'Directed visitors and passed requests to staff.'],
    skillsText: 'Appointment scheduling, basic email communication, office document preparation.', educationText: 'Office administration certificate | Fictional Southbank College | 2023',
    answers: [
      'I would apologize and tell the customer I will try to fix it. I once redirected a visitor to the right office. I do not have a detailed example of managing a frustrated support customer through resolution.',
      'I might ask them to send a screenshot and tell me what they typed. I have not worked with a formal identity-check process. I now understand that I should not request passwords and would ask a supervisor for the approved troubleshooting steps.',
      'I would answer whichever ticket I opened first unless someone called again. I cannot give an example of prioritizing a service outage or using an SLA. I would need training on the escalation rules.',
      'I usually write that I talked to the customer and whether I passed it on. I have not used a technical case-note template or redacted a screenshot. I would need clear instructions about what information is safe to store.',
    ], followUp: 'Assess a coached troubleshooting scenario and train on verification, triage, and case-note standards.', limitation: 'Role-specific examples are missing; scoring only illustrates evidence gaps in this demo.' },
];

function buildFixture(now = new Date()) {
  const created = new Date(now.getTime() - 2 * 86400000).toISOString();
  const completed = new Date(now.getTime() - 86400000).toISOString();
  const client = { id: DEMO_CLIENT_ID, name: 'Northstar Talent Partners - Sales Demo', email: 'demo@northstar.example.invalid', billing_status: 'active', manual_active_override: true, access_override_mode: 'force_active', plan_tier: 'pro', parent_client_id: null, entity_label: 'Synthetic sales demonstration', auto_renew: false };
  const result = { version: 1, clients: [client], roles: [], candidates: [], interviews: [], reports: [] };
  for (const role of roles) result.roles.push({ id: role.id, client_id: DEMO_CLIENT_ID, title: role.title, description: role.description, job_description_text: role.description, rubric: { categories: role.questions.map(([name, question, weight]) => ({ name, weight, question })) }, rubric_questions: role.questions.map(([, question]) => question), manual_questions: role.questions.map(([, q]) => q).join('\n'), interview_type: 'video', status: 'active', created_at: created, slug_or_token: `sales-demo-northstar-${role.id}`, max_candidates: 3 });
  for (const p of people) {
    const role = roles[p.role];
    const interviewScore = Math.round(p.points.reduce((sum, score, i) => sum + score * role.questions[i][2] / 100, 0));
    const overall = Math.round((p.resume + interviewScore) / 2);
    const summary = `[SYNTHETIC DEMO] ${p.level}. ${p.followUp}`;
    const transcript = '[SYNTHETIC DEMO TRANSCRIPT - no real interview was conducted]\n\n' + p.answers.map((answer, i) => `Q${i + 1} - Interviewer: ${role.questions[i][1]}\n${p.name}: ${answer}`).join('\n\n');
    const evidence = p.answers.map((answer, i) => `Q${i + 1} - ${role.questions[i][0]} (${p.points[i]}/100; weight ${role.questions[i][2]}%): "${answer}"`);
    const breakdown = { experience_match_percent: p.experience, skills_match_percent: p.skills, education_match_percent: p.education, resume_score: p.resume, summary: `[SYNTHETIC DEMO] ${p.headline} ${p.experienceText.join(' ')} Follow-up: ${p.followUp}` };
    const candidateId = uuid(p.n), interviewId = uuid(p.n + 10000), reportId = uuid(p.n + 20000);
    result.candidates.push({ id: candidateId, client_id: DEMO_CLIENT_ID, role_id: role.id, name: p.name, first_name: p.name.split(' ')[0], last_name: p.name.split(' ').slice(1).join(' '), email: `${p.name.toLowerCase().replace(/ /g, '.')}@example.invalid`, status: 'review_ready', interview_status: 'completed', created_at: created, upload_ts: created, candidate_id: `SYNTHETIC-${p.n}`, analysis_summary: breakdown, resume_url: `sales-demo/${candidateId}.pdf`, resume_original_filename: `${p.name.toLowerCase().replace(/ /g, '-')}-synthetic-resume.pdf`, resume_mime_type: 'application/pdf', resume_parse_status: 'parsed', phone: null, phone_e164: null });
    const analysisV2 = { scores: { response_specificity: interviewScore, answer_directness: Math.min(100, interviewScore + 2), answer_consistency: Math.min(100, interviewScore + 1), communication_structure: interviewScore }, conditions: { evaluation_conditions: 'Authored demo transcript only; no real audio/video was analyzed.', signal_confidence: 'Illustrative', audio_quality_issues: 'Not assessed - no recording', distraction_risk: 'Not assessed - no recording' }, evidence_summary: summary, evidence, limitations: [p.limitation, 'Synthetic scores are illustrative, not real assessment results.'], risk: { integrity_risk: 'Not assessed', reason: 'No inference about integrity is made from authored demo data.' } };
    result.interviews.push({ id: interviewId, candidate_id: candidateId, client_id: DEMO_CLIENT_ID, role_id: role.id, transcript, status: 'completed', is_active: false, attempt_number: 1, attempt_mode: 'video', created_at: completed, started_at: completed, ended_at: completed, has_substantive_response: true, substantive_response_count: 4, candidate_utterance_count: 4, transcript_available: true, recording_status: 'demo_placeholder', video_url: null, transcript_scores: { overall: interviewScore, confidence: p.confidence, ai_aided_risk: null, ai_aided_risk_reason: 'Not assessed for authored demo data.', rubric_scores: role.questions.map(([name,,weight], i) => ({ category: name, weight, score: p.points[i], evidence: evidence[i] })) }, perception_scores: { unavailable: true, mode: 'demo', reason: 'No recording or perception analysis exists for this synthetic example.' }, interview_summary: summary, interview_analysis_v2: analysisV2, unanswered_candidate_questions: [p.followUp], analysis: analysisV2 });
    result.reports.push({ id: reportId, candidate_id: candidateId, client_id: DEMO_CLIENT_ID, role_id: role.id, interview_id: interviewId, attempt_number: 1, report_kind: 'complete_interview', created_at: completed, report_generated_at: completed, resume_score: p.resume, interview_score: interviewScore, overall_score: overall, resume_breakdown: breakdown, interview_breakdown: { summary, rubric_scores: role.questions.map(([name,,weight], i) => ({ category: name, weight, score: p.points[i], evidence: evidence[i] })) }, analysis: { summary, evidence, limitations: analysisV2.limitations }, unanswered_candidate_questions: [p.followUp] });
  }
  return result;
}
module.exports = { buildFixture, roles, people };
