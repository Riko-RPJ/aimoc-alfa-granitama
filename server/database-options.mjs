import {X509Certificate} from 'node:crypto';

const sslUrlOptions=new Set(['ssl','sslmode','sslcert','sslkey','sslrootcert','sslnegotiation','uselibpqcompat']);

function certificateAuthority(value) {
  try {
    if(typeof value!=='string')throw new Error();
    const pem=value.trim(),certificates=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if(!certificates?.length||pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,'').trim())throw new Error();
    for(const certificate of certificates)if(!new X509Certificate(certificate).ca)throw new Error();
    return pem+'\n';
  } catch {
    throw new Error('DATABASE_SSL_CA_INVALID');
  }
}

export function databasePoolOptions(url,sslCa) {
  if(!url)throw new Error('DATABASE_NOT_CONFIGURED');
  const options={connectionString:url,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:15000};
  if(sslCa===undefined)return options;
  const ca=certificateAuthority(sslCa);
  let connection;
  try {
    if(typeof url!=='string')throw new Error();
    connection=new URL(url);
    if(!['postgres:','postgresql:'].includes(connection.protocol))throw new Error();
    decodeURIComponent(connection.username);decodeURIComponent(connection.password);
    const host=connection.searchParams.get('host')||decodeURIComponent(connection.hostname);
    if(!host||host.startsWith('/'))throw new Error();
  } catch {
    throw new Error('DATABASE_SSL_CA_REQUIRES_TCP_URL');
  }
  // pg parses connectionString after explicit options. These URL parameters can
  // replace the entire ssl object, including its CA and verification settings.
  for(const key of [...connection.searchParams.keys()])if(sslUrlOptions.has(key.toLowerCase()))connection.searchParams.delete(key);
  return {...options,connectionString:connection.toString(),ssl:{ca,rejectUnauthorized:true}};
}
