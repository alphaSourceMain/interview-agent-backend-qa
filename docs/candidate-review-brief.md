# Candidate Review Brief - QA release contract

Backend-only candidate PDF redesign selected by Jason from the Figma Review Brief. QA first; production needs separate owner acceptance and exact-release review. No database migration, Auth/access change, environment change, or scoring write is part of this release.

## Field ownership and states

Every regular Download PDF click generates a fresh artifact from the authorized candidate and exact bound interview. Existing tenant/client/role/candidate/attempt binding checks remain intact. Cached reports are identifiers/storage metadata, not scoring inputs. Historical download endpoints and existing short-lived signed URLs remain immutable historical snapshots, not a claim that their scores reflect later edits. Newly generated keys are unique per report/request. The reserved QA demo serves six release-versioned authored PDFs; its permissions do not change.

| Display | Owning source / rule |
| --- | --- |
| Resume headline | candidates.analysis_summary.resume_score (same candidate JSON aliases as dashboard) |
| Experience, skills, education | candidates.analysis_summary.*_match_percent (same camelCase aliases as dashboard) |
| Resume summary | candidate analysis_summary summary / resume_summary / resumeSummary / resume_analysis.summary |
| Interview headline | exact interview.transcript_scores.overall |
| Overall | dashboard formula: rounded mean of canonical resume and interview headlines only when both exist; not a report-row fallback |
| Clarity, confidence, engagement | exact interview.perception_scores; body_language is the dashboard's legacy engagement alias |
| Interview summary | exact interview.interview_summary; preserve a present summary even if scoring is still pending |
| Evaluation reliability | exact interview.transcript_scores.confidence; text/unavailable media: not applicable; insufficient/technical: unavailable |
| AI-aided risk / explanation | exact interview.transcript_scores.ai_aided_risk and ai_aided_risk_reason; level only low/medium/high; insufficient/technical: unavailable |
| Four advanced bars | exact interview.interview_analysis_v2.scores response_specificity / answer_directness / answer_consistency / communication_structure |
| Five condition fields | exact v2 conditions evaluation_conditions / signal_confidence / audio_quality_issues / distraction_risk, and v2 risk.integrity_risk |
| Risk context / evidence / limitations | exact v2 risk.reason / evidence_summary / evidence / limitations |
| Unanswered questions | exact interview.unanswered_candidate_questions |
| State, attempt, date | shared interview display classifier, attempt_number, and interview.created_at; displayed date is UTC |

All scores are 0-100, not ratios. Numeric 1 is 1%, 0 is 0%; null/absent/blank/non-numeric/boolean is unavailable. Keep canonical numeric precision for the overall formula; round displayed percentages/bar widths. Clamp finite numeric values to 0-100 as the dashboard does. No categorical score is inferred from a missing field. The renderer escapes all user strings. V2 text uses the same prohibited-trait guard as the candidate UI.

Advanced v2 is visible only when EXPOSE_INTERVIEW_ANALYSIS_V2 is true, or for the server-verified reserved QA demo client/candidate namespace. A closed gate removes all advanced bars, badges, copy and evidence pages. Even with an open gate, an empty v2 object does not create advanced sections. No-response/insufficient and technical failures suppress v2 and perception signals. Text interviews can retain transcript-based advanced scores; visual/perception reliability is not applicable. Condition badges reproduce only nonempty supplied v2 values, never invented default levels; missing badges are omitted. Supplied 'not applicable' condition text is a state label, not an assessed level. Five badges appear only when five values are supplied. Only the reserved QA demo plus perception mode=demo/synthetic=true may show illustrative media signals, with explicit synthetic/no-real-analysis labels.

## Layout and rendering

Clarifications for the design re-review:

1. State precedence is first-match: no-response/insufficient/technical failure suppresses perception, reliability, AI-aided risk and all v2 content even if mode=text. Otherwise text/unavailable visual media means perception/reliability not applicable, with transcript-based v2 subject to its gate. Otherwise pending missing numerics remain unavailable. Present canonical summaries are retained.
2. Overall is unavailable if either canonical headline is unavailable. When both are finite, clamp each headline to the dashboard range before taking its rounded mean; keep source precision until that mean.
3. Illustrative media requires ALL of: QA environment, reserved demo client ID plus reserved candidate namespace, perception.mode exactly demo, and perception.synthetic exactly true. None of these conditions alone is sufficient. Keep explicit synthetic/no-real-analysis copy.
4. Closed gate removes only v2 bars, badges, risk context, evidence copy and evidence pages. Resume, canonical interview headline/summary, state-eligible perception/reliability/AI-aided risk, unanswered questions and hero remain. Render closed-gate-with-existing-data and empty-v2 fixtures and assert advanced text is absent in extracted PDF content.
5. NaN, Infinity and -Infinity are unavailable; never become zero or a normal score. Unavailable and not-applicable are distinct from an actual displayed zero.
6. Resume summary aliases follow the dashboard's existing order: summary, resume_summary, resumeSummary, resume_analysis.summary. No cache fallback.

Landscape A4, embedded trusted local Raleway/fonts and vector logo, searchable text, dashboard palette. Typical complete data uses two pages; long content is allowed more pages. No fixed page height, text slicing, ellipsis, external resources, fabricated questions or weights. Repeated headers carry candidate and interview references; footer has page x of n and a human-review notice. Full name, company, role, state, date, attempt and email are in the first-page hero. Evidence continues without truncation. Candidate-only PDF settings are opt-in. Agreement PDFs keep the default portrait settings; Linux/Render Chromium settings stay unchanged.

## Verification

- Unit tests: zero/one/null/invalid scores, exact canonical sources, no cached report fallback, closed v2 gate, unavailable/text/insufficient/technical cases, verified synthetic signals, HTML escaping and prohibited-trait guard, long text.
- Existing report isolation tests: cross-client/candidate/role/attempt rejection, bound replacement and historical report behavior.
- scripts/verifyCandidateReviewBrief.js: six authored demo reports plus missing, text, insufficient and long fixtures, and a default-options synthetic agreement. No database or credentials.
- Inspect every generated PDF page as PNG; extract searchable text to verify all content and long-text end sentinels; verify landscape media boxes on every candidate page and portrait on every agreement page; no requested remote assets; verify embedded fonts.
- Full backend regression suite, then exact immutable candidate Grok 4.7 review and Codex pass, then manual QA deployment with Live SHA and hosted smoke check. Production remains untouched until Jason tests QA and authorizes promotion.
