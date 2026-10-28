begin;

-- Activation is a separate migration AFTER reviewed code is live; old code
-- must never receive a v3 attempt during rollout. Historical attempts stay NULL.
alter table public.interviews add column if not exists interview_quality_version text;
alter table public.interviews add column if not exists scoring_summary jsonb;

create table if not exists private.interview_scoring_history (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(id) on delete cascade,
  scoring_version text not null,
  transcript_hash text not null check (transcript_hash ~ '^[a-f0-9]{64}$'),
  previous_scores jsonb,
  previous_summary text,
  previous_scoring_summary jsonb,
  previous_questions text[],
  previous_analysis_v2 jsonb,
  scores jsonb not null,
  summary text not null,
  scoring_summary jsonb,
  details jsonb,
  applied_at timestamptz not null default now(),
  unique(interview_id, transcript_hash, scoring_version)
);
alter table private.interview_scoring_history enable row level security;
alter table private.interview_scoring_history force row level security;
revoke all on private.interview_scoring_history from public, anon, authenticated;
grant select on private.interview_scoring_history to service_role;

create or replace function private.is_valid_interview_quality_result(p_scores jsonb, p_summary jsonb, p_details jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_key text; v_quality numeric := 0; v_value numeric; v_question jsonb;
 v_sum numeric := 0; v_count integer := 0; v_unscored integer := 0;
begin
  if private.is_valid_interview_transcript_scores(p_scores) is not true then return false; end if;
  if p_scores->'overall' = 'null'::jsonb then return p_summary is null and p_details is null; end if;
  if p_summary is null or p_details is null or jsonb_typeof(p_summary) <> 'object'
     or p_summary->>'version' is distinct from 'role_quality_v3'
     or p_details->>'version' is distinct from 'role_quality_v3'
     or p_summary->'weights' is distinct from '{"role_answers":80,"answer_quality":20}'::jsonb
     or octet_length(p_summary::text) > 4000 or octet_length(p_details::text) > 131072
     or jsonb_typeof(p_details->'question_evaluations') is distinct from 'array'
     or jsonb_array_length(p_details->'question_evaluations') not between 1 and 25
     or jsonb_typeof(p_details->'rubric') is distinct from 'object'
     or jsonb_typeof(p_details->'model') is distinct from 'string'
     or coalesce(char_length(p_details->>'model'),0) not between 1 and 120 then return false; end if;
  if exists(select 1 from jsonb_object_keys(p_summary) k where k not in
     ('version','role_answers','answer_quality','overall','weights','answer_quality_scores','scorable_questions','unscored_questions')) then return false; end if;
  foreach v_key in array array['role_answers','answer_quality','overall','scorable_questions','unscored_questions'] loop
    if jsonb_typeof(p_summary->v_key) is distinct from 'number' then return false; end if;
    v_value := (p_summary->>v_key)::numeric;
    if v_value < 0 or v_value > 100 then return false; end if;
    if v_key in ('overall','scorable_questions','unscored_questions') and v_value <> trunc(v_value) then return false; end if;
  end loop;
  if (p_summary->>'scorable_questions')::integer < 1 then return false; end if;
  if jsonb_typeof(p_summary->'answer_quality_scores') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_summary->'answer_quality_scores')) <> 4 then return false; end if;
  foreach v_key in array array['response_specificity','answer_directness','answer_consistency','communication_structure'] loop
    if jsonb_typeof(p_summary->'answer_quality_scores'->v_key) is distinct from 'number' then return false; end if;
    v_value := (p_summary->'answer_quality_scores'->>v_key)::numeric;
    if v_value <> trunc(v_value) or v_value < 0 or v_value > 100 then return false; end if;
    v_quality := v_quality + v_value;
  end loop;
  for v_question in select value from jsonb_array_elements(p_details->'question_evaluations') loop
    if v_question->'scorable' = 'true'::jsonb then
      if jsonb_typeof(v_question->'score') is distinct from 'number' then return false; end if;
      v_value := (v_question->>'score')::numeric;
      if v_value < 0 or v_value > 100 or v_value <> trunc(v_value) then return false; end if;
      v_count := v_count+1; v_sum := v_sum+v_value;
    elsif v_question->'scorable' = 'false'::jsonb and v_question->'score'='null'::jsonb
      and v_question->>'missing_reason' in ('interviewer_process','not_asked','technical_issue') then v_unscored := v_unscored+1;
    else return false; end if;
  end loop;
  return v_count > 0
     and abs((p_summary->>'role_answers')::numeric - v_sum/v_count) < 0.00000001
     and (p_summary->>'answer_quality')::numeric = v_quality/4
     and (p_summary->>'overall')::numeric = round((v_sum*80*4+v_quality*20*v_count)/(100*v_count*4))
     and p_scores->'overall' = p_summary->'overall'
     and p_scores->'role_fit' = p_scores->'overall'
     and p_scores->'technical_strength' = p_scores->'overall'
     and p_scores->'communication_quality' = p_scores->'overall'
     and (p_summary->>'scorable_questions')::integer=v_count
     and (p_summary->>'unscored_questions')::integer=v_unscored
     and p_details->'answer_quality_scores'=p_summary->'answer_quality_scores'
     and p_details->'weights'=p_summary->'weights';
