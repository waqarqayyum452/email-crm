import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { authRouter,userRouter,loadSession,csrfProtect } from './auth.js';
import { settingsRouter,accountRouter } from './settings.js';
import { contactRouter,stageRouter,taskRouter,suppressionRouter } from './contacts.js';
import { importRouter } from './imports.js';
import { reportingRouter } from './reporting.js';
import { campaignRouter,templateRouter,inboxRouter } from './campaigns.js';
import { publicRouter } from './tracking.js';
import { runWorker } from './worker.js';
import { secureEqual } from './lib/crypto.js';
import { HttpError } from './lib/util.js';
import { apiCors } from './cors.js';

export function createApp() {
  const app=express();app.disable('x-powered-by');if(config.trustProxy)app.set('trust proxy',config.trustProxy);
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','https:'],connectSrc:["'self'"],frameSrc:["'self'"],frameAncestors:["'none'"],formAction:["'self'"],objectSrc:["'none'"],...(config.production?{}:{upgradeInsecureRequests:null})}},referrerPolicy:{policy:'no-referrer'}}));
  app.get('/healthz',(_req,res)=>res.json({ok:true}));
  // Public endpoints receive small bodies. No query string or request-body logging.
  app.use('/unsubscribe',express.urlencoded({extended:false,limit:'4kb'}));
  app.use(publicRouter);
  app.post('/internal/tick',express.json({limit:'1kb'}),async(req,res)=>{
    const auth=req.headers.authorization||'';
    if(!config.schedulerSecret||!secureEqual(auth,'Bearer '+config.schedulerSecret))throw new HttpError(401,'Unauthorized scheduler request.');
    res.set('Cache-Control','no-store');res.json(await runWorker({budgetMs:18000,maxJobs:10}));
  });
  app.use('/api',apiCors,express.json({limit:'2200kb'}),(_req,res,next)=>{res.set('Cache-Control','no-store');next();},loadSession,csrfProtect);
  app.use('/api/auth',authRouter);app.use('/api/users',userRouter);app.use('/api/settings',settingsRouter);app.use('/api/accounts',accountRouter);app.use('/api/contacts',contactRouter);app.use('/api/stages',stageRouter);app.use('/api/tasks',taskRouter);app.use('/api/suppressions',suppressionRouter);app.use('/api/imports',importRouter);app.use('/api/campaigns',campaignRouter);app.use('/api/templates',templateRouter);app.use('/api/inbox',inboxRouter);app.use('/api',reportingRouter);
  app.use('/api',(_req,_res,next)=>next(new HttpError(404,'API route not found.')));
  const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
  // In source this is project root; in dist it is dist, so normalize explicitly.
  const projectRoot=root.endsWith(path.sep+'dist')?path.dirname(root):root;
  app.use(express.static(path.join(projectRoot,'public'),{index:false}));
  app.use(express.static(path.join(projectRoot,'dist','client'),{index:false}));
  app.get('/{*path}',(req,res,next)=>{if(req.path.startsWith('/internal/'))return next(new HttpError(404,'Not found.'));res.sendFile(path.join(projectRoot,'dist','client','index.html'),err=>{if(err)next(new HttpError(404,'Frontend build missing. Run npm run build or use the Vite development server.'));});});
  app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(res.headersSent)return;
    if(err instanceof ZodError)return res.status(400).json({error:'Please correct the highlighted fields.',details:err.issues});
    if(err instanceof HttpError)return res.status(err.status).json({error:err.message,...(err.details?{details:err.details}:{})});
    if(err?.code==='ER_DUP_ENTRY')return res.status(409).json({error:'This record already exists. Refresh to see the latest state.'});
    if(err?.type==='entity.too.large')return res.status(413).json({error:'Request is too large. CSV limit is 2 MB.'});
    if(err instanceof SyntaxError&&'body' in err)return res.status(400).json({error:'Invalid JSON request.'});
    // Never emit SQL bindings, credentials, mail bodies, tokens or connection errors.
    console.error(JSON.stringify({level:'error',event:'request_failed',type:err?.name||'Error'}));
    res.status(500).json({error:'The operation could not be completed. Check database connectivity and system health.'});
  });return app;
}
