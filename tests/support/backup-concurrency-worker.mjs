import {openLocal} from '../../dist/runtime/local/app.js';
import {backupDatabase} from '../../dist/adapters/storage/transfer/snapshot.js';
const [role,path,...args]=process.argv.slice(2);
if(role==='backup') {
 try{const result=await backupDatabase(path,args[0]);process.send({kind:'backup',ok:true,result});}
 catch(error){process.send({kind:'backup',ok:false,code:error.code,message:error.message});}
 process.disconnect();
}else if(role==='writer'){
 const app=openLocal(path),[project_id,run_id]=args,errors=[];let stop=false,index=0;
 process.on('disconnect',()=>process.exit());process.on('message',m=>{if(m==='stop')stop=true;});
 while(!stop){
  try{const r=await app.dispatcher.call('memory_checkpoint',{project_id,run_id,topic:'backup-concurrent',kind:'note',body:'동시 기록 합성 검사 '+index,idempotency_key:'writer-'+index});process.send({kind:'saved',record_id:r.record_id});}
  catch(error){errors.push({code:error.code,pending_retained:error.recovery?.pending_retained});}
  index++;await new Promise(resolve=>setTimeout(resolve,10));
 }
 await app.close();process.send({kind:'stopped',errors});process.disconnect();
}else throw new Error('Unknown test worker role');