exception when others then return false;
end $$;

create or replace function private.record_interview_quality_history(
  p_previous public.interviews, p_hash text, p_scores jsonb, p_summary text, p_public_summary jsonb, p_details jsonb
) returns void language plpgsql set search_path = '' as $$
begin
  if private.is_valid_interview_quality_result(p_scores,p_public_summary,p_details) is not true
     or p_summary is null or char_length(btrim(p_summary)) not between 1 and 4000 then
    raise exception 'invalid_interview_quality_result';
  end if;
  insert into private.interview_scoring_history(interview_id,scoring_version,transcript_hash,
    previous_scores,previous_summary,previous_scoring_summary,previous_questions,previous_analysis_v2,scores,summary,scoring_summary,details)
  values (p_previous.id,'role_quality_v3',p_hash,p_previous.transcript_scores,p_previous.interview_summary,
    p_previous.scoring_summary,p_previous.unanswered_candidate_questions,p_previous.interview_analysis_v2,p_scores,p_summary,p_public_summary,p_details);
end $$;

-- Explicit recalibration/CAS path. No attempt state, lifecycle, payment or
-- completion stamp is changed. The service-only caller must preview targets.
create or replace function public.apply_interview_quality_score(
 p_interview_id uuid, p_expected_updated_at timestamptz, p_expected_transcript_hash text,
 p_scores jsonb, p_summary text, p_scoring_summary jsonb, p_details jsonb, p_questions jsonb, p_analysis_v2 jsonb default null
) returns table(outcome text) language plpgsql security definer set search_path = '' as $$
declare v_previous public.interviews%rowtype; v_questions text[];
begin
 select i.* into v_previous from public.interviews i where i.id=p_interview_id for update;
 if not found then return query select 'not_found'::text; return; end if;
 if p_expected_transcript_hash !~ '^[a-f0-9]{64}$'
    or encode(pg_catalog.sha256(convert_to(coalesce(v_previous.transcript,''),'UTF8')),'hex') is distinct from p_expected_transcript_hash then
   return query select 'superseded'::text; return;
 end if;
 if exists(select 1 from private.interview_scoring_history h where h.interview_id=p_interview_id
   and h.transcript_hash=p_expected_transcript_hash and h.scoring_version='role_quality_v3') then
   if v_previous.transcript_scores is not distinct from p_scores and v_previous.scoring_summary is not distinct from p_scoring_summary then
     return query select 'already_applied'::text; return;
   end if;
   raise exception 'quality_result_already_recorded';
 end if;
 if v_previous.updated_at is distinct from p_expected_updated_at then return query select 'superseded'::text; return; end if;
 if p_questions is null or (private.is_valid_interview_unanswered_questions(p_questions) is not true and p_questions is distinct from '[]'::jsonb) then
   raise exception 'invalid_quality_questions';
 end if;
 if p_analysis_v2 is not null and private.is_valid_interview_analysis_v2(p_analysis_v2) is not true then raise exception 'invalid_quality_analysis'; end if;
 select coalesce(array_agg(value #>> '{}' order by ordinality),array[]::text[]) into v_questions
 from jsonb_array_elements(p_questions) with ordinality as q(value,ordinality);
 perform private.record_interview_quality_history(v_previous,p_expected_transcript_hash,p_scores,p_summary,p_scoring_summary,p_details);
 update public.interviews set transcript_scores=p_scores,interview_summary=p_summary,scoring_summary=p_scoring_summary,
   unanswered_candidate_questions=v_questions,interview_quality_version='role_quality_v3',interview_analysis_v2=p_analysis_v2,updated_at=now() where id=p_interview_id;
 return query select 'applied'::text;
end $$;

-- Keep existing claim/hash/lease/binding locks and validation authoritative.
-- Score metadata, audit history and candidate questions commit with that RPC.
create or replace function public.finalize_interview_quality_transcript(
 p_interview_id uuid,p_provider_conversation_id text,p_claim_token uuid,p_claim_version bigint,
 p_provider_event_key text,p_transcript_hash text,p_transcript_storage_ref text,p_normalized_transcript text,
 p_evidence_snapshot jsonb,p_transcript_scores jsonb,p_interview_summary text,
 p_scoring_summary jsonb,p_details jsonb,p_questions jsonb
) returns table(outcome text,authoritative_snapshot_source text,canonical_repair_applied boolean,
 status_before text,status_after text,progress_before text,progress_after text)
language plpgsql security definer set search_path = '' as $$
declare v_previous public.interviews%rowtype; v_result record; v_questions text[];
begin
 -- Match existing finalizer lock order: claim first, then interview.
 perform 1 from private.interview_final_transcript_reconciliation_claims where interview_id=p_interview_id for update;
 select i.* into v_previous from public.interviews i where i.id=p_interview_id for update;
 if not found or v_previous.interview_quality_version is distinct from 'role_quality_v3' then raise exception 'quality_attempt_version_mismatch'; end if;
 if private.is_valid_interview_quality_result(p_transcript_scores,p_scoring_summary,p_details) is not true
    or p_questions is null or (private.is_valid_interview_unanswered_questions(p_questions) is not true and p_questions is distinct from '[]'::jsonb) then
   raise exception 'invalid_interview_quality_result';
 end if;
 select * into v_result from public.finalize_interview_final_transcript_reconciliation(
   p_interview_id,p_provider_conversation_id,p_claim_token,p_claim_version,p_provider_event_key,p_transcript_hash,
   p_transcript_storage_ref,p_normalized_transcript,p_evidence_snapshot,p_transcript_scores,p_interview_summary);
 if v_result.outcome='finalized' then
   perform private.record_interview_quality_history(v_previous,p_transcript_hash,p_transcript_scores,p_interview_summary,p_scoring_summary,p_details);
   select coalesce(array_agg(value #>> '{}' order by ordinality),array[]::text[]) into v_questions
     from jsonb_array_elements(p_questions) with ordinality as q(value,ordinality);
   update public.interviews set scoring_summary=p_scoring_summary,unanswered_candidate_questions=v_questions where id=p_interview_id;
 end if;
 return query select v_result.outcome,v_result.authoritative_snapshot_source,v_result.canonical_repair_applied,
   v_result.status_before,v_result.status_after,v_result.progress_before,v_result.progress_after;
end $$;

revoke all on function private.is_valid_interview_quality_result(jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function private.record_interview_quality_history(public.interviews,text,jsonb,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.apply_interview_quality_score(uuid,timestamptz,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_interview_quality_transcript(uuid,text,uuid,bigint,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_interview_quality_score(uuid,timestamptz,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.finalize_interview_quality_transcript(uuid,text,uuid,bigint,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb,jsonb) to service_role;
-- Extend only the accepted analysis version, keeping its strict seven-key shape.
create or replace function private.is_valid_interview_analysis_v2(
  p_analysis jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_has_numeric_score boolean := false;
begin
  if p_analysis is null
    or jsonb_typeof(p_analysis) <> 'object'
    or octet_length(p_analysis::text) > 32768
    or (select count(*) from pg_catalog.jsonb_object_keys(p_analysis)) <> 7
    or not (p_analysis ?& array[
      'version',
      'scores',
      'conditions',
      'risk',
      'evidence_summary',
      'evidence',
      'limitations'
    ])
    or p_analysis ->> 'version' not in ('path_a_v1','path_a_v1_role_quality_v3')
    or jsonb_typeof(p_analysis -> 'scores') <> 'object'
    or jsonb_typeof(p_analysis -> 'conditions') <> 'object'
    or jsonb_typeof(p_analysis -> 'risk') <> 'object'
    or jsonb_typeof(p_analysis -> 'evidence_summary') <> 'string'
    or jsonb_typeof(p_analysis -> 'evidence') <> 'array'
    or jsonb_typeof(p_analysis -> 'limitations') <> 'array'
    or char_length(p_analysis ->> 'evidence_summary') > 1200 then
    return false;
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(p_analysis -> 'scores')) <> 4
    or not ((p_analysis -> 'scores') ?& array[
      'response_specificity',
      'answer_directness',
      'answer_consistency',
      'communication_structure'
    ]) then
    return false;
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_analysis -> 'scores')
  loop
    if jsonb_typeof(v_value) = 'number' then
      if (v_value #>> '{}')::numeric < 0
        or (v_value #>> '{}')::numeric > 100 then
        return false;
      end if;
      v_has_numeric_score := true;
    elsif jsonb_typeof(v_value) <> 'null' then
      return false;
    end if;
  end loop;

  if (select count(*) from pg_catalog.jsonb_object_keys(p_analysis -> 'conditions')) <> 4
    or not ((p_analysis -> 'conditions') ?& array[
      'evaluation_conditions',
      'audio_quality_issues',
      'distraction_risk',
      'signal_confidence'
    ])
    or jsonb_typeof(p_analysis -> 'conditions' -> 'evaluation_conditions') <> 'string'
    or jsonb_typeof(p_analysis -> 'conditions' -> 'audio_quality_issues') <> 'string'
    or jsonb_typeof(p_analysis -> 'conditions' -> 'distraction_risk') <> 'string'
    or jsonb_typeof(p_analysis -> 'conditions' -> 'signal_confidence') <> 'string'
    or p_analysis -> 'conditions' ->> 'evaluation_conditions'
      not in ('good', 'mixed', 'limited', 'unavailable')
    or p_analysis -> 'conditions' ->> 'audio_quality_issues'
      not in ('none', 'low', 'medium', 'high', 'unavailable')
    or p_analysis -> 'conditions' ->> 'distraction_risk'
      not in ('low', 'medium', 'high', 'unavailable')
    or p_analysis -> 'conditions' ->> 'signal_confidence'
      not in ('low', 'medium', 'high', 'unavailable') then
    return false;
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(p_analysis -> 'risk')) <> 2
    or not ((p_analysis -> 'risk') ?& array['integrity_risk', 'reason'])
    or jsonb_typeof(p_analysis -> 'risk' -> 'integrity_risk') <> 'string'
    or p_analysis -> 'risk' ->> 'integrity_risk'
      not in ('low', 'medium', 'high', 'unavailable')
    or jsonb_typeof(p_analysis -> 'risk' -> 'reason') <> 'string'
    or char_length(p_analysis -> 'risk' ->> 'reason') > 700 then
    return false;
  end if;

  if jsonb_array_length(p_analysis -> 'evidence') > 12
    or jsonb_array_length(p_analysis -> 'limitations') > 8 then
    return false;
  end if;
  for v_value in select value from jsonb_array_elements(p_analysis -> 'evidence')
  loop
    if jsonb_typeof(v_value) <> 'string'
      or char_length(v_value #>> '{}') not between 1 and 260 then
      return false;
    end if;
  end loop;
  for v_value in select value from jsonb_array_elements(p_analysis -> 'limitations')
  loop
    if jsonb_typeof(v_value) <> 'string'
      or char_length(v_value #>> '{}') not between 1 and 260 then
      return false;
    end if;
  end loop;

  if v_has_numeric_score
    and (
      btrim(p_analysis ->> 'evidence_summary') = ''
      or jsonb_array_length(p_analysis -> 'evidence') = 0
    ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end
$$;

-- A queued legacy postprocessor must not refill an already-captured v3 list.
create or replace function public.persist_interview_unanswered_questions_if_authoritative(
  p_interview_id uuid,
  p_expected_claim_version bigint,
  p_expected_transcript_hash text,
  p_questions jsonb
)
returns table (
  outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.interview_final_transcript_reconciliation_claims%rowtype;
  v_interview public.interviews%rowtype;
  v_questions text[];
begin
  if p_interview_id is null
    or p_expected_claim_version is null
    or p_expected_claim_version < 0
    or p_expected_transcript_hash is null
    or p_expected_transcript_hash !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = 'P0001',
      message = 'final_transcript_question_persistence_input_invalid';
  end if;

  if not private.is_valid_interview_unanswered_questions(p_questions) then
    return query select 'invalid_questions'::text;
    return;
  end if;

  select pg_catalog.array_agg(
    question.value #>> '{}'
    order by question.ordinality
  )
  into v_questions
  from pg_catalog.jsonb_array_elements(p_questions)
    with ordinality as question(value, ordinality);

  if exists (select 1 from public.interviews i where i.id=p_interview_id and i.interview_quality_version='role_quality_v3') then
    return query select 'already_present'::text; return;
  end if;

  select c.* into v_claim
  from private.interview_final_transcript_reconciliation_claims c
  where c.interview_id = p_interview_id
  for update;
  if not found then
    if exists (
      select 1
      from public.interviews i
      where i.id = p_interview_id
    ) then
      return query select 'superseded'::text;
    else
      return query select 'interview_not_found'::text;
    end if;
    return;
  end if;

  if v_claim.processing_state <> 'completed'
    or v_claim.claim_version <> p_expected_claim_version
    or v_claim.authoritative_transcript_hash is distinct from p_expected_transcript_hash then
    return query select 'superseded'::text;
    return;
  end if;

  select i.* into v_interview
  from public.interviews i
  where i.id = p_interview_id
  for update;
  if not found then
    return query select 'interview_not_found'::text;
    return;
  end if;

  if v_interview.interview_quality_version='role_quality_v3' or pg_catalog.cardinality(v_interview.unanswered_candidate_questions) > 0 then
    return query select 'already_present'::text;
    return;
  end if;

  update public.interviews i
  set unanswered_candidate_questions = v_questions
  where i.id = p_interview_id;

  return query select 'stored'::text;
end
$$;

-- Accommodation completion reuses the existing insert path and the same scorer.
-- The initial score and its private audit commit together, before credit stamping.
create or replace function public.insert_interview_quality_text(
 p_candidate_id uuid,p_role_id uuid,p_client_id uuid,p_rubric jsonb,p_transcript text,
 p_scores jsonb,p_summary text,p_scoring_summary jsonb,p_details jsonb,p_questions jsonb,
 p_perception jsonb,p_analysis jsonb
) returns table(id uuid) language plpgsql security definer set search_path = '' as $$
declare v_row public.interviews%rowtype; v_questions text[];
begin
 if private.is_valid_interview_quality_result(p_scores,p_scoring_summary,p_details) is not true
    or p_questions is null or (p_questions<>'[]'::jsonb and private.is_valid_interview_unanswered_questions(p_questions) is not true)
    or p_transcript is null or char_length(p_transcript)=0 then raise exception 'invalid_text_quality_result'; end if;
 select coalesce(array_agg(value #>> '{}' order by ordinality),array[]::text[]) into v_questions
   from jsonb_array_elements(p_questions) with ordinality as q(value,ordinality);
 insert into public.interviews(candidate_id,role_id,client_id,rubric,transcript,transcript_scores,interview_summary,
   perception_scores,unanswered_candidate_questions,analysis,status,interview_quality_version,scoring_summary)
 values(p_candidate_id,p_role_id,p_client_id,p_rubric,p_transcript,p_scores,p_summary,
   p_perception,v_questions,p_analysis,'completed','role_quality_v3',p_scoring_summary) returning * into v_row;
 v_row.transcript_scores:=null; v_row.interview_summary:=null; v_row.scoring_summary:=null;
 v_row.unanswered_candidate_questions:=null; v_row.interview_analysis_v2:=null;
 perform private.record_interview_quality_history(v_row,encode(pg_catalog.sha256(convert_to(p_transcript,'UTF8')),'hex'),
   p_scores,p_summary,p_scoring_summary,p_details);
 return query select v_row.id;
end $$;
revoke all on function public.insert_interview_quality_text(uuid,uuid,uuid,jsonb,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.insert_interview_quality_text(uuid,uuid,uuid,jsonb,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

commit;
