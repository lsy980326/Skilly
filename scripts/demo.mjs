import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocal } from "../dist/runtime/local/app.js";

const directory = mkdtempSync(join(tmpdir(), "skilly-demo-"));
let app = openLocal(join(directory, "demo.sqlite"));
try {
  const call = (name, input) => app.dispatcher.call(name, input);
  const project = (await call("memory_register_project", { key: "demo", name: "예제 프로젝트", idempotency_key: "register" })).project;
  const run = (await call("memory_begin_task", { project_id: project.id, mode: "change", goal: "댓글 해결 기능 추가", idempotency_key: "begin" })).run;
  const first = await call("memory_checkpoint", {
    project_id: project.id, run_id: run.id, topic: "comments", kind: "change",
    body: "댓글 해결 표시를 메모리에 보관", idempotency_key: "first",
  });
  await call("memory_checkpoint", {
    project_id: project.id, run_id: run.id, topic: "comments", kind: "change",
    body: "새로고침 후에도 유지되도록 해결 상태를 DB에 보관", supersedes: first.record_id, idempotency_key: "correction",
  });
  await call("memory_finish_task", { project_id: project.id, run_id: run.id, outcome: "completed", summary: "구현 내용을 기록함. 실제 테스트 증거는 미연결.", idempotency_key: "finish" });
  await app.close();
  app = openLocal(join(directory, "demo.sqlite"));
  const result = await call("memory_query_context", { project_id: project.id, query: "해결" });
  assert.equal(result.records.length, 1);
  console.log(JSON.stringify({ scenario: "등록 → 기록 → 정정 → 마감 → 재시작 → 검색", result }, null, 2));
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
