'use strict';

const MAX_UNANSWERED_QUESTIONS = 10;
const CANDIDATE_ROLES = new Set(['candidate', 'user']);
const REPLICA_ROLES = new Set(['agent', 'assistant', 'interviewer', 'replica']);
const NON_FINAL_REPLICA_STATES = new Set([
  'in_progress',
  'incomplete',
  'interrupted',
  'partial',
  'streaming',
]);

const MARKER_RE_SOURCE = '\\[\\[UNANSWERED_QUESTION:\\s*([^\\]]+?)\\s*\\]\\]';
const INTERROGATIVE_RE =
  /^(who|what|when|where|why|how|can|could|would|do|does|is|are|should)\b/i;
const CLOSING_QUESTION_RE =
  /\b(do you have|any|any other)\b.{0,40}\bquestions?\b|\bquestions?\b.{0,40}\bbefore we wrap up\b/i;

function markerRegex(flags = 'g') {
  return new RegExp(MARKER_RE_SOURCE, flags);
}

function extractMarkers(text) {
  const markers = [];
  const regex = markerRegex();
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const question = String(match[1] || '').trim();
    if (question) markers.push(question);
  }
  return markers;
}

function stripMarkers(text) {
  return String(text || '').replace(markerRegex(), '').trim();
}

function candidateQuestionText(text) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return '';
  const words = cleanedText.split(/\s+/).filter(Boolean);
  const sentenceMarks = cleanedText.match(/[.!?]+(?=\s|$)/g) || [];
  if (words.length > 35 || sentenceMarks.length > 2) return '';
  const lead = cleanedText
    .replace(/^(?:um+|uh+|so|and|also|just|yeah|yes|no|ok(?:ay)?|hey|hi)[,\s]+/i, '')
    .trim();
  return cleanedText.includes('?') || INTERROGATIVE_RE.test(lead)
    ? cleanedText
    : '';
}

function normalizeRole(value) {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (CANDIDATE_ROLES.has(role)) return 'candidate';
  if (REPLICA_ROLES.has(role)) return 'replica';
  return 'other';
}

function textContent(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  for (const field of ['content', 'text', 'message', 'value']) {
    if (typeof item[field] === 'string') return item[field];
  }
  return '';
}

function normalizeArrayTurns(items) {
  return items.map((item) => ({
    role: normalizeRole(item?.role),
    text: textContent(item),
    source: item && typeof item === 'object' && !Array.isArray(item)
      ? item
      : null,
  }));
}

function normalizeTextTurns(transcriptText) {
  return String(transcriptText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const upper = line.toUpperCase();
      if (upper.startsWith('CANDIDATE:')) {
        return {
          role: 'candidate',
          text: line.slice('CANDIDATE:'.length).trim(),
          source: null,
        };
      }
      if (upper.startsWith('INTERVIEWER:')) {
        return {
          role: 'replica',
          text: line.slice('INTERVIEWER:'.length).trim(),
          source: null,
        };
      }
      return { role: 'other', text: line, source: null };
    });
}

function hasExplicitNonFinalState(source) {
  if (!source) return false;
  for (const field of ['is_final', 'isFinal', 'final', 'completed', 'is_complete']) {
    if (source[field] === false) return true;
  }
  const state = typeof source.status === 'string'
    ? source.status.trim().toLowerCase()
    : '';
  return NON_FINAL_REPLICA_STATES.has(state);
}

function isQualifyingReplicaResponse(turn, visibleText) {
  return turn.role === 'replica' &&
    visibleText.length > 0 &&
    !hasExplicitNonFinalState(turn.source);
}

function extractCandidateQuestionsLegacy(input) {
  if (typeof input !== 'string' && !Array.isArray(input)) return [];

  const turns = Array.isArray(input)
    ? normalizeArrayTurns(input)
    : normalizeTextTurns(input);
  const candidates = [];
  let closingQuestionAsked = false;

  const addCandidate = (text) => {
    const question = String(text || '').trim();
    if (!question || candidates.some((candidate) => candidate.text === question)) return;
    candidates.push({ text: question, answered: false });
  };

  for (const turn of turns) {
    const markers = extractMarkers(turn.text);
    const visibleText = stripMarkers(turn.text);

    if (turn.role === 'replica') {
      if (isQualifyingReplicaResponse(turn, visibleText)) {
        for (const candidate of candidates) candidate.answered = true;
      }
      if (CLOSING_QUESTION_RE.test(visibleText)) closingQuestionAsked = true;
      if (!visibleText && markers.length) {
        for (const marker of markers) addCandidate(marker);
      }
      continue;
    }

    if (turn.role === 'candidate') {
      for (const marker of markers) addCandidate(marker);
      const question = candidateQuestionText(visibleText);
      if (closingQuestionAsked && question) addCandidate(question);
      continue;
    }

    // A marker without usable role evidence is retained rather than falsely
    // treating unknown metadata as a replica answer.
    for (const marker of markers) addCandidate(marker);
  }

  return candidates
    .filter((candidate) => !candidate.answered)
    .map((candidate) => candidate.text)
    .slice(0, MAX_UNANSWERED_QUESTIONS);
}

