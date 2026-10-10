'use strict';

const { resolveEntityFilter } = require('./entityScopeFilter');
const { buildPlatformHealthServices } = require('../health/index');

const DEFAULT_RANGE_DAYS = 30;
const MISSING_REPORT_THRESHOLD_MS = 60 * 60 * 1000;
const RECORDING_THRESHOLD_MS = 60 * 60 * 1000;
const PENDING_APPROVAL_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
const ATTENTION_LIMIT = 50;
const PLATFORM_DATE_RANGES = new Set(['today', '7d', '30d', 'mtd', '6m', 'ytd', '1y']);

function trimText(value) {
  return String(value == null ? '' : value).trim();
}

function lowerText(value) {
  return trimText(value).toLowerCase();
}

function isNonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseDateMs(value) {
  const raw = trimText(value);
  if (!raw) return 0;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseBoundary(value, endOfDay) {
  const raw = trimText(value);
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function metricsError(code, detail, status = 500, hint = null, requestId = null) {
  const error = new Error(detail || code);
  error.code = code;
  error.status = status;
  error.hint = hint;
  error.request_id = requestId;
  return error;
}

function parseMetricsDateRange(query = {}, now = new Date()) {
  const nowMs = now.getTime();
  const rawRange = lowerText(query.date_range || query.timeframe || `${DEFAULT_RANGE_DAYS}d`);
  const dateRange = PLATFORM_DATE_RANGES.has(rawRange) ? rawRange : `${DEFAULT_RANGE_DAYS}d`;
  let defaultFrom = new Date(nowMs - (DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000));
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);

  if (dateRange === 'today') {
    defaultFrom = dayStart;
  } else if (dateRange === '7d') {
    defaultFrom = new Date(nowMs - (7 * 24 * 60 * 60 * 1000));
  } else if (dateRange === 'mtd') {
    defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else if (dateRange === '6m') {
    defaultFrom = new Date(now);
    defaultFrom.setUTCMonth(defaultFrom.getUTCMonth() - 6);
  } else if (dateRange === 'ytd') {
    defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  } else if (dateRange === '1y') {
    defaultFrom = new Date(now);
    defaultFrom.setUTCFullYear(defaultFrom.getUTCFullYear() - 1);
  }

  const from = trimText(query.date_from) ? parseBoundary(query.date_from, false) : defaultFrom;
  const to = trimText(query.date_to) ? parseBoundary(query.date_to, true) : now;
  if (!from || !to || from.getTime() > to.getTime()) {
    throw metricsError(
      'invalid_date_range',
      'date_from and date_to must be valid dates, and date_from must be before date_to.',
      400
    );
  }
  return {
    from,
    to,
    date_range: trimText(query.date_from) || trimText(query.date_to) ? 'custom' : dateRange,
    date_from: from.toISOString(),
    date_to: to.toISOString(),
    date_from_display: isoDateOnly(from),
    date_to_display: isoDateOnly(to),
    default_range_days: DEFAULT_RANGE_DAYS,
  };
}

function safeErrorBody(error, requestId) {
  return {
    error: error?.code || 'admin_metrics_failed',
    code: error?.code || 'admin_metrics_failed',
    detail: error?.message || error?.detail || 'Could not load admin metrics.',
    hint: error?.hint || null,
    request_id: error?.request_id || requestId || null,
  };
}

function isMissingOptionalSchema(error) {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  return (
    text.includes('42p01') ||
    text.includes('42703') ||
    text.includes('pgrst205') ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    text.includes('does not exist') ||
    text.includes('column') && text.includes('not')
  );
}

function applyClientScope(query, clientIds, field = 'client_id') {
  if (!Array.isArray(clientIds)) return query;
  if (clientIds.length === 1) return query.eq(field, clientIds[0]);
  return query.in(field, clientIds);
}

async function readRows({
  db,
  table,
  columns,
  clientIds = null,
  clientField = 'client_id',
  roleId = null,
  dateField = null,
  dateRange = null,
  orderBy = null,
  ascending = false,
  limit = null,
  optional = false,
  warnings,
}) {
  if (Array.isArray(clientIds) && clientIds.length === 0) return [];

  let query = db.from(table).select(columns);
  query = applyClientScope(query, clientIds, clientField);
  if (roleId) query = query.eq('role_id', roleId);
  if (dateField && dateRange) {
    query = query.gte(dateField, dateRange.date_from).lte(dateField, dateRange.date_to);
  }
  if (orderBy) query = query.order(orderBy, { ascending });
  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    if (optional && isMissingOptionalSchema(error)) {
      warnings.push({
        table,
        code: error.code || 'optional_source_unavailable',
        detail: error.message || 'Optional metrics source is unavailable.',
      });
      return [];
    }
    throw metricsError(`${table}_query_failed`, error.message || `Could not query ${table}.`, 500, error.hint || null);
  }
  return toArray(data);
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows || []) {
    const key = lowerText(row?.[field]) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function isChildClient(client) {
  return Boolean(trimText(client?.parent_client_id));
}

function isActiveRole(role) {
  return lowerText(role?.status || 'active') !== 'inactive';
}

function candidateStatusForInterview(candidateById, interview) {
  const candidate = candidateById?.[trimText(interview?.candidate_id)];
  return lowerText(candidate?.interview_status || candidate?.status);
}

function isCompletedInterview(interview, context = {}) {
  const status = lowerText(interview?.status);
  if (status.includes('complete') || status === 'completed' || status === 'analyzed') return true;
  const candidateStatus = candidateStatusForInterview(context.candidateById, interview);
  if (candidateStatus.includes('complete')) return true;
  if (context.reportsByCandidateRole?.has(reportKey(interview?.candidate_id, interview?.role_id))) return true;
  return false;
}

function latestReportAtForInterview(reportCreatedAtByCandidateRole, interview) {
  return reportCreatedAtByCandidateRole?.[reportKey(interview?.candidate_id, interview?.role_id)] || null;
}

function interviewCompletedAt(interview, context = {}) {
  const status = lowerText(interview?.status);
  const candidateStatus = candidateStatusForInterview(context.candidateById, interview);
  const reportAt = latestReportAtForInterview(context.reportCreatedAtByCandidateRole, interview);
  if (reportAt) return reportAt;
  // The current interviews schema has no completed_at column. When a row or its
  // candidate has an explicit completed/analyzed status, updated_at is the safest
  // available completion proxy for delay thresholds.
  if (status.includes('complete') || status === 'completed' || status === 'analyzed' || candidateStatus.includes('complete')) {
    return trimText(interview?.updated_at) || trimText(interview?.created_at) || null;
  }
  return null;
}

function isTranscriptReady(interview) {
  return Boolean(
    trimText(interview?.transcript_url) ||
    trimText(interview?.transcript) ||
    trimText(interview?.interview_summary) ||
    isNonEmptyObject(interview?.transcript_scores) ||
    isNonEmptyObject(interview?.interview_analysis_v2)
  );
}

function recordingStatus(interview) {
  const status = lowerText(interview?.recording_status);
  if (trimText(interview?.recording_deleted_at) || status === 'deleted') return 'deleted';
  if (status === 'ready' || trimText(interview?.recording_ready_at)) return 'ready';
  if (
    status.includes('fail') ||
    status.includes('error') ||
    status.includes('problem') ||
    trimText(interview?.recording_delete_error)
  ) {
    return 'problem';
  }
  if (status || trimText(interview?.video_url)) return 'pending';
  return 'unknown';
}

function reportKey(candidateId, roleId) {
  return `${trimText(candidateId)}::${trimText(roleId)}`;
}

function buildReportCreatedAtByCandidateRole(reports) {
  const byKey = {};
  for (const report of reports || []) {
    const key = reportKey(report?.candidate_id, report?.role_id);
    const createdAt = trimText(report?.created_at);
    if (!key || !createdAt) continue;
    const current = byKey[key];
    if (!current || parseDateMs(createdAt) > parseDateMs(current)) byKey[key] = createdAt;
  }
  return byKey;
}

function normalizeEmailEvent(row) {
  const type = lowerText(row?.event_type || row?.status);
  const status = lowerText(row?.status);
  const isProblem = row?.is_problem === true || row?.is_problem === 'true';
  if (
    isProblem ||
    ['bounce', 'bounced', 'dropped', 'drop', 'deferred', 'failed', 'failure', 'error', 'blocked', 'spamreport'].includes(type) ||
    ['bounce', 'bounced', 'dropped', 'failed', 'failure', 'error', 'problem'].includes(status)
  ) {
    return 'problem';
  }
  if (['open', 'opened', 'click', 'clicked'].includes(type)) return 'engagement';
  if (['processed', 'delivered', 'sent', 'send'].includes(type) || ['delivered', 'sent'].includes(status)) {
    return 'sent_delivered';
  }
  return 'unknown';
}

function sanitizeSummary(value, maxLength = 180) {
  const text = trimText(value)
    .replace(/[^@\s]+@[^@\s]+\.[^@\s]+/g, '***@***')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(token|secret|signature|password|apikey|api_key|key)=\S+/gi, '$1=REDACTED');
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function entityNameFor(clientById, clientId) {
  const client = clientById[trimText(clientId)];
  return client?.name || trimText(clientId) || null;
}

function parentClientNameFor(clientById, clientId) {
  const client = clientById[trimText(clientId)];
  const parentId = trimText(client?.parent_client_id);
  if (parentId && clientById[parentId]) return clientById[parentId].name || parentId;
  return client?.name || trimText(clientId) || null;
}

function roleTitleFor(roleById, roleId) {
  return roleById[trimText(roleId)]?.title || trimText(roleId) || null;
}

function candidateName(candidate) {
  return (
    trimText(candidate?.name) ||
    [candidate?.first_name, candidate?.last_name].map(trimText).filter(Boolean).join(' ') ||
    trimText(candidate?.id) ||
    null
  );
}

function ageLabel(value, now) {
  const then = parseDateMs(value);
  if (!then) return 'unknown';
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function envConfigured(env, keys) {
  return keys.some((key) => trimText(env?.[key]));
}

function envEnabled(env, key) {
  return ['true', '1', 'yes'].includes(lowerText(env?.[key]));
}

function schedulerSendEnabled(env) {
  return envEnabled(env, 'AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED');
}

function schedulerSecretConfigured(env) {
  return envConfigured(env, [
    'AUTOMATION_DIGEST_RUNNER_SECRET',
    'AUTOMATION_DIGEST_CRON_SECRET',
    'CONTRACTS_CRON_SECRET',
  ]);
}

function healthStatusFromProblems({ problem = 0, warning = 0, healthyWhenZero = true, unknownWhenZero = false }) {
  if (problem > 0) return 'problem';
  if (warning > 0) return 'warning';
  if (unknownWhenZero && healthyWhenZero && problem === 0 && warning === 0) return 'unknown';
  return 'healthy';
}

function estimateRecordingMinutes(interviews) {
  let seconds = 0;
  for (const interview of interviews || []) {
    const metadata = interview?.recording_metadata && typeof interview.recording_metadata === 'object'
      ? interview.recording_metadata
      : {};
    const candidates = [
      metadata.duration_seconds,
      metadata.duration_secs,
      metadata.duration,
      metadata.recording_duration_seconds,
      metadata.recording_duration,
      metadata.video_duration_seconds,
      metadata.video_duration,
    ];
    const nested = metadata.recording && typeof metadata.recording === 'object'
      ? [metadata.recording.duration_seconds, metadata.recording.duration]
      : [];
    for (const value of [...candidates, ...nested]) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        seconds += parsed > 1800 && parsed % 1 === 0 ? parsed : parsed;
        break;
      }
    }
  }
  return seconds > 0 ? Math.round(seconds / 60) : null;
}

function metric(label, value) {
  return { label, value };
}

function costUnavailable(note = 'Live vendor cost data is not connected.') {
  return {
    estimated: null,
    currency: 'USD',
    source: 'not_available',
    note,
  };
}

function latestTimestamp(rows, fields) {
  let latest = 0;
  for (const row of rows || []) {
    for (const field of fields || []) {
      latest = Math.max(latest, parseDateMs(row?.[field]));
    }
  }
  return latest ? new Date(latest).toISOString() : null;
}

function problemRate(problem, total) {
  const safeTotal = Number(total || 0);
  if (!safeTotal) return 0;
  return Math.round((Number(problem || 0) / safeTotal) * 1000) / 10;
}

function serviceStatusCounts(services) {
  const summary = {
    healthy_count: 0,
    warning_count: 0,
    problem_count: 0,
    unknown_count: 0,
  };
  for (const service of services || []) {
    const status = lowerText(service?.status);
    if (status === 'healthy') summary.healthy_count += 1;
    else if (status === 'warning') summary.warning_count += 1;
    else if (status === 'problem') summary.problem_count += 1;
    else summary.unknown_count += 1;
  }
  return summary;
}

function overallServiceStatus(counts) {
  if (counts.problem_count > 0) return 'problem';
  if (counts.warning_count > 0) return 'warning';
  if (counts.healthy_count > 0 && counts.unknown_count === 0) return 'healthy';
  if (counts.healthy_count > 0) return 'warning';
  return 'unknown';
}

function statusCard(key, label, serviceOrStatus, detail, source, lastChecked) {
  const service = serviceOrStatus && typeof serviceOrStatus === 'object' ? serviceOrStatus : null;
  return {
    key,
    label,
    status: service?.status || serviceOrStatus || 'unknown',
    detail: detail || service?.health_summary || service?.health_detail || 'No live signal connected.',
    source: source || service?.source_label || service?.source || 'Not connected yet',
    last_checked: lastChecked || service?.last_checked || null,
  };
}

function configuredReadiness(service, liveUsageConnected, eventSource, notes) {
  return {
    service: service.name,
    configured: service.configured,
    live_usage_connected: liveUsageConnected,
    event_source: eventSource,
    notes,
  };
}

function buildPlatformStatusCards({ services, generatedAt }) {
  const serviceByKey = Object.fromEntries(services.map((service) => [service.key, service]));
  return [
    statusCard('backend_api', 'Backend API', 'healthy', 'Current admin metrics request succeeded.', 'Configuration check', generatedAt),
    statusCard('database', 'Database', serviceByKey.supabase, serviceByKey.supabase?.health_summary, 'Configuration check', generatedAt),
    statusCard('openai', 'OpenAI', serviceByKey.openai, serviceByKey.openai?.health_summary),
    statusCard('tavus', 'Tavus', serviceByKey.tavus, serviceByKey.tavus?.health_summary),
    statusCard('sendgrid', 'SendGrid', serviceByKey.sendgrid, serviceByKey.sendgrid?.health_summary),
    statusCard('storage', 'Storage', serviceByKey.aws_s3, serviceByKey.aws_s3?.health_summary),
    statusCard('error_monitoring', 'Error Monitoring', serviceByKey.sentry, serviceByKey.sentry?.health_summary),
    statusCard('billing_stripe', 'Billing / Stripe', serviceByKey.stripe, serviceByKey.stripe?.health_summary),
  ];
}

function buildSourceSummary(rowsByName, warnings, scopeNotes) {
  return {
    row_counts: Object.fromEntries(Object.entries(rowsByName).map(([key, rows]) => [key, rows.length])),
    warnings,
    scope_notes: scopeNotes,
  };
}

async function buildAdminMetricsPayload({
  db,
  req = {},
  query = {},
  requestId = null,
  now = new Date(),
  env = process.env,
  fetchImpl = null,
  liveChecksEnabled = undefined,
  cacheEnabled = true,
  stripeClientFactory = null,
  awsS3ClientFactory = null,
} = {}) {
  const warnings = [];
  const dateRange = parseMetricsDateRange(query, now);
  const scopeNotes = [
    'Metrics are platform-wide. Client, entity, and role filters are intentionally ignored on this page.',
    'Interview completion uses interviews.status, candidate completed status, or matching report rows; interviews.completed_at is not present in the current schema.',
    'alphaScreen-record estimates are operational proxies and are not vendor invoices.',
    'Live vendor API checks are attempted where the current environment has the required configuration.',
    'SendGrid events are platform-wide because email_delivery_events does not store client_id.',
    'Sensitive credential values and raw vendor payloads are never returned.',
  ];

  const [
    clients,
    clientsBilling,
    roles,
    candidates,
    interviews,
    reports,
    perceptionEvents,
    emailEvents,
    cancellationRuns,
  ] = await Promise.all([
    readRows({ db, table: 'clients', columns: 'id,name,parent_client_id,entity_label,archived_at', orderBy: 'name', ascending: true, warnings }),
    readRows({ db, table: 'clients', columns: 'id,billing_status,stripe_customer_id,stripe_subscription_id,subscription_status,created_at', orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'roles', columns: 'id,title,client_id,status,created_at', orderBy: 'created_at', warnings }),
    readRows({ db, table: 'candidates', columns: 'id,client_id,role_id,status,interview_status,created_at', dateField: 'created_at', dateRange, orderBy: 'created_at', warnings }),
    readRows({ db, table: 'interviews', columns: 'id,client_id,role_id,candidate_id,created_at,updated_at,status,video_url,transcript_url,transcript,transcript_scores,interview_summary,interview_analysis_v2,perception_scores,recording_status,recording_ready_at,recording_metadata,recording_deleted_at,recording_delete_reason,recording_delete_error', dateField: 'created_at', dateRange, orderBy: 'created_at', warnings }),
    readRows({ db, table: 'reports', columns: 'id,client_id,role_id,candidate_id,created_at', dateField: 'created_at', dateRange, orderBy: 'created_at', warnings }),
    readRows({ db, table: 'interview_perception_events', columns: 'id,client_id,interview_id,event_type,received_at', dateField: 'received_at', dateRange, orderBy: 'received_at', optional: true, warnings }),
    readRows({ db, table: 'email_delivery_events', columns: 'id,created_at,event_at,event_type,email_category,category,status,is_problem,reason', dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'contract_cancellation_runs', columns: 'id,status,error,started_at,completed_at,created_at', dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
  ]);

  const { services, readiness } = await buildPlatformHealthServices({
    now,
    env,
    db,
    dateRange,
    fetchImpl,
    liveChecksEnabled,
    cacheEnabled,
    stripeClientFactory,
    awsS3ClientFactory,
    clients,
    clientsBilling,
    roles,
    candidates,
    interviews,
    reports,
    perceptionEvents,
    emailEvents,
    cancellationRuns,
    warnings,
  });
  const generatedAt = now.toISOString();
  const summaryCounts = serviceStatusCounts(services);
  const summary = {
    overall_status: overallServiceStatus(summaryCounts),
    ...summaryCounts,
    last_checked: generatedAt,
  };
  const statusCards = buildPlatformStatusCards({ services, generatedAt });

  return {
    ok: true,
    request_id: requestId || null,
    generated_at: generatedAt,
    filters: {
      date_range: dateRange.date_range,
      date_from: dateRange.date_from,
      date_to: dateRange.date_to,
      date_from_display: dateRange.date_from_display,
      date_to_display: dateRange.date_to_display,
      default_range_days: DEFAULT_RANGE_DAYS,
    },
    summary,
    status_cards: statusCards,
    services,
    integration_readiness: readiness,
    source_notes: scopeNotes,
    sources: {
      row_counts: {
        clients: clients.length,
        roles: roles.length,
        candidates: candidates.length,
        interviews: interviews.length,
        reports: reports.length,
        interview_perception_events: perceptionEvents.length,
        email_delivery_events: emailEvents.length,
        contract_cancellation_runs: cancellationRuns.length,
      },
      warnings,
    },
    source_counts: buildSourceSummary({
      clients,
      roles,
      candidates,
      interviews,
      reports,
      interview_perception_events: perceptionEvents,
      email_delivery_events: emailEvents,
      contract_cancellation_runs: cancellationRuns,
    }, warnings, scopeNotes),
  };
}

module.exports = {
  DEFAULT_RANGE_DAYS,
  parseMetricsDateRange,
  normalizeEmailEvent,
  buildAdminMetricsPayload,
  safeErrorBody,
};
