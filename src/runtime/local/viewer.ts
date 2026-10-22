import { parseArgs } from "node:util";
import { startViewer } from "../../transport/viewer/server.js";

async function main() {
  const { values } = parseArgs({ options: {
    db: { type: "string" }, port: { type: "string", default: "0" }, help: { type: "boolean" },
  } });
  if (values.help) {
    process.stdout.write("npm run view -- --db /absolute/path/memory.sqlite [--port 0]\n일반 조회는 읽기 전용이며 명시한 문서 가져오기만 저장합니다. 포트 0은 빈 로컬 포트를 선택합니다.\n"); return;
  }
  if (!values.db) throw new Error("--db로 기존 DB의 절대 경로를 지정해 주세요.");
  const viewer = await startViewer({ db: values.db, port: Number(values.port) });
  process.stdout.write(`Skilly 로컬 화면 · 조회 및 선택 문서 가져오기\n${viewer.url}\n이 연결 주소는 이 컴퓨터에서만 사용하세요. 종료: Ctrl+C\n`);
  const stop = () => { void viewer.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
main().catch(error => {
  process.stderr.write(`Skilly 화면을 열지 못했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}\n`);
  process.exitCode = 1;
});
