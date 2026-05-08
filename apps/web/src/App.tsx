import { Activity, Check, Circle, Database, Plus, RadioTower } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useSyncStatus } from "@frick/react";
import type { Project, Task } from "@frick/protocol";

const projectId = "demo-project";

export function App() {
  const projects = useQuery<Project>({ entity: "Project", index: "all", args: { tenantId: "demo-tenant" } });
  const tasks = useQuery<Task>({ entity: "Task", index: "byProject", args: { projectId } });
  const toggle = useMutation<{ taskId: string; done: boolean }>("task.toggle");
  const createTask = useMutation<{ projectId: string; title: string }>("task.create");
  const status = useSyncStatus();
  const [title, setTitle] = useState("");

  const completed = tasks.filter((task) => task.done).length;
  const progress = tasks.length === 0 ? 0 : Math.round((completed / tasks.length) * 100);
  const project = projects[0];
  const sorted = useMemo(
    () => [...tasks].sort((left, right) => Number(left.done) - Number(right.done)),
    [tasks],
  );

  async function submitTask() {
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }
    setTitle("");
    await createTask({ projectId, title: trimmed });
  }

  return (
    <main className="shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Frick data fabric</p>
            <h1>{project?.name ?? "Loading launch room"}</h1>
          </div>
          <div className="status" data-connected={status.connected}>
            <RadioTower size={18} />
            <span>{status.connected ? "Live sync" : "Connecting"}</span>
          </div>
        </header>

        <section className="metrics" aria-label="Sync metrics">
          <Metric icon={<Database size={20} />} label="Schema" value="v1 packed DTO" />
          <Metric icon={<Activity size={20} />} label="Last op" value={`#${status.lastSeq}`} />
          <Metric icon={<Check size={20} />} label="Progress" value={`${progress}%`} />
        </section>

        <section className="task-panel">
          <div className="panel-head">
            <div>
              <h2>Shared tasks</h2>
              <p>{completed} of {tasks.length} replicated objects complete</p>
            </div>
            <form
              className="new-task"
              onSubmit={(event) => {
                event.preventDefault();
                void submitTask();
              }}
            >
              <input
                aria-label="New task title"
                placeholder="Add synced task"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <button type="submit" aria-label="Add synced task">
                <Plus size={18} />
              </button>
            </form>
          </div>

          <div className="tasks">
            {sorted.map((task) => (
              <button
                className="task"
                data-done={task.done}
                key={task.id}
                onClick={() => void toggle({ taskId: task.id, done: !task.done })}
              >
                <span className="check">{task.done ? <Check size={18} /> : <Circle size={18} />}</span>
                <span className="task-title">{task.title}</span>
                <span className="timestamp">{new Date(task.updatedAt).toLocaleTimeString()}</span>
              </button>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}
