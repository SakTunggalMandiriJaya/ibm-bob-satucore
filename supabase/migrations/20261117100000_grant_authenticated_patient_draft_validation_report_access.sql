-- Patient draft validation uses SELECT for the duplicate-report lookup and INSERT
-- to append new report evidence. RLS tenant policies remain enabled and unchanged.
-- Authenticated users receive only these two required table privileges.
grant select, insert on table public.patient_draft_validation_reports to authenticated;
