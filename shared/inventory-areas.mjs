/** Legacy `crushers` also carries system-managed receiving inventory areas. */
export const isPhysicalCrusher=area=>Boolean(area)&&area.kind!=='RECEIVING_AREA'&&area.production!==false;
export const isDispatchSourceArea=area=>isPhysicalCrusher(area)&&area.active===true&&area.sourceEligible!==false;
