-- Restore the authenticated-client privileges required by the KFA catalogue UI.
-- RLS remains authoritative: catalogue rows are read-only; clinic decisions stay tenant-scoped
-- and are limited by the existing kfa_review_tenant_* policies.
begin;

grant select on table public.medication_products to authenticated;
grant select, insert, update on table public.kfa_product_reviews to authenticated;

commit;
