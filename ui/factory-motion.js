import { assemblyPose } from "./factory-geometry.js";
// A visible illustration uses at most 30 updates/s. No background loop or data polling.
export function createFactoryMotion({ frame, svg, draw, active }) {
  let visible=false,paused=false,disposed=false,raf=null,last=null,elapsed=0,painted=-Infinity;
  const media=typeof matchMedia==="function"?matchMedia("(prefers-reduced-motion: reduce)"):null;
  const tick=now=>{
    raf=null;
    if(disposed||!visible||paused||media?.matches||!frame.isConnected){last=null;return;}
    if(last!==null) elapsed+=Math.min(now-last,100);
    last=now;
    if(now-painted>=1000/30){draw(assemblyPose(elapsed/8400));painted=now;}
    raf=requestAnimationFrame(tick);
  };
  function sync(){
    const running=!disposed&&visible&&!paused&&!media?.matches;
    // Reduced motion shows the finished delivery instead of freezing an invisible cargo.
    if(!disposed&&media?.matches){
      svg.setCurrentTime?.(Math.max(4,svg.getCurrentTime?.()??0));
      draw(assemblyPose(.75));
    }
    if(running) svg.unpauseAnimations?.(); else svg.pauseAnimations?.();
    if(!running&&raf!==null){cancelAnimationFrame(raf);raf=null;last=null;}
    if(running&&active&&raf===null&&typeof requestAnimationFrame==="function") raf=requestAnimationFrame(tick);
  }
  const change=()=>sync();media?.addEventListener?.("change",change);
  draw(assemblyPose(media?.matches ? .75 : 0));
  return {setVisible(value){visible=value;sync();},setPaused(value){paused=value;sync();},
    dispose(){disposed=true;sync();media?.removeEventListener?.("change",change);}};
}
