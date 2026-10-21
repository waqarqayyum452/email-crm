import { runWorker } from '../server/worker.js';
import { validateConfig } from '../server/config.js';
import { db } from '../server/db.js';
try {
  const args=process.argv.slice(2);
  if(args.length>1||args.some(arg=>!['--sync-only','--inbox-only'].includes(arg))) {
    console.error('Usage: npm.cmd run worker:once [-- --sync-only|--inbox-only]');
    process.exitCode=1;
  } else {
    validateConfig();
    console.log(JSON.stringify(await runWorker({budgetMs:18000,maxJobs:10,syncOnly:args.includes('--sync-only'),inboxOnly:args.includes('--inbox-only')})));
  }
} catch {
  console.error('Worker failed. Review sanitized system health and database connectivity.');
  process.exitCode=1;
} finally {await db.destroy();}
