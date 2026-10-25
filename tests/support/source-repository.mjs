import {mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Currentness fixtures must not depend on the developer checkout's dirty/private-file inventory.
export function sourceRepository(parent){
 const path=join(parent,'public-source');mkdirSync(path);const root=realpathSync(path);
 const git=(...args)=>{const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Skilly test','-c','user.email=test@example.invalid','-C',root,...args],{encoding:'utf8'});if(result.status!==0)throw Error(result.stderr||'Fixture Git failed');};
 git('init','--template=');writeFileSync(join(root,'sample.js'),'export const sample = true;\n');git('add','sample.js');git('commit','-m','Synthetic source fixture');return root;
}
