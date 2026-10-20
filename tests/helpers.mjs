import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocal } from "../dist/runtime/local/app.js";

export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "skilly-test-"));
  const path = join(directory, "memory.sqlite");
  const apps = [];
  const open = () => { const app = openLocal(path); apps.push(app); return app; };
  const app = open();
  t.after(async () => {
    for (const item of apps.reverse()) await item.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, directory, open, app, call: (name, input) => app.dispatcher.call(name, input) };
}

export async function project(call, key = "example") {
  const result = await call("memory_register_project", { key, name: key, idempotency_key: `register:${key}` });
  return result.project.id;
}

export async function run(call, projectId, extra = {}) {
  const result = await call("memory_begin_task", {
    project_id: projectId, goal: "댓글 해결 기능 개발", mode: "change", idempotency_key: "begin",
    ...extra,
  });
  return result.run.id;
}

export function checkpoint(projectId, runId, extra = {}) {
  return {
    project_id: projectId, run_id: runId, topic: "comments-resolution",
    kind: "change", body: "댓글 해결 상태 저장 처리 추가", idempotency_key: "checkpoint",
    ...extra,
  };
}
