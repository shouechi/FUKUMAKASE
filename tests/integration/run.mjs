import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const compose=['compose','-p','outfit-review','-f','tests/integration/stack.compose.yml'];
const docker=(args,options={})=>execFileSync('docker',[...compose,...args],{cwd:root,stdio:'inherit',...options});
let started=false;
try{
  const existing=execFileSync('docker',['ps','-aq','--filter','label=com.docker.compose.project=outfit-review'],{encoding:'utf8'}).trim();
  if(existing)throw new Error('Existing outfit-review containers found; inspect them before running this disposable fixture');
  // The fixed project and container prefix belongs exclusively to this fixture.
  started=true;docker(['up','-d','db','auth']);
  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
    try{ready=(await fetch('http://127.0.0.1:54338/health')).ok;}catch{}
    if(ready)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!ready)throw new Error('Local GoTrue did not become healthy in 60 seconds');
  docker(['exec','-T','db','psql','-U','postgres','-d','outfit','-v','ON_ERROR_STOP=1'],{
    input:readFileSync(resolve(root,'supabase/migrations/202610110001_initial.sql')),stdio:['pipe','inherit','inherit'],
  });
  docker(['up','-d','rest']);
  ready=false;
  for(let attempt=0;attempt<30;attempt++){
    try{ready=(await fetch('http://127.0.0.1:54339/')).ok;}catch{}
    if(ready)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!ready)throw new Error('Local PostgREST did not become healthy in 30 seconds');
  const run=spawnSync('pnpm',['exec','vitest','run','tests/integration/http.test.ts'],{cwd:root,stdio:'inherit',env:{...process.env,RUN_LOCAL_HTTP_INTEGRATION:'1'}});
  process.exitCode=run.status??1;
}catch(error){
  console.error(error.message);process.exitCode=1;
  if(started)docker(['logs','--tail','30','auth','rest']);
}finally{
  // Removes ONLY this fixture's named containers/network; db data is tmpfs.
  if(started)docker(['down','--volumes']);
}
