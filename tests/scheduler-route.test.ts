import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('dotenv/config',()=>({}));
vi.mock('../server/db.js',()=>({db:vi.fn(()=>{throw new Error('Scheduler route tests cannot access a database');}),json:(v:any,f:any)=>v??f}));
vi.mock('../server/worker.js',()=>({runWorker:vi.fn(async()=>({processed:0})),requestSync:vi.fn(),retryFailedJobs:vi.fn(),reconcileAttempt:vi.fn()}));
vi.mock('../server/lib/live-inbox.js',()=>({activateLiveInbox:vi.fn(async()=>({activated:true})),liveInboxStatus:vi.fn(async()=>({paused:true}))}));
vi.mock('../server/lib/scheduler-install.js',async importOriginal=>({...await importOriginal<any>(),installHostingerScheduler:vi.fn(async()=>({installed:true}))}));
import { handleRequest } from '../server/app.js';
import { config } from '../server/config.js';
import { runWorker } from '../server/worker.js';
import { activateLiveInbox, liveInboxStatus } from '../server/lib/live-inbox.js';
import { installHostingerScheduler, SchedulerInstallError } from '../server/lib/scheduler-install.js';

beforeEach(()=>{
  vi.clearAllMocks();
  Object.assign(config,{port:3000,trustProxy:0,appUrl:'https://crm.example.test',allowedOrigins:'',encryptionKey:Buffer.alloc(32,7).toString('base64'),schedulerSecret:'isolated-scheduler-secret-'.padEnd(48,'x')});
});
function call(body:unknown,authorized=true) {
  return handleRequest(new Request('https://crm.example.test/internal/tick',{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+config.schedulerSecret}:{})},body:JSON.stringify(body)}));
}
describe('authenticated scheduler commands',()=>{
  it('rejects every action before execution without Bearer authentication',async()=>{
    for(const action of ['run','install','status','activate-inbox'])expect((await call({action},false)).status).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();expect(installHostingerScheduler).not.toHaveBeenCalled();expect(activateLiveInbox).not.toHaveBeenCalled();expect(liveInboxStatus).not.toHaveBeenCalled();
  });
  it('keeps receiving-only and Inbox workers explicitly scoped',async()=>{
    expect((await call({mode:'sync'})).status).toBe(200);
    expect(runWorker).toHaveBeenLastCalledWith({budgetMs:18000,maxJobs:10,syncOnly:true,inboxOnly:false});
    await call({mode:'inbox'});
    expect(runWorker).toHaveBeenLastCalledWith({budgetMs:18000,maxJobs:10,syncOnly:false,inboxOnly:true});
    await call({});
    expect(runWorker).toHaveBeenLastCalledWith({budgetMs:18000,maxJobs:10,syncOnly:false,inboxOnly:false});
  });
  it('rejects arbitrary paths, commands and invalid modes',async()=>{
    for(const body of [{mode:'shell'},{action:'install',path:'/tmp'},{action:'exec'},['run']])expect((await call(body)).status).toBe(400);
    expect(runWorker).not.toHaveBeenCalled();expect(installHostingerScheduler).not.toHaveBeenCalled();
  });
  it('never processes jobs while installing, activating or reporting status',async()=>{
    for(const action of ['install','status','activate-inbox']){
      const response=await call({action});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(runWorker).not.toHaveBeenCalled();expect(installHostingerScheduler).toHaveBeenCalledTimes(1);expect(activateLiveInbox).toHaveBeenCalledTimes(1);expect(liveInboxStatus).toHaveBeenCalledTimes(1);
  });
  it('returns only a fixed safe installer error code',async()=>{
    vi.mocked(installHostingerScheduler).mockRejectedValueOnce(new SchedulerInstallError('SCHEDULER_INSTALL_UNSAFE_PATH'));
    const response=await call({action:'install'});expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'Private scheduler path is unsafe.',details:{code:'SCHEDULER_INSTALL_UNSAFE_PATH'}});
  });
});
