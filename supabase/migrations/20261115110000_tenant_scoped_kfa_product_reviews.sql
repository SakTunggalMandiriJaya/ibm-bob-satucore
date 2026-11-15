create table if not exists public.kfa_product_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  medication_product_id uuid not null references public.medication_products(id) on delete cascade,
  decision text not null check (decision in ('approved','rejected','needs_review')),
  rationale text not null,
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, medication_product_id)
);
create index if not exists kfa_product_reviews_tenant_decision_idx on public.kfa_product_reviews(tenant_id, decision);
alter table public.kfa_product_reviews enable row level security;
drop policy if exists kfa_review_tenant_read on public.kfa_product_reviews;
create policy kfa_review_tenant_read on public.kfa_product_reviews for select to authenticated using (private.is_tenant_member(tenant_id));
drop policy if exists kfa_review_tenant_insert on public.kfa_product_reviews;
create policy kfa_review_tenant_insert on public.kfa_product_reviews for insert to authenticated with check (reviewed_by=auth.uid() and private.has_tenant_role(tenant_id,array['tenant_admin','clinic_admin','data_manager','reviewer']::text[]));
drop policy if exists kfa_review_tenant_update on public.kfa_product_reviews;
create policy kfa_review_tenant_update on public.kfa_product_reviews for update to authenticated using (private.has_tenant_role(tenant_id,array['tenant_admin','clinic_admin','data_manager','reviewer']::text[])) with check (reviewed_by=auth.uid() and private.has_tenant_role(tenant_id,array['tenant_admin','clinic_admin','data_manager','reviewer']::text[]));
comment on table public.kfa_product_reviews is 'Tenant-specific human decisions for shared SATUSEHAT KFA catalogue products; never global clinical approval.';