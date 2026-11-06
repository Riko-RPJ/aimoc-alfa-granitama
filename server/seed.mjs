/** Clearly labelled, editable UAT master data. No synthetic live movements. */
export function createSeed() {
  const createdAt = new Date().toISOString();
  const products = [
    ['abu-batu','AB-00','Abu batu','0–5 mm',1.5],
    ['split-05','SP-05','Batu split 0.5','5–10 mm',1.5],
    ['split-12','SP-12','Batu split 1/2','10–20 mm',1.5],
    ['split-23','SP-23','Batu split 2/3','20–30 mm',1.5],
    ['split-35','SP-35','Batu split 3/5','30–50 mm',1.5],
    ['basecourse','BC-A','Base course A','Gradasi campuran',1.65],
  ].map(([id,code,name,sizeMm,densityTPerM3])=>({id,code,name,sizeMm,densityTPerM3,active:true}));
  const crushers = [1,2].map(n=>({id:`crusher-${n}`,code:`CR-0${n}`,name:`Crusher ${n}`,active:true}));
  const stockpiles = crushers.flatMap((c,ci)=>products.map((p,pi)=>({id:`stock-${ci+1}-${pi+1}`,code:`SP-C${ci+1}-${String(pi+1).padStart(2,'0')}`,crusherId:c.id,skuId:p.id,onHandM3:650+ci*140+pi*85,reservedM3:0,active:true})));
  const trucks = Array.from({length:12},(_,i)=>({id:`truck-${i+1}`,code:`DT-${String(i+1).padStart(3,'0')}`,plate:`INTERNAL ${String(i+1).padStart(3,'0')}`,bedM3:[28,30,32][i%3],payloadLimitT:[42,45,48][i%3],cycleMinutes:30,active:true}));
  const jetties = [1,2].map(n=>({id:`jetty-${n}`,code:`JT-0${n}`,name:`Jetty ${n}`,active:true}));
  const vessels = [
    {id:'vessel-1',code:'BG-DEMO-01',name:'Tongkang Demo 300 ft',jettyId:'jetty-1',payloadLimitT:6500,loadedT:0,reservedT:0,status:'loading'},
    {id:'vessel-2',code:'BG-DEMO-02',name:'Tongkang Demo 270 ft',jettyId:'jetty-1',payloadLimitT:4500,loadedT:0,reservedT:0,status:'waiting'},
    {id:'vessel-3',code:'BG-DEMO-03',name:'Tongkang Demo 330 ft',jettyId:'jetty-2',payloadLimitT:8500,loadedT:0,reservedT:0,status:'loading'},
  ];
  return {schemaVersion:1,revision:0,createdAt,updatedAt:createdAt,dataMode:'UAT — data awal contoh, bukan telemetri lapangan',products,crushers,stockpiles,trucks,jetties,vessels,requests:[],dispatches:[],trips:[],measurements:[],inventoryLedger:[],events:[],erpOutbox:[]};
}
