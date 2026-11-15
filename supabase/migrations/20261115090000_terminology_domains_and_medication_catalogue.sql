-- SATUCORE terminology domain separation and KFA-ready product catalogue.
-- No source concepts are imported by this migration. Catalogue rows remain empty until
-- an authoritative KFA export and its schema/version have been verified.
alter table public.terminology_sets
  add column if not exists domain_key text not null default 'unclassified',
  add column if not exists resource_types text[] not null default '{}',
  add column if not exists publication_status text not null default 'reference_only';

alter table public.terminology_sources
  add column if not exists domain_key text not null default 'unclassified',
  add column if not exists approval_status text not null default 'unreviewed';

create table if not exists public.medication_products (
  id uuid primary key default gen_random_uuid(),
  catalogue_key text not null,
  catalogue_version text not null,
  product_code text not null,
  product_display text not null,
  product_type text not null,
  code_system_uri text not null,
  properties jsonb not null default '{}'::jsonb,
  source_id uuid references public.terminology_sources(id) on delete restrict,
  source_sheet text,
  source_row_number integer,
  active boolean not null default true,
  approval_status text not null default 'unreviewed',
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (catalogue_key, catalogue_version, product_code)
);
create index if not exists medication_products_code_idx
  on public.medication_products (catalogue_key, product_code);
create index if not exists medication_products_display_idx
  on public.medication_products using gin (to_tsvector('simple', product_display));
alter table public.medication_products enable row level security;
drop policy if exists medication_products_authenticated_read on public.medication_products;
create policy medication_products_authenticated_read
  on public.medication_products for select to authenticated
  using (auth.uid() is not null);
comment on table public.medication_products is
  'Reference catalogue for medicinal products/devices such as KFA; separate from FHIR Medication and MedicationRequest. Import only after authoritative source/version verification.';
comment on column public.medication_products.approval_status is
  'unreviewed, approved, rejected; unreviewed catalogue rows must not be treated as validated mappings.';
comment on column public.terminology_sets.domain_key is
  'Clinical terminology domain, e.g. loinc_lab, loinc_radiology, icd10, icd9cm_kptl, snomed, kfa. Classification alone does not establish authority or approval.';
