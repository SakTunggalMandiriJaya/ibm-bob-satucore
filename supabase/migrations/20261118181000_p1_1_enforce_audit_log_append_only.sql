create or replace function private.guard_audit_logs_append_only()
returns trigger
language plpgsql
security invoker
set search_path to 'pg_catalog','public','private'
as $function$
begin
  raise exception 'audit_logs is append-only; update and delete are prohibited'
    using errcode = '42501';
end;
$function$;

drop trigger if exists satucore_audit_logs_append_only on public.audit_logs;

create trigger satucore_audit_logs_append_only
before update or delete on public.audit_logs
for each row execute function private.guard_audit_logs_append_only();
