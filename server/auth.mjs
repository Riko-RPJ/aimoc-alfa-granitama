import {randomBytes,scrypt as _scrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(_scrypt);
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const token=()=>randomBytes(32).toString('base64url');
export async function passwordHash(password) {
  if(typeof password!=='string'||password.length<12||password.length>200) throw Object.assign(new Error('Password minimal 12 karakter.'),{status:400,code:'INVALID_PASSWORD'});
  const salt=randomBytes(16).toString('hex');const derived=await scrypt(password,salt,32);
  return 'scrypt:'+salt+':'+derived.toString('hex');
}
export async function checkPassword(password,encoded) {
  if(typeof password!=='string'||password.length>200)return false;
  const [,salt,digest]=(encoded||'').split(':');
  const result=await scrypt(password,salt||'unknown-user-fixed-salt',32);
  return Boolean(digest&&digest.length===64&&timingSafeEqual(result,Buffer.from(digest,'hex')));
}
export function userView(row) {return {id:row.id,username:row.username,displayName:row.display_name,role:row.role,crusherIds:row.crusher_ids||[],jettyIds:row.jetty_ids||[],active:row.active};}
export function cookieValue(req){return /(?:^|;\s*)alfa_session=([A-Za-z0-9_-]{40,100})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
export const sessionCookie=(value,secure,maxAge=43200)=>`alfa_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
