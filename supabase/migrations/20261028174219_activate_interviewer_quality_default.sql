-- Apply only after the reviewed quality-aware backend is live. Existing NULL
-- attempts retain the legacy policy; no historical rows are updated here.
alter table public.interviews alter column interview_quality_version set default 'role_quality_v3';
