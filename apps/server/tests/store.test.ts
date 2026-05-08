import { describe, expect, test } from "vitest";
import { FrickStore } from "../src/store.js";

describe("FrickStore", () => {
  test("seeds demo objects and returns query results", () => {
    const store = new FrickStore({ path: ":memory:" });

    const tasks = store.query({
      entity: "Task",
      index: "byProject",
      args: { projectId: "demo-project" },
    });

    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ id: "task-schema", done: true });
    store.close();
  });

  test("persists mutations as object deltas", () => {
    const store = new FrickStore({ path: ":memory:" });

    const delta = store.applyMutation("task.toggle", {
      taskId: "task-transport",
      done: true,
    });

    expect(delta).toMatchObject({
      mutation: "task.toggle",
      entityId: 2,
      entityName: "Task",
      objectId: "task-transport",
    });
    expect(delta.seq).toBeGreaterThan(0);
    expect(delta.fields).toContainEqual([5, true]);
    expect(store.readObject("Task", "task-transport")).toMatchObject({ done: true });
    store.close();
  });
});
