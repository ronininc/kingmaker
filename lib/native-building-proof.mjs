// Original bounded cuboid architecture, independent of any source asset.
export function createBuildingProof(){
 const parts=[{name:'body',center:[0,0,0],size:[.9,1.2,.7],color:[.13,.23,.3]},{name:'roof',center:[0,.64,0],size:[1.02,.12,.82],color:[.055,.075,.09]},{name:'plinth',center:[0,-.65,0],size:[1.15,.1,.95],color:[.3,.32,.34]}];
 for(const side of [-1,1])for(const y of [-.25,.2])for(const z of [-.19,.19])parts.push({name:`side-window-${side}-${y}-${z}`,center:[side*.456,y,z],size:[.018,.22,.17],color:[.12,.7,.95]});
 for(const side of [-1,1])for(const y of [-.25,.2])for(const x of [-.23,.23])parts.push({name:`front-window-${side}-${y}-${x}`,center:[x,y,side*.356],size:[.22,.22,.018],color:[.12,.7,.95]});
 return {schema:'kingmaker.original-building/1',coordinates:'Y-up',provenance:'Original cuboid building with independently generated windows and flat roof; no external assets.',parts};
}
export function createNeoOutlawBar(){
 const parts=[];const box=(name,center,size,color)=>parts.push({name,center,size,color});
 const wood=[.25,.10,.035],dark=[.055,.025,.012],cyan=[.02,.9,1],pink=[1,.015,.22];
 box('timber-saloon',[0,-.05,0],[1.15,1.05,.85],wood);
 box('western-false-front',[0,.58,.45],[1.3,.3,.09],wood);
 box('flat-roof',[0,.51,0],[1.26,.08,.96],dark);
 box('porch-deck',[0,-.62,.6],[1.5,.1,.6],wood);
 for(const x of [-.65,.65])box('porch-post',[x,-.13,.79],[.065,.94,.065],wood);
 box('porch-awning',[0,.34,.65],[1.5,.08,.5],dark);
 for(const x of [-.11,.11])box('swing-door',[x,-.24,.44],[.19,.42,.035],dark);
 for(const x of [-.41,.41])box('window',[x,-.03,.44],[.22,.3,.03],[.04,.18,.22]);
 for(const y of [-.5,-.35,-.2,-.05,.1,.25,.4])box('timber-course',[0,y,-.43],[1.16,.018,.012],dark);
 box('neon-cyan-awning',[0,.37,.91],[1.45,.025,.025],cyan);
 box('neon-magenta-roof',[0,.75,.51],[1.32,.024,.024],pink);
 box('cyber-data-panel',[.52,-.14,.49],[.16,.28,.025],[.015,.07,.1]);
 for(const y of [-.22,-.16,-.1,-.04])box('data-line',[.52,y,.51],[.12,.012,.009],cyan);
 parts.push({name:'NEO OUTLAW',type:'text',center:[-.5,.55,.505],size:[.14,.14,.14],color:cyan});
 for(const x of [-.47,.47]){
  for(const dx of [-.12,.12])parts.push({name:'bike-wheel',type:'wheel',center:[x+dx,-.59,1.0],size:[.085,.085,.035],color:[.015,.015,.02]});
  box('bike-frame',[x,-.49,1.0],[.25,.04,.04],[.2,.25,.3]);box('bike-seat',[x,-.44,1.0],[.13,.04,.07],dark);box('bike-handle',[x+.12,-.4,1.0],[.025,.15,.025],cyan);
 }
 for(const p of parts){p.center=p.center.map(v=>v*.75);p.size=p.size.map(v=>v*.75);}
 return {schema:'kingmaker.original-building/1',coordinates:'Y-up',front:'+Z',provenance:'Original primitive Western saloon plus independently authored cybertech and motorcycle silhouettes; no external assets.',components:['timber facade','porch','swing doors','neon trim','data panel','two motorcycle silhouettes'],parts};
}
