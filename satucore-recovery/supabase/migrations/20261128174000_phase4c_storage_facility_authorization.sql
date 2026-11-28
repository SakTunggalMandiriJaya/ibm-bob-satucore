-- Phase 4C: facility-aware authorization for legacy import objects.
-- Existing tenant/import/filename paths are retained. Ownership is resolved through
-- data_imports.storage_path and its authoritative organization_id, never inferred
-- from a folder segment.
begin;

drop policy if exists satucore_legacy_import_facility_scope on storage.objects;
create policy satucore_legacy_import_facility_scope
  on storage.objects
  as restrictive
  for all
  to authenticated
  using (
    bucket_id = 'legacy-imports'
    and exists (
      select 1
      from public.data_imports di
      where di.storage_path = storage.objects.name
        and di.tenant_id = (storage.foldername(storage.objects.name))[1]::uuid
        and private.can_access_organization(di.tenant_id, di.organization_id)
    )
  )
  with check (
    bucket_id = 'legacy-imports'
    and exists (
      select 1
      from public.data_imports di
      where di.storage_path = storage.objects.name
        and di.tenant_id = (storage.foldername(storage.objects.name))[1]::uuid
        and private.can_access_organization(di.tenant_id, di.organization_id)
    )
  );

commit;
