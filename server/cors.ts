import type { Request,Response,NextFunction } from './http.js';
import { config } from './config.js';
import { isAllowedOrigin } from './lib/origins.js';
import { HttpError } from './lib/util.js';

const methods=['GET','HEAD','POST','PATCH','DELETE','OPTIONS'];
const headers=['content-type','x-csrf-token'];

/** API-only CORS. Wildcards never share authenticated cookies across origins. */
export function apiCors(req:Request,res:Response,next:NextFunction) {
  res.vary('Origin');
  const origin=req.headers.origin;
  if(!origin)return next();
  if(!isAllowedOrigin(origin,config.allowedOrigins,config.appUrl))return next(new HttpError(403,'Request origin is not allowed.'));
  res.set('Access-Control-Allow-Origin',config.allowedOrigins.trim()==='*'?'*':origin);
  // Do not set Access-Control-Allow-Credentials: dashboard sessions stay same-origin.
  if(req.method!=='OPTIONS')return next();
  res.vary('Access-Control-Request-Method');
  res.vary('Access-Control-Request-Headers');
  const method=req.headers['access-control-request-method'];
  const requestedHeaders=req.headers['access-control-request-headers'];
  if(typeof method!=='string'||!methods.includes(method)||
    (requestedHeaders!==undefined&&(typeof requestedHeaders!=='string'||requestedHeaders.split(',').some(header=>!headers.includes(header.trim().toLowerCase()))))) {
    return next(new HttpError(403,'Cross-origin request method or headers are not allowed.'));
  }
  res.set('Access-Control-Allow-Methods',methods.join(', '));
  res.set('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token');
  res.set('Access-Control-Max-Age','600');
  res.status(204).end();
}
