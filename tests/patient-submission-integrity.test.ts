import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P1.1 actual FHIR payload integrity", () => {
  const source = readFileSync(
    join(process.cwd(), "supabase", "functions", "satusehat-patient-submit", "index.ts"),
    "utf8"
  );

  it("uses stable recursive JSON serialization for hash calculation", () => {
    expect(source).toContain("function stableJson(value: unknown): string");
    expect(source).toContain("Object.entries(value as Record<string, unknown>).sort");
  });

  it("calculates SHA-256 from the actual stored payload", () => {
    expect(source).toContain("const computedHash=await sha256(stableJson(resource.payload));");
  });

  it("compares calculated payload hash against the stored hash", () => {
    expect(source).toContain("if (computedHash!==actualHash)");
    expect(source).toContain("Actual FHIR payload differs from its stored integrity hash");
  });

  it("rejects payload integrity mismatch with HTTP 409", () => {
    expect(source).toMatch(/if \(computedHash!==actualHash\).*?409\);/);
  });

  it("performs integrity verification before OAuth network request", () => {
    const integrityCheck = source.indexOf("const computedHash=await sha256(stableJson(resource.payload));");
    const oauthFetch = source.indexOf("fetch(tokenUrl");

    expect(integrityCheck).toBeGreaterThan(-1);
    expect(oauthFetch).toBeGreaterThan(-1);
    expect(integrityCheck).toBeLessThan(oauthFetch);
  });
});