import { isIP } from 'node:net';
import { z } from 'zod';
import { config,validateConfig } from './config.js';
import { authRouter,userRouter,loadSession,csrfProtect } from './auth.js';
import { settingsRouter,accountRouter } from './settings.js';
import { contactRouter,stageRouter,taskRouter,suppressionRouter } from './contacts.js';
import { segmentRouter } from './segments.js';
import { importRouter } from './imports.js';
import { reportingRouter } from './reporting.js';
import { campaignRouter,templateRouter,inboxRouter } from './campaigns.js';
import { mailToolsRouter } from './mail-tools.js';
import { publicRouter } from './tracking.js';
import { runWorker } from './worker.js';
import { secureEqual } from './lib/crypto.js';
import { HttpError } from './lib/util.js';
import { apiCors } from './cors.js';
import { activateLiveInbox,liveInboxStatus } from './lib/live-inbox.js';
import { installHostingerScheduler,SchedulerInstallError } from './lib/scheduler-install.js';
import { authorizeWebsiteLead,receiveWebsiteLead,syncWebsiteLeads } from './website-leads.js';
import { HttpResponse,requestContext,parseBody,runHandlers,errorResponse,nodeHandler } from './http.js';

const routes=[
  ['/api/auth',authRouter],['/api/users',userRouter],['/api/settings',settingsRouter],
  ['/api/segments',segmentRouter],['/api/accounts',accountRouter],['/api/contacts',contactRouter],['/api/stages',stageRouter],
  ['/api/tasks',taskRouter],['/api/suppressions',suppressionRouter],['/api/imports',importRouter],
  ['/api/campaigns',campaignRouter],['/api/templates',templateRouter],['/api/inbox',mailToolsRouter],['/api/inbox',inboxRouter],['/api',reportingRouter],
] as const;

function securityHeaders(res:HttpResponse){
  res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
    'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin',
    'X-DNS-Prefetch-Control':'off','X-Download-Options':'noopen','X-Permitted-Cross-Domain-Policies':'none',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; base-uri 'self'"});
  if(config.production)res.set('Strict-Transport-Security','max-age=15552000; includeSubDomains');
}
function clientIp(request:globalThis.Request,remoteAddress?:string){
  if(Number.isInteger(config.trustProxy)&&config.trustProxy>0){
    const addresses=request.headers.get('x-forwarded-for')?.split(',').map(value=>value.trim())||[];
    const candidate=addresses[addresses.length-config.trustProxy];
    if(candidate&&isIP(candidate))return candidate;
  }
  return remoteAddress&&isIP(remoteAddress)?remoteAddress:'unknown';
}

/** Shared native Web handler called directly by Next.js Node Route Handlers. */
export async function handleRequest(request:globalThis.Request,options?:{remoteAddress?:string}):Promise<globalThis.Response>{
  const req=requestContext(request,clientIp(request,options?.remoteAddress)),res=new HttpResponse();
  securityHeaders(res);
  try {
    if(req.path==='/healthz'&&['GET','HEAD'].includes(req.method)){res.json({ok:true});return res.toResponse(req.method);}
    try {validateConfig();}catch {throw new HttpError(503,'Server configuration is incomplete. Check private environment settings.');}
    if(req.path==='/api'||req.path.startsWith('/api/')){
      res.set('Cache-Control','no-store');
      await runHandlers([apiCors],req,res);
      if(res.headersSent)return res.toResponse(req.method);
      const mailUpload=/^\/api\/inbox\/(?:compose|drafts(?:\/[^/]+)?|[^/]+\/reply)\/?$/.test(req.path);
      await parseBody(request,req,mailUpload?8*1024*1024:2200*1024);
      await runHandlers([loadSession,csrfProtect],req,res);
      if(!res.headersSent){let matched=false;for(const [prefix,router] of routes){if(await router.dispatch(req,res,prefix)){matched=true;break;}}if(!matched)throw new HttpError(404,'API route not found.');}
    } else if(req.path==='/integrations/website/leads'&&req.method==='POST'){
      authorizeWebsiteLead(req.headers.authorization);
      await parseBody(request,req,24*1024);
      res.set('Cache-Control','no-store').status(201).json(await receiveWebsiteLead(req.body));
    } else if(req.path==='/internal/tick'&&req.method==='POST'){
      if(!config.schedulerSecret||!secureEqual(req.headers.authorization||'','Bearer '+config.schedulerSecret))throw new HttpError(401,'Unauthorized scheduler request.');
      await parseBody(request,req,1024);
      const command=z.object({action:z.enum(['run','status','install','activate-inbox']).default('run'),mode:z.enum(['all','sync','inbox']).default('all')}).strict().parse(req.body||{});
      let workerBudget=18000;
      if(command.action==='run'&&config.websiteLeadsUrl&&config.websiteLeadsSecret.length>=32){
        workerBudget=12000;
        try{await syncWebsiteLeads();}catch{console.warn(JSON.stringify({event:'website_lead_sync_failed'}));}
      }
      const result=command.action==='status'?await liveInboxStatus()
        :command.action==='install'?await installHostingerScheduler()
        :command.action==='activate-inbox'?await activateLiveInbox()
        :await runWorker({budgetMs:workerBudget,maxJobs:10,syncOnly:command.mode==='sync',inboxOnly:command.mode==='inbox'});
      res.set('Cache-Control','no-store').json(result);
    } else {
      if(req.path.startsWith('/unsubscribe/'))await parseBody(request,req,2048,'form');
      if(!await publicRouter.dispatch(req,res))throw new HttpError(404,'Not found.');
    }
  } catch(error){errorResponse(error instanceof SchedulerInstallError?new HttpError(503,error.message,{code:error.code}):error,res);}
  return res.toResponse(req.method);
}

/** Integration-test listener. Next.js owns the production HTTP server. */
export const createApp=()=>nodeHandler(handleRequest);
