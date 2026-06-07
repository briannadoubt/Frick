import { describe, expect, it } from "vitest";
import {
  makeRbacPolicyHook,
  type FrickAction,
  type FrickPolicyInput,
  type Principal,
  type RbacMatrix,
} from "../src/index.js";

// FR-133: declarative RBAC policy-hook builder. The matrix is a
// role × action × resource-type write/read grid; the hook is tightening-only
// (deny or no-opinion) and opines only on the (role, action) pairs governed.

function principal(userId: string): Principal {
  return { userId, tenantId: "_default", deviceId: "d", replicaId: "r" };
}

function input(userId: string, action: FrickAction, name?: string): FrickPolicyInput {
  return {
    principal: principal(userId),
    action,
    resource: { kind: "object", ...(name !== undefined ? { name } : {}) },
  };
}

// Role by simple prefix convention — supplied by the app, NOT the framework.
const matrix: RbacMatrix = {
  resolveRole(p) {
    if (!p) return undefined;
    if (p.userId.startsWith("admin")) return "admin";
    if (p.userId.startsWith("tech")) return "technician";
    if (p.userId.startsWith("cust")) return "customer";
    return undefined; // ungoverned
  },
  roles: {
    admin: { "object.write": "all", "blob.write": "all" },
    technician: {
      "object.write": { allow: ["WorkOrder", "Note"] },
      "blob.write": "all",
    },
    customer: {
      "object.write": "none",
      "blob.write": "none",
      "object.read": { deny: ["Invoice", "Quote"] },
    },
  },
};

const hook = makeRbacPolicyHook(matrix);

describe("makeRbacPolicyHook", () => {
  it("allows (no opinion) for an 'all' rule", () => {
    expect(hook(input("admin-1", "object.write", "WorkOrder"))).toBeNull();
    expect(hook(input("admin-1", "blob.write"))).toBeNull();
  });

  it("denies outright for a 'none' rule", () => {
    const decision = hook(input("cust-1", "object.write", "WorkOrder"));
    expect(decision).not.toBeNull();
    expect(decision?.allow).toBe(false);
    if (decision && decision.allow === false) {
      expect(decision.reason).toBe("notAuthorizedForResource");
    }
    expect(hook(input("cust-1", "blob.write"))?.allow).toBe(false);
  });

  it("enforces an allow-list: permitted types pass, others deny", () => {
    expect(hook(input("tech-1", "object.write", "WorkOrder"))).toBeNull();
    expect(hook(input("tech-1", "object.write", "Note"))).toBeNull();
    expect(hook(input("tech-1", "object.write", "Invoice"))?.allow).toBe(false);
  });

  it("enforces a deny-list: listed types deny, others pass", () => {
    expect(hook(input("cust-1", "object.read", "Invoice"))?.allow).toBe(false);
    expect(hook(input("cust-1", "object.read", "Quote"))?.allow).toBe(false);
    // A type not on the deny list reads fine.
    expect(hook(input("cust-1", "object.read", "Vessel"))).toBeNull();
  });

  it("offers no opinion for ungoverned actions, roles, and principals", () => {
    // Action not in the role's entry.
    expect(hook(input("tech-1", "stream.append"))).toBeNull();
    // Role the matrix doesn't list.
    expect(hook(input("guest-1", "object.write", "WorkOrder"))).toBeNull();
    // No principal at all.
    expect(
      hook({ principal: undefined, action: "object.write", resource: { kind: "object", name: "X" } }),
    ).toBeNull();
  });

  it("uses a custom deny message when provided", () => {
    const custom = makeRbacPolicyHook({
      ...matrix,
      denyMessage: ({ role, resourceName }) => `nope: ${role}/${resourceName}`,
    });
    const decision = custom(input("tech-1", "object.write", "Invoice"));
    if (decision && decision.allow === false) {
      expect(decision.publicMessage).toBe("nope: technician/Invoice");
    } else {
      throw new Error("expected a deny");
    }
  });
});
