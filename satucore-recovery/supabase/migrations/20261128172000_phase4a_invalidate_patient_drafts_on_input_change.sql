-- Phase 4A follow-up: invalidate persisted Patient Draft validation when its inputs change.
-- Existing source_row_corrections invalidation remains authoritative for correction-ledger inserts.
-- This closes the uncovered paths: direct source-row edits, Patient mapping changes, and import scope changes.

begin;

create or replace function private.invalidate_patient_drafts_after_input_change()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_table_name = 'data_imports' then
    if old.organization_id is not distinct from new.organization_id
       and old.source_system_id is not distinct from new.source_system_id then
      return null;
    end if;

    update public.patient_drafts d
       set status = 'stale',
           validation_report_id = null,
           validated_at = null,
           updated_by = coalesce(auth.uid(), d.updated_by)
     where d.tenant_id = new.tenant_id
       and d.import_id = new.id
       and d.status <> 'stale';

    return null;
  end if;

  if tg_table_name = 'import_rows' then
    if old.original_data is not distinct from new.original_data then
      return null;
    end if;

    update public.patient_drafts d
       set status = 'stale',
           validation_report_id = null,
           validated_at = null,
           updated_by = coalesce(auth.uid(), d.updated_by)
     where d.tenant_id = new.tenant_id
       and d.import_id = new.import_id
       and d.import_row_id = new.id
       and d.status <> 'stale';

    return null;
  end if;

  if tg_table_name = 'field_mappings' then
    if tg_op = 'INSERT' then
      if new.target_resource = 'Patient' and new.import_id is not null then
        update public.patient_drafts d
           set status = 'stale',
               validation_report_id = null,
               validated_at = null,
               updated_by = coalesce(auth.uid(), d.updated_by)
         where d.tenant_id = new.tenant_id
           and d.import_id = new.import_id
           and d.status <> 'stale';
      end if;
      return null;
    elsif tg_op = 'DELETE' then
      if old.target_resource = 'Patient' and old.import_id is not null then
        update public.patient_drafts d
           set status = 'stale',
               validation_report_id = null,
               validated_at = null,
               updated_by = coalesce(auth.uid(), d.updated_by)
         where d.tenant_id = old.tenant_id
           and d.import_id = old.import_id
           and d.status <> 'stale';
      end if;
      return null;
    elsif tg_op = 'UPDATE' then
      -- Invalidate the old import if a Patient mapping is removed or moved.
      if old.target_resource = 'Patient' and old.import_id is not null then
        update public.patient_drafts d
           set status = 'stale',
               validation_report_id = null,
               validated_at = null,
               updated_by = coalesce(auth.uid(), d.updated_by)
         where d.tenant_id = old.tenant_id
           and d.import_id = old.import_id
           and d.status <> 'stale';
      end if;

      -- Invalidate the new import if a Patient mapping is added or changed.
      if new.target_resource = 'Patient' and new.import_id is not null then
        update public.patient_drafts d
           set status = 'stale',
               validation_report_id = null,
               validated_at = null,
               updated_by = coalesce(auth.uid(), d.updated_by)
         where d.tenant_id = new.tenant_id
           and d.import_id = new.import_id
           and d.status <> 'stale';
      end if;
      return null;
    end if;
  end if;

  raise exception 'Unsupported table or operation for Patient Draft input invalidation: % %',
    tg_table_name, tg_op;
end;
$function$;

revoke all on function private.invalidate_patient_drafts_after_input_change()
  from public, anon, authenticated;

drop trigger if exists trg_invalidate_patient_drafts_after_import_scope_change
  on public.data_imports;

create trigger trg_invalidate_patient_drafts_after_import_scope_change
after update of organization_id, source_system_id on public.data_imports
for each row
when (
  old.organization_id is distinct from new.organization_id
  or old.source_system_id is distinct from new.source_system_id
)
execute function private.invalidate_patient_drafts_after_input_change();

drop trigger if exists trg_invalidate_patient_draft_after_source_update
  on public.import_rows;

create trigger trg_invalidate_patient_draft_after_source_update
after update of original_data on public.import_rows
for each row
when (old.original_data is distinct from new.original_data)
execute function private.invalidate_patient_drafts_after_input_change();

drop trigger if exists trg_invalidate_patient_drafts_after_patient_mapping_change
  on public.field_mappings;

create trigger trg_invalidate_patient_drafts_after_patient_mapping_change
after insert or update or delete on public.field_mappings
for each row
execute function private.invalidate_patient_drafts_after_input_change();

comment on function private.invalidate_patient_drafts_after_input_change() is
  'Marks affected Patient Drafts stale and clears validation evidence after source-row, Patient mapping, or import Organization/source-system changes.';

commit;
