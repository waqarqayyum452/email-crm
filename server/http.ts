import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { AuthUser } from './auth.js';
import { ZodError } from 'zod';
import { HttpError } from './lib/util.js';

export interface Request {
  method:string; path:string; headers:Record<string,string|undefined>;
  params:Record<string,string>; query:Record<string,string|string[]>; body:any; ip:string;
  user?:AuthUser; session?:{id:string;csrf_token:string};
  get:(name:string)=>string|undefined;
}
export type NextFunction=(error?:unknown)=>void;
export type Handler=(req:Request,res:HttpResponse,next:NextFunction)=>unknown|Promise<unknown>;
export type Response=HttpResponse;

/** Domain responses are converted once into native Web Responses by Next.js. */
export class HttpResponse {
  readonly headers=new Headers();
  statusCode=200;
  headersSent=false;
  private body:string|Uint8Array<ArrayBuffer>|null=null;
  status(value:number){this.statusCode=value;return this;}
  set(name:string|Record<string,string>,value?:string){
    if(typeof name==='string')this.headers.set(name,value??'');
    else for(const [key,item] of Object.entries(name))this.headers.set(key,item);
    return this;
  }
  append(name:string,value:string){this.headers.append(name,value);return this;}
  vary(name:string){const values=this.headers.get('Vary')?.split(',').map(value=>value.trim())||[];if(!values.some(value=>value.toLowerCase()===name.toLowerCase()))values.push(name);this.headers.set('Vary',values.join(', '));return this;}
  type(value:string){return this.set('Content-Type',({html:'text/html; charset=utf-8',json:'application/json; charset=utf-8',text:'text/plain; charset=utf-8'} as Record<string,string>)[value]||value);}
  json(value:unknown){this.type('json');this.body=JSON.stringify(value);this.headersSent=true;return this;}
  send(value:string|Uint8Array){if(!this.headers.has('Content-Type'))this.type(typeof value==='string'?'html':'application/octet-stream');this.body=typeof value==='string'?value:new Uint8Array(value);this.headersSent=true;return this;}
  redirect(status:number,location:string){this.status(status).set('Location',location);return this.end();}
  end(){this.headersSent=true;return this;}
  toResponse(method='GET'):globalThis.Response{return new globalThis.Response(method==='HEAD'||[204,205,304].includes(this.statusCode)?null:this.body,{status:this.statusCode,headers:this.headers});}
}

export async function runHandlers(handlers:Handler[],req:Request,res:HttpResponse):Promise<void> {
  for(const handler of handlers){
    let called=false,error:unknown;
    await handler(req,res,(value?:unknown)=>{if(called)throw new Error('Middleware continued twice');called=true;error=value;});
    if(error!==undefined)throw error;
    if(res.headersSent||!called)return;
  }
}

