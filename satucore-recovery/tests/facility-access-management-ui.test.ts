import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Phase 4B facility administration contract", () => {
  it("requires explicit active organization membership for non-admin workspace resolution", () => {
    const workflow = read("src/lib/workflow.ts");
    expect(workflow).toContain("from('organization_members')");
    expect(workflow).toContain(".eq('status', 'active')");
    expect(workflow).toContain("membership.role !== 'tenant_admin'");
    expect(workflow).toContain("availableOrganizations: orgs ?? []");
  });

  it("does not silently choose among multiple facilities", () => {
    const workflow = read("src/lib/workflow.ts");
    const app = read("src/App.tsx");
    expect(workflow).toContain("if ((orgs ?? []).length > 1) return");
    expect(app).toContain("Choose your facility");
    expect(app).toContain("setWorkspace({ ...workspace, organizationId: organization.id");
  });

  it("restricts assignment management to tenant administrators", () => {
    const component = read("src/components/FacilityAccessManagement.tsx");
    expect(component).toContain('workspace.role !== "tenant_admin"');
    expect(component).toContain('from("organization_members").upsert');
    expect(component).toContain('status: "active"');
    expect(component).toContain('changeStatus(a,"revoked")');
  });

  it("does not automatically assign facilities to ordinary tenant members", () => {
    const workflow = read("src/lib/workflow.ts");
    expect(workflow).toContain("if (!assignedIds.length)");
    expect(workflow).toContain("organizationId: null");
    expect(workflow).not.toContain("insert({ tenant_id: membership.tenant_id, organization_id:");
  });
});
