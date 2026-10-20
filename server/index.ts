import { createApp } from './app.js';
import { config,validateConfig } from './config.js';
import { db } from './db.js';
validateConfig();
const server=createApp().listen(config.port,'0.0.0.0',()=>console.log(`CRM listening on port ${config.port}. Live send: ${config.liveSendEnabled?'enabled':'disabled'}.`));
const shutdown=()=>{server.close(()=>{void db.destroy().finally(()=>process.exit(0));});setTimeout(()=>process.exit(1),10000).unref();};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
