import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFactoryPoint as P,boxVertices,assemblyPose,solveFactoryArm} from '../ui/factory-geometry.js';
test('belt, cargo and transfer share one projection and deck plane',()=>{
 const p=P([0,0,42]),q=P([100,0,42]); assert.deepEqual(q.map((v,i)=>v-p[i]),[112,0]);
 const box=boxVertices([0,0,42],[64,46,22]);assert.ok(box.top.every(p=>p[2]===64));assert.ok(box.front.slice(0,2).every(p=>p[2]===42));
});
test('every robot pose preserves link lengths and gripper contact, including pickup and placement',()=>{
 for(let i=0;i<=1000;i++){
  const pose=assemblyPose(i/1000),arm=solveFactoryArm(pose.target);
  const length=(a,b)=>Math.hypot(...a.map((v,j)=>v-b[j]));
  assert.ok(Math.abs(length(arm.shoulder,arm.elbow)-105)<1e-8);
  assert.ok(Math.abs(length(arm.elbow,arm.wrist)-96)<1e-8);
  assert.ok(Math.abs(arm.wrist[2]-arm.contact[2]-16)<1e-10);
  assert.ok(arm.elbow.every(Number.isFinite));
 }
 assert.deepEqual(assemblyPose(.2).target,[-105,-60,54]);assert.equal(assemblyPose(.2).carrying,true);
 assert.deepEqual(assemblyPose(.72).target,[0,0,73]);assert.equal(assemblyPose(.72).carrying,false);
});

import {createFactoryMotion} from '../ui/factory-motion.js';
test('motion driver sleeps when hidden or paused and disposes its frame and media listener',()=>{
 const oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame,oldMedia=globalThis.matchMedia;
 const pending=new Map();let next=0,draws=0,removed=0,paused=0,resumed=0,listener,time=0,pose;
 const media={matches:false,addEventListener(event,fn){listener=fn;},removeEventListener(){removed++;}};
 globalThis.requestAnimationFrame=fn=>{pending.set(++next,fn);return next;};globalThis.cancelAnimationFrame=id=>pending.delete(id);globalThis.matchMedia=()=>media;
 try{
  const motion=createFactoryMotion({frame:{isConnected:true},svg:{pauseAnimations(){paused++;},unpauseAnimations(){resumed++;},getCurrentTime(){return time;},setCurrentTime(value){time=value;}},draw(value){draws++;pose=value;},active:true});
  assert.deepEqual(pose,assemblyPose(0));
  assert.equal(pending.size,0);motion.setVisible(true);assert.equal(pending.size,1);
  const step=time=>{const [id,fn]=pending.entries().next().value;pending.delete(id);fn(time);};
  step(0);const first=draws;step(16);assert.equal(draws,first);step(34);assert.equal(draws,first+1);
  motion.setPaused(true);assert.equal(pending.size,0);motion.setPaused(false);assert.equal(pending.size,1);
  motion.setVisible(false);assert.equal(pending.size,0);
  media.matches=true;motion.setVisible(true);listener();assert.equal(pending.size,0);
  assert.equal(time,4);assert.equal(pose.mounted,true);
  motion.dispose();assert.equal(removed,1);assert.ok(paused);assert.ok(resumed);
 }finally{globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;globalThis.matchMedia=oldMedia;}
});
