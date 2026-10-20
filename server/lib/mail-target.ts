import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { HttpError } from './util.js';
export function isPublicAddress(address: string) {
  try { let parsed=ipaddr.parse(address); if(parsed.kind()==='ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed=(parsed as ipaddr.IPv6).toIPv4Address(); return parsed.range()==='unicast'; } catch { return false; }
}
export async function validateMailTarget(host: string, port: number, kind: 'smtp'|'imap') {
  if (!(kind==='smtp'?[465,587]:[993]).includes(port)) throw new HttpError(400,'Only SMTP 465/587 and IMAP 993 are allowed.');
  if (host.length>253 || !/^[a-zA-Z0-9.-]+$/.test(host) || !host.includes('.') || isIP(host) || host.endsWith('.') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host.toLowerCase())) throw new HttpError(400,'Use a valid public mail-server hostname.');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const addresses = await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new HttpError(400,'Mail server DNS lookup timed out.')),5000);timer.unref();})]).catch((err)=>{if(err instanceof HttpError)throw err;throw new HttpError(400,'Mail server could not be resolved.');}).finally(()=>clearTimeout(timer));
  if (!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) throw new HttpError(400,'Private, reserved, and internal mail servers are blocked.');
  return {...addresses[0],servername:host};
}
