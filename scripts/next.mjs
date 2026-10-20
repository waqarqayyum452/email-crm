import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Hosting panels can export NODE_ENV=development before npm runs. Set the
// command's mode before Next or React is loaded, including prerender workers.
const command=process.argv[2];
if(!['dev','build','start'].includes(command)){
  console.error('Use scripts/next.mjs with dev, build, or start.');
  process.exitCode=1;
} else {
  process.env.NODE_ENV=command==='dev'?'development':'production';
  const cli=createRequire(import.meta.url).resolve('next/dist/bin/next');
  // Load in this process so signals and the server PID retain normal Next behavior.
  process.argv[1]=cli;
  await import(pathToFileURL(cli).href);
}
