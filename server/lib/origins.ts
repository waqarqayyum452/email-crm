function serializedOrigin(value:string):string|null {
  try {
    const url=new URL(value);
    return ['http:','https:'].includes(url.protocol)&&url.origin===value?url.origin:null;
  } catch {return null;}
}

/** Blank keeps APP_URL only; additional origins must be exact HTTP(S) origins. */
export function parseAllowedOrigins(value:string,appUrl:string):'*'|string[] {
  const app=new URL(appUrl);
  if(!['http:','https:'].includes(app.protocol))throw new Error('APP_URL must use HTTP or HTTPS');
  const setting=value.trim();
  if(setting==='*')return '*';
  const origins=setting?setting.split(',').map(origin=>origin.trim()):[];
  if(origins.some(origin=>!serializedOrigin(origin)))throw new Error('ALLOWED_ORIGINS must be * or comma-separated HTTP(S) origins without paths');
  return [...new Set([app.origin,...origins])];
}

export function isAllowedOrigin(origin:string,value:string,appUrl:string):boolean {
  if(!serializedOrigin(origin))return false;
  const allowed=parseAllowedOrigins(value,appUrl);
  return allowed==='*'||allowed.includes(origin);
}
