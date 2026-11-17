-- Grant only the operations required by the authenticated correction UI.
-- RLS remains enabled and enforces tenant membership and role restrictions.
grant select, insert on table public.source_row_corrections to authenticated;
grant select, insert, update on table public.patient_correction_requests to authenticated;
revoke all on table public.source_row_corrections from anon;
revoke all on table public.patient_correction_requests from anon;
