-- Fix NIK redaction in identity-review audit rationale.
-- PostgreSQL's ARE regex engine does not interpret the double-escaped \\m/\\M
-- sequence as word boundaries. Replace it with a direct 16-digit matcher.
-- CREATE OR REPLACE preserves the existing function signatures, owners and ACLs.

do $migration$
declare
  v_function record;
  v_definition text;
  v_old_pattern text := $$'\\m[0-9]{16}\\M'$$;
  v_new_pattern text := $$'[0-9]{16}'$$;
  v_matches integer;
begin
  for v_function in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_patient_identity_review_request',
        'decide_patient_identity_review_internal'
      )
  loop
    v_definition := pg_get_functiondef(v_function.oid);

    v_matches :=
      (length(v_definition) - length(replace(v_definition, v_old_pattern, '')))
      / length(v_old_pattern);

    if v_matches <> 1 then
      raise exception 'Expected exactly one old NIK redaction pattern in %, found %',
        v_function.proname, v_matches;
    end if;

    v_definition := replace(v_definition, v_old_pattern, v_new_pattern);
    execute v_definition;
  end loop;

  if (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_patient_identity_review_request',
        'decide_patient_identity_review_internal'
      )
      and position(v_new_pattern in pg_get_functiondef(p.oid)) > 0
  ) <> 2 then
    raise exception 'NIK redaction verification failed';
  end if;
end
$migration$;

-- Regression check: a 16-digit value must be masked even when adjacent to text.
do $test$
declare
  v_result text;
begin
  v_result := regexp_replace(
    'NIK=1234567890123456 end',
    '[0-9]{16}',
    '************',
    'g'
  );
  if v_result <> 'NIK=************ end' then
    raise exception 'NIK redaction regression test failed: %', v_result;
  end if;
end
$test$;
