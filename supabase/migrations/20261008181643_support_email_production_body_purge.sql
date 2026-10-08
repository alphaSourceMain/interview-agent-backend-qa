-- Production preparation ONLY: pin alphascreen/rytlclkkcvvnkoncfaid externally.
-- Apply only after the three exact private support-email schema prerequisites.
-- No mail polling, HTTP, secret, model, send or application/business-table changes.
begin;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
    or pg_catalog.to_regprocedure('public.purge_support_email_draft_bodies()') is null then
    raise exception 'support email purge prerequisites missing';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('alphy-support-email-prod-purge', 0));
  if exists (select 1 from cron.job where jobname = 'alphy-support-email-prod-purge') then
    raise exception 'support email purge job already exists: inspect, do not overwrite';
  end if;
end;
$$;
select cron.schedule(
  'alphy-support-email-prod-purge',
  '17 * * * *',
  'select public.purge_support_email_draft_bodies();'
);
commit;
