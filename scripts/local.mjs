import http from 'node:http';
import {createServer} from 'vite';
import {mkdir} from 'node:fs/promises';
import {createDatabase,createEmbeddedDatabase} from '../server/database.mjs';
import {createHandler} from '../server/handler.mjs';
import {createStagingApiHandler} from '../server/v1/staging-http.mjs';
import {bootstrap} from './setup.mjs';
import {provisionLocalDriverUat} from './local-driver-uat.mjs';
import {installLocalCrusherLocationMaster} from '../server/crusher-location-master.mjs';
import {installLocalTruckQrUat} from '../server/truck-qr-uat.mjs';
await mkdir('.local',{recursive:true});
const localEmbedded=!process.env.DATABASE_URL;
if(localEmbedded)process.env.AIMOC_LOCAL_TRUCK_CODE_UAT='1';
const db=localEmbedded?await createEmbeddedDatabase('.local/database'):createDatabase();
await bootstrap(db,'.local/access.json');
if(localEmbedded) await provisionLocalDriverUat(db,{localOnly:true});
if(localEmbedded) await installLocalCrusherLocationMaster(db);
if(process.env.AIMOC_LOCAL_TRUCK_CODE_UAT==='1') await installLocalTruckQrUat(db);
const stagingUrl=process.env.AIMOC_STAGING_DATABASE_URL;
let executionDb=null,api;
if(stagingUrl){
 if(process.env.DATABASE_URL)throw Error('LOCAL_STAGING_REQUIRES_LOCAL_LEGACY_DATABASE');
 const host=new URL(stagingUrl).hostname;
 if(host&&!['localhost','127.0.0.1','[::1]'].includes(host))
  throw Error('LOCAL_STAGING_DATABASE_MUST_BE_ON_THIS_MACHINE');
 executionDb=createDatabase(stagingUrl);
 const sourceSystem=process.env.AIMOC_STAGING_WIM_SOURCE;
 const sourceSecret=process.env.AIMOC_STAGING_WIM_SECRET;
 if(Boolean(sourceSystem)!==Boolean(sourceSecret))throw Error('LOCAL_STAGING_WIM_SOURCE_AND_SECRET_REQUIRED_TOGETHER');
 api=createStagingApiHandler({legacyDb:db,executionDb,
  sourceSecrets:sourceSystem?{[sourceSystem]:sourceSecret}:{}});
}else api=createHandler(db);
const vite=await createServer({server:{middlewareMode:true,host:'127.0.0.1'},appType:'spa'});
const server=http.createServer((req,res)=>req.url.startsWith('/api')?api(req,res):vite.middlewares(req,res));
server.listen(Number(process.env.PORT||4196),'127.0.0.1',()=>console.log('AIMOC local app: http://127.0.0.1:'+(process.env.PORT||4196)));
process.on('SIGINT',async()=>{server.close();await vite.close();await db.close();await executionDb?.close();process.exit(0);});
