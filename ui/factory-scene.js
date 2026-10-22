import { projectFactoryPoint as P, boxVertices, solveFactoryArm } from "./factory-geometry.js";
import { createFactoryMotion } from "./factory-motion.js";

// All positions, including the contact points and delivery path, share one camera.
export function createFactoryScene({element,svgElement,active,completed,transfers,onOpen,sceneId}) {
  const frame=element("div",`workshop-scene factory-world${active.length?" is-assembling":""}${transfers.length?" is-delivering":""}`);
  const svg=svgElement("svg",{viewBox:"0 0 1000 410","aria-hidden":"true",focusable:"false"});
  const node=(tag,attrs,parent=svg,text)=>{const n=svgElement(tag,attrs,text);parent.append(n);return n;};
  const group=(cls,parent=svg)=>node("g",{class:cls},parent);
  const points=world=>world.map(p=>P(p).map(v=>v.toFixed(2)).join(",")).join(" ");
  const poly=(world,cls,parent=svg)=>node("polygon",{points:points(world),class:cls},parent);
  const line=(world,cls,parent=svg)=>node("polyline",{points:points(world),class:cls},parent);
  function box(at,size,cls,parent=svg){
    const body=group(cls,parent),faces=boxVertices(at,size);
    poly(faces.front,"world-front",body);poly(faces.right,"world-right",body);poly(faces.top,"world-top",body);return body;
  }
  function chip(at,parent=svg){
    const part=box(at,[16,14,7],"world-chip",parent);
    for(let i=-5;i<=5;i+=5){line([[at[0]+i,at[1]-7,at[2]+3],[at[0]+i,at[1]-11,at[2]+3]],"world-pin",part);
      line([[at[0]+i,at[1]+7,at[2]+3],[at[0]+i,at[1]+11,at[2]+3]],"world-pin",part);}
    return part;
  }
  function product(at,cls,parent=svg){
    const anchor=group(`cargo-anchor ${cls}`,parent),cargo=group("cargo",anchor),[x,y,z]=at;
    box(at,[64,46,22],"world-housing",cargo);
    box([x,y,z+22],[48,32,2],"world-circuit",cargo);
    const circuitZ=z+24.1;
    line([[x-18,y-10,circuitZ],[x-6,y-10,circuitZ],[x-6,y+7,circuitZ],[x+18,y+7,circuitZ]],"world-trace",cargo);
    line([[x+17,y-10,circuitZ],[x+5,y-10,circuitZ],[x+5,y+4,circuitZ]],"world-trace",cargo);
    for(const [sx,sy] of [[-27,-18],[27,-18],[-27,18],[27,18]]){
      const [cx,cy]=P([x+sx,y+sy,z+22.5]);node("ellipse",{cx,cy,rx:2.2,ry:1.1,class:"world-screw"},cargo);
    }
    for(let i=0;i<4;i++)line([[x-24+i*8,y+23.1,z+7],[x-19+i*8,y+23.1,z+7]],"world-vent",cargo);
    if(cls.includes("archived")||cls.includes("delivery")){
      chip([x,y,z+24],cargo);
      line([[x+17,y+23.5,z+11],[x+21,y+23.5,z+7],[x+28,y+23.5,z+17]],"world-done",cargo);
    }
    return {anchor,cargo};
  }
  // Floor and legs are drawn before opaque machine surfaces, so nothing shines through.
  poly([[-370,-130,0],[370,-130,0],[370,135,0],[-370,135,0]],"world-floor");
  for(let x=-350;x<=350;x+=35)line([[x,-125,.1],[x,130,.1]],"world-grid");
  for(let y=-110;y<=120;y+=35)line([[-365,y,.1],[365,y,.1]],"world-grid");
  box([35,-100,0],[58,52,15],"world-robot-base");
  box([35,-100,15],[28,26,43],"world-robot-column");
  box([105,-110,0],[30,26,49],"world-cabinet");
  const [ledX,ledY]=P([105,-96,36]);node("circle",{cx:ledX,cy:ledY,r:2.5,class:active.length?"world-led active":"world-led"});
  for(const x of [-280,-50,220])for(const y of [-31,31])box([x,y,0],[12,12,34],"world-leg");
  box([-30,0,30],[600,88,10],"world-frame");
  box([-30,0,40],[600,78,2],"world-belt");
  const defs=node("defs",{}),clip=node("clipPath",{id:`${sceneId}-deck`},defs);
  poly(boxVertices([-30,0,40],[600,78,2]).top,"",clip);
  const rollerClip=node("g",{"clip-path":`url(#${sceneId}-deck)`}),rollers=group("world-rollers",rollerClip);
  for(let x=-323;x<=268;x+=22)line([[x,-38,42.15],[x,38,42.15]],"world-roller",rollers);
  const rollerStart=P([0,0,0]),rollerEnd=P([22,0,0]);
  if(active.length){node("animateTransform",{attributeName:"transform",type:"translate",from:"0 0",to:`${rollerEnd[0]-rollerStart[0]} ${rollerEnd[1]-rollerStart[1]}`,dur:"1.2s",repeatCount:"indefinite"},rollers);}
  box([-30,-43,42],[604,3,4],"world-rail");
  box([-30,43,42],[604,3,4],"world-rail");
  // Parts supply is physically on the same deck; the robot picks this exact chip.
  box([-105,-60,42],[44,34,3],"world-tray");
  const supply=chip([-105,-60,47]);
  box([110,66,30],[54,34,12],"world-tray");
  for(const x of [94,108,122]){
    box([x,66,42],[8,8,7],"world-bolt");
    box([x,66,49],[12,12,3],"world-bolt");
  }
  active.slice(1,3).reverse().forEach((task,i)=>product([-245+i*88,0,42],"queued"));
  let mounted;
  if(active[0]){
    const {cargo}=product([0,0,42],"in-assembly");
    cargo.setAttribute("transform","translate(-106.4 -11.4)");
    node("animateTransform",{attributeName:"transform",type:"translate",from:"-106.4 -11.4",to:"0 0",begin:transfers.length?"1.2s":"0s",dur:"1.2s",fill:"freeze",calcMode:"spline",keyTimes:"0;1",keySplines:".23 1 .32 1"},cargo);
    mounted=chip([0,0,66]);
  }
  // A level receiving dock connects to the belt. Its small elevator stacks saved completions.
  box([310,0,30],[98,102,12],"world-dock");
  box([310,0,42],[94,98,3],"world-tray");
  const stack=completed.slice(0,4).reverse();
  let latestPosition=[310,0,45];
  stack.forEach((task,i)=>{
    const at=[310,i%2===0?-26:26,45+Math.floor(i/2)*25];latestPosition=at;
    const {cargo}=product(at,`archived${transfers.some(t=>t.id===task.id)?" just-stored":""}`);
    if(transfers.some(t=>t.id===task.id)){
      node("animate",{attributeName:"opacity",values:"0;0;1",keyTimes:"0;.87;1",dur:"3.2s",fill:"freeze"},cargo);
    }
  });
  if(transfers.length){
    const {cargo}=product([0,0,42],"delivery");
    const origin=P([0,0,42]),approach=P([280,0,42]),target=P(latestPosition);
    const delta=p=>`${p[0]-origin[0]} ${p[1]-origin[1]}`;
    node("animateTransform",{attributeName:"transform",type:"translate",values:`0 0;0 0;${delta(approach)};${delta(target)};${delta(target)}`,keyTimes:"0;.12;.78;.94;1",dur:"3.2s",fill:"freeze",calcMode:"spline",keySplines:".77 0 .175 1;.77 0 .175 1;.77 0 .175 1;.77 0 .175 1"},cargo);
    node("animate",{attributeName:"opacity",values:"1;1;0",keyTimes:"0;.94;1",dur:"3.2s",fill:"freeze"},cargo);
  }
  // Robot pedestal and control cabinet stay behind the arm.
  const arm=group("world-arm"),upperEdge=node("line",{class:"world-arm-edge"},arm),upper=node("line",{class:"world-arm-link"},arm);
  const foreEdge=node("line",{class:"world-arm-edge fore"},arm),fore=node("line",{class:"world-arm-link fore"},arm);
  const jointNodes=Array.from({length:3},()=>({outer:node("circle",{r:10,class:"world-joint"},arm),inner:node("circle",{r:4,class:"world-joint-pin"},arm)}));
  const shaft=node("polyline",{class:"world-gripper"},arm),fingerA=node("polyline",{class:"world-gripper"},arm),fingerB=node("polyline",{class:"world-gripper"},arm);
  const held=chip([0,0,0],arm);
  function segment(n,a,b){const start=P(a),end=P(b);n.setAttribute("x1",start[0]);n.setAttribute("y1",start[1]);n.setAttribute("x2",end[0]);n.setAttribute("y2",end[1]);}
  function draw(pose){
    const solved=solveFactoryArm(pose.target);
    for(const n of [upperEdge,upper])segment(n,solved.shoulder,solved.elbow);
    for(const n of [foreEdge,fore])segment(n,solved.elbow,solved.wrist);
    [solved.shoulder,solved.elbow,solved.wrist].forEach((p,i)=>{const [cx,cy]=P(p);for(const n of [jointNodes[i].outer,jointNodes[i].inner]){n.setAttribute("cx",cx);n.setAttribute("cy",cy);}});
    const [x,y,z]=pose.target;
    shaft.setAttribute("points",points([solved.wrist,[x,y,z+7]]));
    fingerA.setAttribute("points",points([[x-11,y,z+8],[x-11,y,z-2],[x-7,y,z-4]]));
    fingerB.setAttribute("points",points([[x+11,y,z+8],[x+11,y,z-2],[x+7,y,z-4]]));
    const base=P([0,0,0]),destination=P([x,y,z-7]);held.setAttribute("transform",`translate(${destination[0]-base[0]} ${destination[1]-base[1]})`);
    held.setAttribute("opacity",pose.carrying?"1":"0");supply.setAttribute("opacity",pose.supply?"1":"0");mounted?.setAttribute("opacity",pose.mounted?"1":"0");
  }
  frame.append(svg);
  const labels=element("div","workshop-stations");
  for(const [num,title,note]of[["01","작업 투입","저장된 진행중 작업"],["02","부품 조립",active.length?"진행중 상태 표현":"진행중 기록 없음"],["03","완료 보관함","미확인 완료만 표시"]]){
    const label=element("div","workshop-station");label.append(element("span","station-number",num),element("strong","",title),element("small","",note));labels.append(label);
  }
  frame.append(labels);
  if(active[0]){const readout=element("button","workshop-current");readout.append(element("span","workshop-status","진행중 · 저장 상태"),element("strong","",active[0].title||active[0].goal));readout.addEventListener("click",()=>onOpen(active[0].id));frame.append(readout);}
  frame.workshopMotion=createFactoryMotion({frame,svg,draw,active:active.length>0});
  return frame;
}
