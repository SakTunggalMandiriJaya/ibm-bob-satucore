import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P1.2 SATUSEHAT Sandbox network security", () => {
  const kfa = readFileSync(
    join(process.cwd(), "supabase", "functions", "kfa-catalogue", "index.ts"),
    "utf8"
  );

  const patient = readFileSync(
    join(process.cwd(), "supabase", "functions", "satusehat-patient-submit", "index.ts"),
    "utf8"
  );

  it("restricts KFA API base to the exact Sandbox URL", () => {
    expect(kfa).toContain('configuredApiBase !== STAGING');
    expect(kfa).toContain('const base = STAGING;');
  });

  it("validates the OAuth URL against the exact Sandbox host", () => {
    expect(kfa).toContain('parsedTokenUrl.protocol !== "https:"');
    expect(kfa).toContain('parsedTokenUrl.hostname !== "api-satusehat-stg.dto.kemkes.go.id"');
    expect(kfa).toContain('parsedTokenUrl.pathname !== "/oauth2/v1/accesstoken"');
    expect(kfa).toContain('parsedTokenUrl.searchParams.get("grant_type") !== "client_credentials"');
  });

  it("blocks redirects on all three KFA outbound requests", () => {
    const redirectCount = (kfa.match(/redirect:\s*"error"/g) ?? []).length;
    expect(redirectCount).toBe(3);
  });

  it("blocks redirects on Patient OAuth and FHIR submission requests", () => {
    const redirectCount = (patient.match(/redirect:\s*"error"/g) ?? []).length;
    expect(redirectCount).toBe(2);
  });

  it("restricts Patient submission to the SATUSEHAT Sandbox host", () => {
    expect(patient).toContain("api-satusehat-stg.dto.kemkes.go.id");
  });
});
