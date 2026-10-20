import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { parse, serialize } from 'cookie';
import { z } from 'zod';
import { db, json } from './db.js';
import { config } from './config.js';
import { secureEqual, verifyPassword, hashPassword } from './lib/crypto.js';
import { HttpError, id, sha256, audit, normalizeEmail } from './lib/util.js';
import { isAllowedOrigin } from './lib/origins.js';

export type AuthUser = { id:string; name:string; email:string; role:string; permissions:string[] };
declare global { namespace Express { interface Request { user?:AuthUser; session?:{id:string;csrf_token:string}; } } }
const COOKIE = 'sdwe_session', CSRF = 'sdwe_csrf';
let passwordWork=0;
async function passwordCheck(work:()=>Promise<boolean>) { if(passwordWork>=2)throw new HttpError(429,'Sign-in is busy. Please try again shortly.');passwordWork++;try{return await work();}finally{passwordWork--;} }
function cookie(name:string,value:string,maxAge:number) { return serialize(name,value,{httpOnly:true,secure:config.production,sameSite:'strict',path:'/',maxAge}); }
export const permissions = ['settings:write','contacts:write','campaigns:write','inbox:write','system:write'];
export const publicUser = (u:any):AuthUser => ({id:u.id,name:u.name,email:u.email,role:u.role,permissions:json(u.permissions,[])});
export function can(user:AuthUser|undefined,permission:string) { return !!user && (user.role==='owner'||user.permissions.includes(permission)); }
export async function loadSession(req:Request,_res:Response,next:NextFunction) {
  try {
    const token=parse(req.headers.cookie||'')[COOKIE];
    if(token && /^[a-f0-9]{64}$/.test(token)) {
      const s=await db('sessions').where({token_hash:sha256(token)}).where('expires_at','>',new Date()).first();
      if(s) { const u=await db('users').where({id:s.user_id,disabled:false}).first(); if(u) {req.user=publicUser(u);req.session={id:s.id,csrf_token:s.csrf_token};} }
    }
    next();
  } catch(err) {next(err);}
}
export function requireUser(req:Request,_res:Response,next:NextFunction) { if(!req.user) return next(new HttpError(401,'Please sign in.')); next(); }
export function permit(permission:string) { return (req:Request,_res:Response,next:NextFunction)=>{ if(!req.user) return next(new HttpError(401,'Please sign in.')); if(!can(req.user,permission)) return next(new HttpError(403,'You do not have permission for this action.'));next(); }; }
export function ownerOnly(req:Request,_res:Response,next:NextFunction) { if(!req.user) return next(new HttpError(401,'Please sign in.')); if(req.user.role!=='owner') return next(new HttpError(403,'Only the owner can manage team access.')); next(); }
export function csrfProtect(req:Request,_res:Response,next:NextFunction) {
  if(['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin=req.headers.origin;
  if(origin && !isAllowedOrigin(origin,config.allowedOrigins,config.appUrl)) return next(new HttpError(403,'Request origin is not allowed.'));
  const token=req.headers['x-csrf-token']; const expected=req.session?.csrf_token || parse(req.headers.cookie||'')[CSRF];
  if(typeof token!=='string'||!expected||token.length!==64||!secureEqual(token,expected)) return next(new HttpError(403,'Your security token expired. Refresh and try again.'));
  next();
}
export async function consumeRateLimit(key:string,limit=10,windowMs=15*60*1000) {
  return db.transaction(async trx=>{
    const now=new Date();
    await trx('rate_limits').insert({key,hits:0,reset_at:new Date(now.getTime()+windowMs)}).onConflict('key').ignore();
    const row=await trx('rate_limits').where({key}).forUpdate().first();
    const expired=new Date(row.reset_at).getTime()<=now.getTime();
    if(!expired && row.hits>=limit) throw new HttpError(429,'Too many attempts. Please try again later.');
    await trx('rate_limits').where({key}).update({hits:expired?1:row.hits+1,...(expired?{reset_at:new Date(now.getTime()+windowMs)}:{})});
  });
}
export const authRouter=Router();
authRouter.get('/session',(req,res)=>{ const csrf=req.session?.csrf_token||randomBytes(32).toString('hex'); if(!req.session) res.append('Set-Cookie',cookie(CSRF,csrf,3600)); res.set('Cache-Control','no-store').json({user:req.user||null,csrfToken:csrf}); });
const loginSchema=z.object({email:z.string().email().max(254),password:z.string().min(1).max(1024)});
authRouter.post('/login',async(req,res)=>{
  const {email,password}=loginSchema.parse(req.body);const normalized=normalizeEmail(email);
  await consumeRateLimit('login-ip:'+sha256(req.ip||'unknown'),20);
  await consumeRateLimit('login-email:'+sha256(normalized),10);
  const user=await db('users').where({email:normalized,disabled:false}).first();
  // Perform the same expensive hash even for an unknown account.
  const valid=await passwordCheck(async()=>user ? await verifyPassword(password,user.password_hash) : !!(await hashPassword(password)) && false);
  if(!valid) throw new HttpError(401,'Email or password is incorrect.');
  const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  await db.transaction(async trx=>{
    if(req.session) await trx('sessions').where({id:req.session.id}).delete();
    await trx('sessions').insert({id:id(),token_hash:sha256(token),user_id:user.id,csrf_token:csrf,created_at:new Date(),expires_at:new Date(Date.now()+config.sessionHours*3600000)});
    await audit(user.id,'login','user',user.id,{},trx);
  });
  res.append('Set-Cookie',cookie(COOKIE,token,config.sessionHours*3600));res.append('Set-Cookie',cookie(CSRF,'',0));res.json({user:publicUser(user),csrfToken:csrf});
});
authRouter.post('/logout',requireUser,async(req,res)=>{await db('sessions').where({id:req.session!.id}).delete();res.append('Set-Cookie',cookie(COOKIE,'',0));res.json({ok:true});});
authRouter.post('/password',requireUser,async(req,res)=>{
  const body=z.object({current_password:z.string().max(1024),password:z.string().min(14).max(128)}).parse(req.body);
  const row=await db('users').where({id:req.user!.id}).first();if(!await verifyPassword(body.current_password,row.password_hash)) throw new HttpError(400,'Current password is incorrect.');
  await db.transaction(async trx=>{await trx('users').where({id:row.id}).update({password_hash:await hashPassword(body.password),updated_at:new Date()});await trx('sessions').where({user_id:row.id}).whereNot({id:req.session!.id}).delete();await audit(row.id,'password_changed','user',row.id,{},trx);});res.json({ok:true});
});
export const userRouter=Router();userRouter.use(requireUser);
userRouter.get('/',async(_req,res)=>res.json({items:(await db('users').select('id','name','email','role','permissions','disabled').orderBy('name')).map(u=>({...publicUser(u),disabled:!!u.disabled}))}));
userRouter.post('/',ownerOnly,async(req,res)=>{
  const body=z.object({name:z.string().min(1).max(150),email:z.string().email().max(254),password:z.string().min(14).max(128),permissions:z.array(z.enum(permissions as [string,...string[]])).default([])}).parse(req.body);
  const user={id:id(),name:body.name,email:normalizeEmail(body.email),password_hash:await hashPassword(body.password),role:'member',permissions:JSON.stringify(body.permissions),disabled:false,created_at:new Date(),updated_at:new Date()};
  await db.transaction(async trx=>{await trx('users').insert(user);await audit(req.user!.id,'team_member_created','user',user.id,{email:user.email,permissions:body.permissions},trx);});res.status(201).json(publicUser(user));
});
userRouter.patch('/:id',ownerOnly,async(req,res)=>{
  const body=z.object({permissions:z.array(z.enum(permissions as [string,...string[]])).optional(),disabled:z.boolean().optional()}).parse(req.body);
  const u=await db('users').where({id:req.params.id}).first();if(!u)throw new HttpError(404,'User not found.');if(u.role==='owner')throw new HttpError(400,'Owner access cannot be disabled.');
  await db.transaction(async trx=>{await trx('users').where({id:u.id}).update({...body,...(body.permissions?{permissions:JSON.stringify(body.permissions)}:{}),updated_at:new Date()});if(body.disabled)await trx('sessions').where({user_id:u.id}).delete();await audit(req.user!.id,'team_access_changed','user',u.id,body,trx);});res.json({ok:true});
});
