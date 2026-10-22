// One dimetric camera for every object. x follows the belt, y is depth, z is height.
export const BELT_HEIGHT = 40;
export function projectFactoryPoint([x, y, z]) { return [500 + 1.12 * x - .5 * y, 235 + .12 * x + .52 * y - .98 * z]; }
export function boxVertices([x, y, z], [width, depth, height]) {
  const a=x-width/2,b=x+width/2,c=y-depth/2,d=y+depth/2;
  return {top:[[a,c,z+height],[b,c,z+height],[b,d,z+height],[a,d,z+height]],
    front:[[a,d,z],[b,d,z],[b,d,z+height],[a,d,z+height]],
    right:[[b,c,z],[b,d,z],[b,d,z+height],[b,c,z+height]]};
}
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
// Smooth, zero-velocity endpoints for the deliberate pick-and-place illustration.
const ease=t=>(1-Math.cos(Math.PI*t))/2;
const stops=[
 [0,[-105,-60,92],false], [.12,[-105,-60,54],false], [.2,[-105,-60,54],true],
 [.33,[-105,-60,100],true], [.52,[0,0,108],true], [.65,[0,0,73],true],
 [.72,[0,0,73],false], [.83,[0,0,108],false], [1,[-105,-60,92],false],
];
export function assemblyPose(phase) {
  const remainder=phase%1, p=remainder<0?remainder+1:remainder;
  const index=stops.findIndex((stop,i)=>i<stops.length-1&&p>=stop[0]&&p<stops[i+1][0]);
  const a=stops[Math.max(index,0)],b=stops[Math.max(index,0)+1];
  const t=ease((p-a[0])/(b[0]-a[0]));
  return {target:mix(a[1],b[1],t),carrying:a[2],mounted:p>=.72,supply:p<.2||p>.84};
}
export function solveFactoryArm(contact) {
  const shoulder=[35,-100,64],wrist=[contact[0],contact[1],contact[2]+16];
  const dx=wrist[0]-shoulder[0],dy=wrist[1]-shoulder[1],dz=wrist[2]-shoulder[2];
  const radius=Math.hypot(dx,dy),distance=Math.hypot(radius,dz),upper=105,fore=96;
  const reachable=Math.min(upper+fore-.001,Math.max(Math.abs(upper-fore)+.001,distance));
  const angle=Math.atan2(dz,radius)+Math.acos(Math.max(-1,Math.min(1,(upper*upper+reachable*reachable-fore*fore)/(2*upper*reachable))));
  const along=upper*Math.cos(angle),elevation=upper*Math.sin(angle);
  const elbow=[shoulder[0]+dx/Math.max(radius,.001)*along,shoulder[1]+dy/Math.max(radius,.001)*along,shoulder[2]+elevation];
  return {shoulder,elbow,wrist,contact};
}
