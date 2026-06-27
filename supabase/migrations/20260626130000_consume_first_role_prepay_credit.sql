create or replace function public.consume_first_role_prepay_credit(
  p_billing_client_id uuid,
  p_source_client_id uuid,
  p_role_title text,
  p_interview_type text default null,
  p_jd_storage_path text default null
)
returns table (
  ok boolean,
  credit_id uuid,
  role_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit public.client_role_credits%rowtype;
  v_role_id uuid;
  v_interview_type text;
begin
  if p_billing_client_id is null or p_source_client_id is null then
    return query select false, null::uuid, null::uuid, 'client_required'::text;
    return;
  end if;

  if length(trim(coalesce(p_role_title, ''))) = 0 then
    return query select false, null::uuid, null::uuid, 'role_title_required'::text;
    return;
  end if;

  v_interview_type := upper(trim(coalesce(p_interview_type, '')));
  if v_interview_type not in ('BASIC', 'DETAILED', 'TECHNICAL') then
    v_interview_type := null;
  end if;

  select *
    into v_credit
    from public.client_role_credits
   where billing_client_id = p_billing_client_id
     and credit_type = 'first_role_prepay'
     and status = 'unused'
     and used_at is null
     and used_by_role_id is null
   order by created_at asc, id asc
   for update skip locked
   limit 1;

  if not found then
    return query select false, null::uuid, null::uuid, 'credit_not_available'::text;
    return;
  end if;

  insert into public.roles (
    client_id,
    title,
    interview_type,
    job_description_url
  )
  values (
    p_source_client_id,
    trim(p_role_title),
    v_interview_type,
    nullif(trim(coalesce(p_jd_storage_path, '')), '')
  )
  returning id into v_role_id;

  update public.client_role_credits
     set status = 'used',
         used_at = now(),
         used_by_role_id = v_role_id,
         source_client_id = coalesce(source_client_id, p_source_client_id),
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'consumed_by', 'role_checkout',
           'consumed_client_id', p_source_client_id,
           'consumed_at', now()
         ),
         updated_at = now()
   where id = v_credit.id
     and status = 'unused'
     and used_at is null
     and used_by_role_id is null;

  if not found then
    raise exception 'First-role prepay credit consumption race for %', v_credit.id;
  end if;

  return query select true, v_credit.id, v_role_id, 'used'::text;
end;
$$;
