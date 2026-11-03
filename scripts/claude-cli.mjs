#!/usr/bin/env node
// 데스크톱 앱에 번들된 Claude Code CLI를 찾아 그대로 실행한다.
// 용도: MCP 로그인/목록, 설정 진단 등 터미널 전용 명령. 예)
//   node scripts/claude-cli.mjs mcp list
//   node scripts/claude-cli.mjs mcp login supabase
//   node scripts/claude-cli.mjs doctor
// 바이너리 탐색 규칙은 scripts/claude-headless.mjs의 findBinary와 같다.
// 환경변수 SIGONGNOTE_CLAUDE_BIN 으로 경로를 고정할 수 있다. 비밀값은 다루지 않는다.
import { spawnSync } from "node:child_process";
import { findBinary } from "./claude-headless.mjs";

const bin = findBinary();
const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--which")) {
  console.log(JSON.stringify({ claudeBinary: bin, usage: "node scripts/claude-cli.mjs <claude 인자...>" }, null, 2));
  process.exit(0);
}
const result = spawnSync(bin, args, { stdio: "inherit", shell: false });
if (result.error) {
  console.error(`Claude CLI 실행 실패: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
