-- When an interview became used.
--
-- Billing reads facts about interviews rather than keeping counters, so it needs
-- to know when each interview happened. The interviews table has no completion
-- timestamp — src/services/adminMetricsService.js:267 and :1289 both say so —
-- and updated_at moves for unrelated writes, which makes it unfit to decide
-- which month an interview belongs to.
--
-- public.interviews is not created by any migration in this repository, so the
-- column is added behind an existence check.

do $$
declare
  column_added boolean := false;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'interviews'
      and column_name = 'completed_at'
  ) then
    alter table public.interviews add column completed_at timestamptz null;
    column_added := true;
  end if;

  -- Backfill runs only on the migration that introduces the column, so a re-run
  -- cannot move a timestamp that has since been set properly.
  --
  -- APPROXIMATE for historical rows: updated_at is the best available source and
  -- it moves for writes unrelated to completion. Interviews completed after this
  -- migration get a real timestamp from the application. No Enterprise client
  -- exists yet, so no backfilled row is ever billed from this value.
  if column_added then
    update public.interviews
    set completed_at = updated_at
    where completed_at is null
      and updated_at is not null
      and (
        lower(coalesce(status, '')) in ('completed', 'analyzed')
        or coalesce(interview_summary, '') <> ''
      );
  end if;
end $$;

create index if not exists interviews_client_id_completed_at_idx
  on public.interviews (client_id, completed_at);

-- Deliberately no RLS or grant statements here.
--
-- public.interviews is NOT in the containment migration
-- (20260803155651_public_api_emergency_containment.sql), unlike the billing
-- tables, so it carries whatever access model it was given outside this
-- repository — very likely policies that let authenticated dashboard users read
-- their own client's rows. Revoking from anon and authenticated to match the
-- billing tables would change that model and could break the frontend. Adding a
-- column is not a reason to touch a table's access.
