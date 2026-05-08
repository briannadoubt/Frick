import { describe, expect, test } from "vitest";
import {
  FrameKind,
  decodeFrame,
  demoManifest,
  encodeFrame,
  packObject,
  packPatch,
  unpackObject,
  unpackPatch,
} from "../src/index.js";

describe("schema packing", () => {
  test("packs objects with numeric entity and field identifiers", () => {
    const packed = packObject(demoManifest, "Task", {
      id: "task-1",
      projectId: "demo-project",
      tenantId: "demo-tenant",
      title: "Use tight frames",
      done: false,
      updatedAt: "2026-05-08T00:00:00.000Z",
    });

    expect(packed[0]).toBe(2);
    expect(packed[1]).toBe("task-1");
    expect(packed[2]).toContainEqual([4, "Use tight frames"]);
    expect(packed[2]).toContainEqual([5, false]);
    expect(JSON.stringify(packed)).not.toContain("title");
  });

  test("unpacks object and patch payloads through the manifest", () => {
    const patch = packPatch(demoManifest, "Task", "task-1", {
      title: "Renamed",
      done: true,
    });

    expect(patch).toEqual([2, "task-1", [[4, "Renamed"], [5, true]]]);
    expect(unpackPatch(demoManifest, patch)).toEqual({
      entityName: "Task",
      objectId: "task-1",
      patch: { title: "Renamed", done: true },
    });

    const object = unpackObject(demoManifest, [
      1,
      "project-1",
      [
        [1, "project-1"],
        [2, "Demo"],
        [3, "tenant"],
        [4, "now"],
      ],
    ]);

    expect(object).toEqual({
      id: "project-1",
      name: "Demo",
      tenantId: "tenant",
      updatedAt: "now",
    });
  });
});

describe("frick frames", () => {
  test("round-trips MessagePack binary frames", () => {
    const encoded = encodeFrame([
      FrameKind.Subscribe,
      "query-1",
      { entity: "Task", index: "byProject", args: { projectId: "demo-project" } },
    ]);

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBeGreaterThan(10);
    expect(decodeFrame(encoded)).toEqual([
      FrameKind.Subscribe,
      "query-1",
      { entity: "Task", index: "byProject", args: { projectId: "demo-project" } },
    ]);
  });
});
