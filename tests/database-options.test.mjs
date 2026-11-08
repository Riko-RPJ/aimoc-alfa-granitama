import test from 'node:test';
import assert from 'node:assert/strict';
import {rootCertificates} from 'node:tls';
import pg from 'pg';
import {databasePoolOptions} from '../server/database-options.mjs';
import {createDatabase} from '../server/database.mjs';

// Public certificates from Node's trust store; no private keys or DB access.
const ca=rootCertificates[0],secondCa=rootCertificates[1];
const url='postgresql://app:p%40ss@db.example.test:5432/aimoc?application_name=aimoc&connect_timeout=12';
const base={connectionString:url,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:15000};

test('absent optional CA preserves the exact existing pool options and Neon URL',()=>{
  assert.deepEqual(databasePoolOptions(url),base);
  const neon='postgresql://app:secret@ep-example.neon.tech/aimoc?sslmode=require&channel_binding=require';
  assert.deepEqual(databasePoolOptions(neon),{...base,connectionString:neon});
});

test('private CA survives pg parsing with full certificate verification and existing pool limits',()=>{
  const options=databasePoolOptions(url,ca),effective=new pg.Client(options).connectionParameters;
  assert.deepEqual(options,{...base,ssl:{ca:ca.trim()+'\n',rejectUnauthorized:true}});
  assert.deepEqual(effective.ssl,options.ssl);
  assert.equal(effective.host,'db.example.test');assert.equal(effective.port,5432);
  assert.equal(effective.database,'aimoc');assert.equal(effective.user,'app');assert.equal(effective.password,'p@ss');
  assert.equal(effective.application_name,'aimoc');assert.equal(effective.connect_timeout,15);
  assert.equal(Object.hasOwn(effective.ssl,'checkServerIdentity'),false,'Node retains its standard hostname check');
});

test('each conflicting URL SSL option cannot disable or replace the supplied CA',()=>{
  for(const query of ['sslmode=disable','sslmode=no-verify','sslmode=verify-ca&uselibpqcompat=true','ssl=0','ssl=false','ssl=no-verify','ssl=true','sslcert=/nonexistent/client.crt','sslkey=/nonexistent/client.key','sslrootcert=/nonexistent/root.crt','sslnegotiation=direct']){
    const options=databasePoolOptions(url+'&'+query,ca),effective=new pg.Client(options).connectionParameters;
    assert.deepEqual(effective.ssl,{ca:ca.trim()+'\n',rejectUnauthorized:true},query);
    assert.equal(new URL(options.connectionString).searchParams.get('application_name'),'aimoc');
  }
});

test('duplicate, encoded and mixed-case SSL parameters are removed together without losing other URL fields',()=>{
  const original=url+'&sslmode=no-verify&sslmode=disable&%73sl=0&SSLMODE=disable&options=-c%20statement_timeout%3D20000';
  const options=databasePoolOptions(original,ca),parsed=new URL(options.connectionString);
  assert.deepEqual([...parsed.searchParams.keys()],['application_name','connect_timeout','options']);
  const effective=new pg.Client(options).connectionParameters;
  assert.equal(effective.options,'-c statement_timeout=20000');assert.equal(effective.password,'p@ss');
  assert.equal(effective.ssl.rejectUnauthorized,true);assert.equal(effective.ssl.ca,ca.trim()+'\n');
});

test('libpq SSL environment defaults cannot weaken explicitly configured CA verification',()=>{
  const previous=process.env.PGSSLMODE;
  try {
    for(const mode of ['disable','no-verify']){
      process.env.PGSSLMODE=mode;
      const effective=new pg.Client(databasePoolOptions(url,ca)).connectionParameters;
      assert.deepEqual(effective.ssl,{ca:ca.trim()+'\n',rejectUnauthorized:true});
    }
  } finally {
    if(previous===undefined)delete process.env.PGSSLMODE;else process.env.PGSSLMODE=previous;
  }
});

test('public CA bundles and Windows PEM line endings are accepted',()=>{
  const bundle=ca.trim()+'\n'+secondCa.trim()+'\n';
  assert.equal(databasePoolOptions(url,bundle).ssl.ca,bundle);
  const windowsPem=ca.trim().replace(/\r?\n/g,'\r\n');
  assert.equal(databasePoolOptions(url,windowsPem).ssl.ca,windowsPem+'\n');
});

test('invalid, empty or mixed secret material fails before constructing a database connection without exposing input',()=>{
  for(const value of ['', '   ', null, false, {}, 'PRIVATE_SECRET', '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----', ca+'\n-----BEGIN PRIVATE KEY-----\nPRIVATE_SECRET\n-----END PRIVATE KEY-----',ca+'\nPRIVATE_SECRET']){
    assert.throws(()=>databasePoolOptions(url,value),{message:'DATABASE_SSL_CA_INVALID'});
    assert.throws(()=>createDatabase(url,value),error=>error.message==='DATABASE_SSL_CA_INVALID'&&!String(error.stack).includes('PRIVATE_SECRET'));
  }
});

test('CA mode requires a PostgreSQL TCP URL and rejects socket paths and malformed URLs without exposing credentials',()=>{
  for(const value of ['PRIVATE_SECRET', 'https://app:PRIVATE_SECRET@db.example.test/aimoc', 'postgresql:///aimoc', 'postgresql:///aimoc?host=/tmp', 'postgresql://%2Ftmp/aimoc', '/tmp aimoc', 'postgresql://app:PRIVATE_SECRET%ZZ@db.example.test/aimoc']){
    assert.throws(()=>databasePoolOptions(value,ca),error=>error.message==='DATABASE_SSL_CA_REQUIRES_TCP_URL'&&!String(error.stack).includes('PRIVATE_SECRET'));
  }
  const options=databasePoolOptions('postgresql:///aimoc?host=127.0.0.1&port=55436',ca);
  assert.equal(new pg.Client(options).connectionParameters.host,'127.0.0.1');
});

test('missing database configuration keeps its original failure even with optional CA present',()=>{
  for(const value of [undefined,'',null])assert.throws(()=>databasePoolOptions(value,ca),{message:'DATABASE_NOT_CONFIGURED'});
});

test('createDatabase reads optional CA from the server environment and rejects invalid configuration before any network call',()=>{
  const previous=process.env.DATABASE_SSL_CA;
  try {
    process.env.DATABASE_SSL_CA='PRIVATE_SECRET';
    assert.throws(()=>createDatabase(url),{message:'DATABASE_SSL_CA_INVALID'});
  } finally {
    if(previous===undefined)delete process.env.DATABASE_SSL_CA;else process.env.DATABASE_SSL_CA=previous;
  }
});