// Keep old attempts on their original policy. New attempts retain a deferred
// employer question: a refusal or farewell is not an answer to that question.
const NON_ANSWER_RE = /\b(?:i (?:do not|don't|cannot|can't|am unable to) (?:have|know|answer|confirm|provide|share)|hiring team can answer|outside the interview|hiring manager can answer|(?:pass|refer|forward|note|record).{0,45}(?:hiring|manager|team)|thank you for your time|ending the session|let['’]s (?:continue|move on))\b/i;
const INTERNAL_QUESTION_RE = /\b(?:rubric|scoring (?:criteria|weights|rules)|evaluation (?:criteria|dimensions)|internal (?:instructions|evaluation)|hidden (?:rules|instructions)|(?:sample|model|ideal|good|strong) answers?|how (?:am i|are you|will i be) (?:scor|evaluat))\b/i;
const REPEAT_REQUEST_RE = /\b(?:repeat (?:the |that |your )?question|say (?:that|it) again|repeat that|clarify (?:the |your )?question)\b/i;
const QUESTION_STOP_WORDS = new Set(('a an the this that these those i me my you your we our it is are was were do does did can could would should will may please tell share give explain detail details more about of in on for to and or with synthetic role question questions').split(' '));

function newCandidateQuestionText(text) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value || INTERNAL_QUESTION_RE.test(value) || REPEAT_REQUEST_RE.test(value)) return '';
  let lead = value;
  for (let n = 0; n < 8; n += 1) {
    const next = lead.replace(/^(?:um+|uh+|so|and|also|just|yeah|yes|no|ok(?:ay)?|hey|hi)[,.!\s]+/i, '').trim();
    if (next === lead) break;
    lead = next;
  }
  if (/^(?:i (?:do not|don't|have no)|none(?: at the moment)?|nothing else|no (?:more |other )?questions?|not (?:right )?now)\b/i.test(lead) && !/\?/.test(lead)) return '';
  if (/\b(?:i asked|a (?:customer|client) asked|my (?:customer|client|manager) asked|i wondered|i had to ask)\b/i.test(lead) && !/\b(?:i(?:'d| would) like to know|i (?:want|wanted) to know)\b/i.test(lead)) return '';
  if (!INTERROGATIVE_RE.test(lead) && !value.includes('?') && !/\b(?:i(?:'d| would) like (?:to know|to ask)|i (?:kind of )?(?:just )?want(?:ed)? to know|i(?:'m| am) (?:also )?curious (?:about|if|whether))\b/i.test(lead)) return '';
  // Provider payloads are bounded; retain a visible truncation rather than
  // silently discarding a valid long employer question.
  const chars = [...value];
  if (chars.length > 1000) value = chars.slice(0, 986).join('') + '… [truncated]';
  return value;
}

function topicTokens(text) {
  return new Set((String(text).toLowerCase().match(/[a-z]{3,}/g) || []).filter(word => !QUESTION_STOP_WORDS.has(word)));
}

function resolvesQuestion(question, response) {
  if (NON_ANSWER_RE.test(response) || /^(?:thanks?|thank you|got it|understood|okay|all right)[.!\s]*$/i.test(response)) return false;
  if (/\bwhat are you doing\b/i.test(question) && /\bconducting (?:the |a )?structured interview\b/i.test(response)) return true;
  const topics = topicTokens(question), reply = topicTokens(response);
  const shared = [...topics].filter(word => reply.has(word));
  // Conservatively keep ambiguous questions. A shared generic term is not
  // enough to infer an answer; explicit yes/no facts can resolve their topic.
  return shared.length >= 2 || (shared.some(word => ['remote', 'office', 'salary', 'compensation'].includes(word)) && /\b(?:yes|no|is|are|pays?|paid|range|work)\b/i.test(response));
}

function extractCandidateQuestions(input) {
  if (typeof input !== 'string' && !Array.isArray(input)) return [];
  const turns = Array.isArray(input) ? normalizeArrayTurns(input) : normalizeTextTurns(input);
  const pending = [];
  let closing = false;
  const add = value => {
    const question = newCandidateQuestionText(value);
    if (question && !pending.some(item => item.text.toLowerCase() === question.toLowerCase())) pending.push({ text: question, answered: false });
  };
  for (const turn of turns) {
    const visible = stripMarkers(turn.text);
    if (turn.role === 'replica') {
      if (isQualifyingReplicaResponse(turn, visible)) {
        const unresolved = pending.filter(item => !item.answered);
        // Do not let one response clear several unrelated pending questions.
        const matches = unresolved.filter(item => resolvesQuestion(item.text, visible));
        if (matches.length === 1) matches[0].answered = true;
      }
      if (CLOSING_QUESTION_RE.test(visible)) closing = true;
      if (!visible) extractMarkers(turn.text).forEach(add);
    } else if (turn.role === 'candidate') {
      extractMarkers(turn.text).forEach(add);
      if (closing) add(visible);
    } else {
      extractMarkers(turn.text).forEach(add);
    }
  }
  return pending.filter(item => !item.answered).map(item => item.text).slice(0, MAX_UNANSWERED_QUESTIONS);
}

module.exports = {
  extractCandidateQuestions,
  extractCandidateQuestionsLegacy,
  extractCandidateQuestionsForInterview: (interview, input) => interview?.interview_quality_version === 'role_quality_v3'
    ? extractCandidateQuestions(input) : extractCandidateQuestionsLegacy(input),
};
