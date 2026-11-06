/** Preserve application query parameters when Vercel rewrites /api/:path*. */
export function rewriteVercelApiUrl(value){
 const url=new URL(value,'https://local.invalid');
 const route=url.searchParams.get('route');
 if(!route)return value;
 url.searchParams.delete('route');
 const query=url.searchParams.toString();
 return '/api/'+route+(query?'?'+query:'');
}
