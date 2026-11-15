# KFA catalogue integration

Updated: 2026-11-15

## Official SATUSEHAT contract used

Source: SATUSEHAT Platform, Master Data KFA REST API documentation:
https://satusehat.kemkes.go.id/platform/docs/id/master-data/kfa/rest-api-kfa/

- OAuth2 client credentials: POST /oauth2/v1/accesstoken?grant_type=client_credentials
- KFA v2 paginated search: GET /kfa-v2/products/all
  - Required: page, size, product_type
  - Optional: from_date, to_date, farmalkes_type, keyword, template_code, packaging_code
- KFA v2 detail: GET /kfa-v2/products?identifier=kfa&code={code}
- KFA v3 has separate ALKES-specific product endpoints and request schemas; it is not implemented by the KFA v2 function.
- Official code system URI: http://sys-ids.kemkes.go.id/kfa

## Deployed

- Supabase Edge Function: kfa-catalogue, ACTIVE version 1, JWT verification enabled.
- Supports authenticated tenant membership, per-tenant active staging connection lookup, server-side secret references, live search, detail and single-page sync (up to 100 products).
- Sync stores raw API product properties and source/version/row provenance in medication_products and terminology_sources. Imported items are not clinically approved.
- React KFA Catalogue page provides search, page sync and a clinic-specific review view.
- Tenant review decisions are stored in kfa_product_reviews with RLS and reviewer identity. One tenant's decision does not apply to another tenant.

## Blockers / verification status

- The live project currently has no rows in satusehat_connections. Therefore no authenticated KFA API call or real product import has yet been performed.
- Configure each clinic's own Organization ID and secret references in its connection. Kemenkes states one client credential pair is restricted to one Organization ID.
- No production KFA access is enabled.
- KFA v3 ALKES-specific API integration remains separate planned work.
- Build and browser end-to-end tests have not yet been run; GitHub workflow lookup for the UI commit returned no workflow runs.
