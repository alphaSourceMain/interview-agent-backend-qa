-- Additive, service-only public lead submission and one-attempt notification.
-- No backfill, scheduler, automatic retry, or recipient-controlled destination.
begin;

create table public.public_lead_notifications (
  lead_id uuid primary key references public.public_lead_drafts(id),
  attempt_id uuid not null unique default gen_random_uuid(),
  environment text not null check (environment in ('dev','qa','production')),
  recipient text not null check (recipient in ('info@alphasourceai.com','sales@alphasourceai.com','development@alphasourceai.com')),
  form_id text not null,
  status text not null default 'sending' check (status in ('sending','accepted','rejected','unknown')),
  attempted_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  provider_reference text,
  error_code text,
  check (environment='production' or recipient='development@alphasourceai.com')
);
alter table public.public_lead_notifications enable row level security;
revoke all on public.public_lead_notifications from public,anon,authenticated;
grant select,insert on public.public_lead_notifications to service_role;
grant update(status,completed_at,provider_reference,error_code) on public.public_lead_notifications to service_role;

create function public.guard_public_lead_notification_terminal()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.status <> 'sending' or new.status not in ('accepted','rejected','unknown') then
    raise exception 'lead_notification_terminal';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_public_lead_notification_terminal() from public,anon,authenticated;
create trigger public_lead_notification_terminal before update on public.public_lead_notifications
  for each row execute function public.guard_public_lead_notification_terminal();

create function public.save_public_lead_capture(
  p_row jsonb,
  p_notification_environment text default null,
  p_notifications_activated_at timestamptz default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_id uuid := (p_row->>'id')::uuid;
  v_old public.public_lead_drafts%rowtype;
  v_new public.public_lead_drafts%rowtype;
  v_claim public.public_lead_notifications%rowtype;
  v_now timestamptz := clock_timestamp();
  v_recipient text;
  v_path text;
begin
  if jsonb_typeof(p_row) <> 'object' or v_id is null then raise exception 'invalid_lead_capture'; end if;
  -- Serializes even simultaneous first inserts, not just existing rows.
  perform pg_advisory_xact_lock(hashtextextended('public-lead:'||v_id::text,0));
  select * into v_old from public.public_lead_drafts where id=v_id for update;
  if v_old.status='submitted' then
    return jsonb_build_object('item',jsonb_build_object('id',v_old.id,'status',v_old.status),'notification',null);
  end if;
  v_new := jsonb_populate_record(null::public.public_lead_drafts,p_row);
  if v_new.status not in ('partial','abandoned','submitted') or v_new.status is null
    or coalesce(v_new.email,'')='' and coalesce(v_new.phone,'')='' then
    raise exception 'invalid_lead_capture';
  end if;
  insert into public.public_lead_drafts (
    id,status,form_id,form_type,product_interest,first_name,last_name,email,phone,message,
    fields_completed,last_field,source_path,source_referrer_path,source_cta,utm,anonymous_id,
    session_id,privacy_notice_version,request_id,updated_at,submitted_at
  ) values (
    v_id,v_new.status,v_new.form_id,v_new.form_type,v_new.product_interest,v_new.first_name,v_new.last_name,
    v_new.email,v_new.phone,case when v_new.status='submitted' then v_new.message else null end,
    coalesce(v_new.fields_completed,'{}'::text[]),v_new.last_field,v_new.source_path,v_new.source_referrer_path,
    v_new.source_cta,coalesce(v_new.utm,'{}'::jsonb),v_new.anonymous_id,v_new.session_id,
    v_new.privacy_notice_version,v_new.request_id,v_now,case when v_new.status='submitted' then v_now else null end
  ) on conflict(id) do update set
    status=excluded.status,form_id=excluded.form_id,form_type=excluded.form_type,product_interest=excluded.product_interest,
    first_name=excluded.first_name,last_name=excluded.last_name,email=excluded.email,phone=excluded.phone,message=excluded.message,
    fields_completed=excluded.fields_completed,last_field=excluded.last_field,source_path=excluded.source_path,
    source_referrer_path=excluded.source_referrer_path,source_cta=excluded.source_cta,utm=excluded.utm,
    anonymous_id=excluded.anonymous_id,session_id=excluded.session_id,privacy_notice_version=excluded.privacy_notice_version,
    request_id=excluded.request_id,updated_at=excluded.updated_at,submitted_at=excluded.submitted_at
  returning * into v_new;

  -- Only this transaction's FIRST submitted transition may reserve a send.
  -- A flag-off/old/unknown-form submission is frozen but never caught up later.
  if v_new.status='submitted' and p_notifications_activated_at is not null
     and p_notifications_activated_at <= v_now
     and p_notification_environment in ('dev','qa','production') then
    v_path := rtrim(v_new.source_path,'/');
    if (v_new.form_id='home-contact' and v_new.form_type='contact' and v_path='') then
      v_recipient := 'info@alphasourceai.com';
    elsif (v_new.form_id='about-contact' and v_new.form_type='contact' and v_path='/about')
       or (v_new.form_id='alphascreen-demo' and v_new.form_type='demo' and v_path='/alphascreen')
       or (v_new.form_id='alphascreen-pricing-demo' and v_new.form_type='demo' and v_path='/alphascreen/pricing') then
      v_recipient := 'sales@alphasourceai.com';
    end if;
    if v_recipient is not null then
      if p_notification_environment<>'production' then v_recipient:='development@alphasourceai.com'; end if;
      insert into public.public_lead_notifications(lead_id,environment,recipient,form_id)
        values(v_id,p_notification_environment,v_recipient,v_new.form_id)
        on conflict(lead_id) do nothing returning * into v_claim;
    end if;
  end if;
  return jsonb_build_object('item',jsonb_build_object('id',v_new.id,'status',v_new.status),
    'notification',case when v_claim.lead_id is not null then
      jsonb_build_object('claim',to_jsonb(v_claim),'lead',to_jsonb(v_new)) else null end);
end;
$$;
revoke all on function public.save_public_lead_capture(jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.save_public_lead_capture(jsonb,text,timestamptz) to service_role;

create function public.record_public_lead_notification(
  p_lead_id uuid,p_attempt_id uuid,p_status text,p_reference text default null,p_error_code text default null
) returns boolean language plpgsql security invoker set search_path='' as $$
declare v_count integer;
begin
  if p_status not in ('accepted','rejected','unknown') or p_status is null
    or (p_reference is not null and p_reference !~ '^[A-Za-z0-9._:-]{1,200}$')
    or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$') then
    raise exception 'invalid_lead_notification_result';
  end if;
  update public.public_lead_notifications set status=p_status,completed_at=clock_timestamp(),
    provider_reference=p_reference,error_code=p_error_code
    where lead_id=p_lead_id and attempt_id=p_attempt_id and status='sending';
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.record_public_lead_notification(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.record_public_lead_notification(uuid,uuid,text,text,text) to service_role;
commit;
