import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."); const compose=path.join(root,"scripts","compose.sh");
function run(label,cmd,args,env=process.env){console.log(`\n=== ${label} ===`);const r=spawnSync(cmd,args,{cwd:root,env,stdio:"inherit"});if(r.status!==0||r.error){console.error(`FAIL ${label}`);process.exit(r.status??1)}console.log(`PASS ${label}`)}
run("Regression through Capture","pnpm",["verify:phase-0f"],{...process.env,PHASE_0I_INTEGRATION:"1",PHASE_0J_INTEGRATION:"1",PHASE_0J_WAVE2_INTEGRATION:"1",PHASE_0J_WAVE3_INTEGRATION:"1",PHASE_0J_WAVE4_INTEGRATION:"1",PHASE_0J1_INTEGRATION:"1",PHASE_0K_WAVE_A_INTEGRATION:"1",PHASE_0K_WAVE_B_INTEGRATION:"1",PHASE_0L_INTEGRATION:"1",PHASE_0D_INTEGRATION:"1",PHASE_0C_INTEGRATION:"1",PHASE_0E_INTEGRATION:"1",PHASE_0P_INTEGRATION:"1"});
for(const s of ["typecheck","lint","test","build"])run(`Office ${s}`,"pnpm",["--filter","@expense-tax/office-web",s]);
run("Office Docker",compose,["build","office-web"]);run("Office readiness",compose,["up","-d","office-web"]);
let ready=false;for(let attempt=0;attempt<30;attempt+=1){if(spawnSync("curl",["--fail","--silent","http://127.0.0.1:7302/dashboard"]).status===0){ready=true;break}spawnSync("sleep",["1"])}if(!ready)process.exit(1);
console.log("PASS Phase 0M aggregate verification: zero required checks skipped");
