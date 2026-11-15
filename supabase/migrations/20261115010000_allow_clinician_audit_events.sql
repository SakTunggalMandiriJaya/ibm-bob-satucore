-- Clinicians are permitted to create Patient records under the existing patients.role_insert policy.
-- Their corresponding audit event must therefore also be insertable within that same tenant.
drop policy if exists tenant_insert on public.audit_logs;
create policy tenant_insert
on public.audit_logs
for insert
to authenticated
with check (
  private.has_tenant_role(
    tenant_id,
    array['tenant_admin','clinic_admin','data_manager','clinician','reviewer','submitter','auditor']::text[]
  )
);