type Route={method:string;pattern:RegExp;names:string[];handlers:Handler[]};
const escapePattern=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function compilePath(path:string){
  const names:string[]=[];
  const pattern=path==='/'?'':path.replace(/\/$/,'').split('/').map(segment=>{
    const param=segment.match(/^:([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
    if(!param)return escapePattern(segment);
    names.push(param[1]);return '([^/]+?)'+escapePattern(param[2]);
  }).join('/');
  return {pattern:new RegExp('^'+pattern+'/?$'),names};
}
export class DomainRouter {
  private middleware:Handler[]=[];
  private routes:Route[]=[];
  use(...handlers:Handler[]){this.middleware.push(...handlers);return this;}
  private add(method:string,path:string,handlers:Handler[]){this.routes.push({method,...compilePath(path),handlers:[...this.middleware,...handlers]});return this;}
  get(path:string,...handlers:Handler[]){return this.add('GET',path,handlers);}
  post(path:string,...handlers:Handler[]){return this.add('POST',path,handlers);}
  patch(path:string,...handlers:Handler[]){return this.add('PATCH',path,handlers);}
  async dispatch(req:Request,res:HttpResponse,prefix=''):Promise<boolean>{
    if(prefix&&req.path!==prefix&&!req.path.startsWith(prefix+'/'))return false;
    const relative=req.path.slice(prefix.length)||'/';
    for(const route of this.routes){
      if(route.method!==req.method&&!(req.method==='HEAD'&&route.method==='GET'))continue;
      const match=route.pattern.exec(relative);if(!match)continue;
      req.params=Object.create(null);
      try {route.names.forEach((name,index)=>{req.params[name]=decodeURIComponent(match[index+1]);});}
      catch {throw new HttpError(400,'Invalid request path.');}
      await runHandlers(route.handlers,req,res);
      if(!res.headersSent)throw new HttpError(500,'The operation could not be completed.');
      return true;
    }
    return false;
  }
}
export const Router=()=>new DomainRouter();

export function requestContext(request:globalThis.Request,ip='unknown'):Request {
  const url=new URL(request.url),headers:Record<string,string>=Object.create(null),query:Record<string,string|string[]>=Object.create(null);
  request.headers.forEach((value,key)=>{headers[key.toLowerCase()]=value;});
  for(const name of new Set(url.searchParams.keys())){const values=url.searchParams.getAll(name);query[name]=values.length===1?values[0]:values;}
  return {method:request.method.toUpperCase(),path:url.pathname,headers,query,params:Object.create(null),body:undefined,ip,get:(name)=>headers[name.toLowerCase()]};
}

export async function parseBody(request:globalThis.Request,req:Request,limit:number,format:'json'|'form'='json') {
  if(['GET','HEAD','OPTIONS'].includes(req.method)||!request.body)return;
  const encoding=request.headers.get('content-encoding');
  if(encoding&&encoding!=='identity')throw new HttpError(415,'Compressed request bodies are not supported.');
  const length=request.headers.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>limit)throw new HttpError(413,'Request is too large. CSV limit is 2 MB.');
  const reader=request.body.getReader(),chunks:Uint8Array[]= [];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new HttpError(413,'Request is too large. CSV limit is 2 MB.');}chunks.push(value);}
  } finally {reader.releaseLock();}
  const content=Buffer.concat(chunks).toString('utf8'),type=request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(format==='json'&&type==='application/json'){
    try {const body=content?JSON.parse(content):{};if(!body||typeof body!=='object')throw new Error('Invalid JSON');req.body=body;}
    catch {throw new HttpError(400,'Invalid JSON request.');}
  } else if(format==='form'&&type==='application/x-www-form-urlencoded') {
    const form=new URLSearchParams(content);req.body=Object.create(null);
    for(const name of new Set(form.keys())){const values=form.getAll(name);req.body[name]=values.length===1?values[0]:values;}
  }
}

export function errorResponse(error:unknown,res:HttpResponse){
  if(res.headersSent)return;
  if(error instanceof ZodError){res.status(400).json({error:'Please correct the highlighted fields.',details:error.issues});return;}
  if(error instanceof HttpError){res.status(error.status).json({error:error.message,...(error.details?{details:error.details}:{})});return;}
  if((error as {code?:string})?.code==='ER_DUP_ENTRY'){res.status(409).json({error:'This record already exists. Refresh to see the latest state.'});return;}
  console.error(JSON.stringify({level:'error',event:'request_failed',type:error instanceof Error?error.name:'Error'}));
  res.status(500).json({error:'The operation could not be completed. Check database connectivity and system health.'});
}

/** Node adapter for integration fixtures; production uses native Next Route Handlers. */
export function nodeHandler(handle:(request:globalThis.Request,options?:{remoteAddress?:string})=>Promise<globalThis.Response>):RequestListener {
  return (incoming:IncomingMessage,outgoing:ServerResponse)=>{void(async()=>{
    const chunks:Buffer[]=[];let size=0;
    try {
      for await(const chunk of incoming){size+=chunk.length;if(size>2200*1024)throw new HttpError(413,'Request is too large. CSV limit is 2 MB.');chunks.push(Buffer.from(chunk));}
      const headers=new Headers();for(const [name,value] of Object.entries(incoming.headers)){if(Array.isArray(value))for(const item of value)headers.append(name,item);else if(value!==undefined)headers.set(name,value);}
      const method=incoming.method||'GET',body=chunks.length&&!['GET','HEAD'].includes(method)?new Uint8Array(Buffer.concat(chunks)):undefined;
      const request=new globalThis.Request(new URL(incoming.url||'/','http://localhost'),{method,headers,body});
      const response=await handle(request,{remoteAddress:incoming.socket.remoteAddress});
      outgoing.statusCode=response.status;response.headers.forEach((value,name)=>{if(name!=='set-cookie')outgoing.setHeader(name,value);});
      const cookies=response.headers.getSetCookie();if(cookies.length)outgoing.setHeader('Set-Cookie',cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch(error){const response=new HttpResponse();errorResponse(error,response);outgoing.statusCode=response.statusCode;outgoing.setHeader('Content-Type','application/json; charset=utf-8');outgoing.end(await response.toResponse().text());}
  })();};
}
