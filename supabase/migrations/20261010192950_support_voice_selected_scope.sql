begin;

create table private_support.support_voice_scopes (
  session_id text primary key references private_support.support_voice_sessions(session_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
alter table private_support.support_voice_scopes owner to postgres;
alter table private_support.support_voice_scopes enable row level security;
revoke all on private_support.support_voice_scopes from public, anon, authenticated, service_role;

create function public.service_bind_support_voice_scope(
  p_session_id text, p_user_id uuid, p_client_id uuid, p_user_fingerprint text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  -- Only a fresh reservation owned by this authenticated identity can be bound.
  perform 1 from private_support.support_voice_sessions
   where session_id = p_session_id and user_fingerprint = p_user_fingerprint
     and phase = 'pending' and expires_at > clock_timestamp() for update;
  if not found then return false; end if;
  insert into private_support.support_voice_scopes(session_id,user_id,client_id)
    values(p_session_id,p_user_id,p_client_id);
  return true;
end;
$$;

create function public.service_read_support_voice_scope(p_session_id text)
returns table(user_id uuid, client_id uuid)
language sql security definer set search_path = '' as $$
  select scope.user_id, scope.client_id
    from private_support.support_voice_scopes scope
    join private_support.support_voice_sessions session using(session_id)
   where scope.session_id = p_session_id and session.phase = 'active'
     and session.expires_at > clock_timestamp();
$$;

alter function public.service_bind_support_voice_scope(text,uuid,uuid,text) owner to postgres;
alter function public.service_read_support_voice_scope(text) owner to postgres;
revoke all on function public.service_bind_support_voice_scope(text,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.service_read_support_voice_scope(text) from public,anon,authenticated;
grant execute on function public.service_bind_support_voice_scope(text,uuid,uuid,text) to service_role;
grant execute on function public.service_read_support_voice_scope(text) to service_role;

commit;
