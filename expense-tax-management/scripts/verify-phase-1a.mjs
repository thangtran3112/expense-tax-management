import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");function run(l,c,a,e=process.env){console.log(`\n=== ${l} ===`);const r=spawnSync(c,a,{cwd:root,env:e,stdio:"inherit"});if(r.status!==0||r.error)process.exit(r.status??1);console.log(`PASS ${l}`)}
run("Workflow syntax and deployment gate","node",["scripts/check-ci-workflow.mjs"]);
run("CI lint","pnpm",["ci:lint"]);run("CI typecheck","pnpm",["ci:typecheck"]);run("CI tests","pnpm",["ci:test"]);run("CI builds","pnpm",["ci:build"]);
run("Full zero-skip integration chain","pnpm",["verify:phase-0n"],{...process.env,PHASE_0N_INTEGRATION:"1"});
console.log("\nPASS Phase 1A local CI verification");
