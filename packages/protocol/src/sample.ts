import type { FrickManifest, PlainObject } from "./schema.js";

export type Project = PlainObject & {
  id: string;
  name: string;
  tenantId: string;
  updatedAt: string;
};

export type Task = PlainObject & {
  id: string;
  projectId: string;
  tenantId: string;
  title: string;
  done: boolean;
  updatedAt: string;
};

export const demoManifest: FrickManifest = {
  name: "frick-demo",
  protocolVersion: 1,
  schemaVersion: 1,
  hash: "frick-demo-v1",
  entities: [
    {
      id: 1,
      name: "Project",
      fields: [
        { id: 1, name: "id", kind: "id", required: true, conflict: "lww" },
        { id: 2, name: "name", kind: "text", required: true, conflict: "lww" },
        { id: 3, name: "tenantId", kind: "text", required: true, conflict: "lww" },
        { id: 4, name: "updatedAt", kind: "timestamp", required: true, conflict: "lww" },
      ],
      indexes: [{ id: 1, name: "all", fields: ["tenantId"] }],
    },
    {
      id: 2,
      name: "Task",
      fields: [
        { id: 1, name: "id", kind: "id", required: true, conflict: "lww" },
        { id: 2, name: "projectId", kind: "ref", relation: "Project", required: true, conflict: "lww" },
        { id: 3, name: "tenantId", kind: "text", required: true, conflict: "lww" },
        { id: 4, name: "title", kind: "text", required: true, conflict: "lww" },
        { id: 5, name: "done", kind: "bool", required: true, conflict: "lww", default: false },
        { id: 6, name: "updatedAt", kind: "timestamp", required: true, conflict: "lww" },
      ],
      indexes: [{ id: 1, name: "byProject", fields: ["projectId", "done"] }],
    },
  ],
  mutations: [
    {
      id: 1,
      name: "task.create",
      input: { projectId: "id", title: "text" },
    },
    {
      id: 2,
      name: "task.toggle",
      input: { taskId: "id", done: "bool" },
    },
    {
      id: 3,
      name: "task.rename",
      input: { taskId: "id", title: "text" },
    },
  ],
};

export const demoProject: Project = {
  id: "demo-project",
  name: "Frick Launch Room",
  tenantId: "demo-tenant",
  updatedAt: "2026-05-08T00:00:00.000Z",
};

export const demoTasks: Task[] = [
  {
    id: "task-schema",
    projectId: "demo-project",
    tenantId: "demo-tenant",
    title: "Compile the schema into compact field ids",
    done: true,
    updatedAt: "2026-05-08T00:00:01.000Z",
  },
  {
    id: "task-transport",
    projectId: "demo-project",
    tenantId: "demo-tenant",
    title: "Sync binary deltas over the Frick frame protocol",
    done: false,
    updatedAt: "2026-05-08T00:00:02.000Z",
  },
  {
    id: "task-clients",
    projectId: "demo-project",
    tenantId: "demo-tenant",
    title: "Load the same server data from web, iOS, and Android",
    done: false,
    updatedAt: "2026-05-08T00:00:03.000Z",
  },
];
