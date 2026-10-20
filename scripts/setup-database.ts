import { stdin, stdout } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { localConfig,setupLocalDatabase,setupErrorMessage,SetupError } from './lib/database-setup.js';

function hiddenPassword():Promise<string> {
  if(!stdin.isTTY)throw new SetupError('Run npm.cmd run db:setup in an interactive terminal. The root password is entered privately there.');
  stdout.write('MariaDB root password (typing is hidden): ');
  const previous=stdin.isRaw,decoder=new StringDecoder('utf8');stdin.setRawMode(true);stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    function cleanup(){stdin.off('data',onData);stdin.off('end',onEnd);stdin.off('error',onError);stdin.setRawMode(previous);stdin.pause();}
    function onEnd(){cleanup();reject(new SetupError('Password input ended. Run setup again in an interactive terminal.'));}
    function onError(){cleanup();reject(new SetupError('Password input failed. Run setup again in an interactive terminal.'));}
    function onData(data:Buffer|string){for(const char of typeof data==='string'?data:decoder.write(data)){
      if(char==='\u0003'){cleanup();stdout.write('\n');reject(new SetupError('Setup cancelled.'));return;}
      if(char==='\r'||char==='\n'){cleanup();stdout.write('\n');resolve(value);return;}
      if(char==='\u007f'||char==='\b'){value=Array.from(value).slice(0,-1).join('');continue;}
      if(!/[\u0000-\u001f]/.test(char)){value+=char;if(value.length>1024){cleanup();reject(new SetupError('Password input is too long.'));return;}}
    }}
    stdin.on('data',onData);stdin.on('end',onEnd);stdin.on('error',onError);
  });
}

try {
  const text=await readFile('.env','utf8'),values=parse(text),config=localConfig(values);
  if(['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','ENCRYPTION_KEY','SCHEDULER_SECRET'].some(key=>Object.hasOwn(process.env,key)&&process.env[key]!==values[key]))throw new SetupError('This terminal overrides CRM settings. Open a new terminal without database/security environment overrides and retry.');
  console.log(`Local CRM database setup: ${config.database} on ${config.host}:${config.port}.`);
  console.log('This updates the local CRM login and .env automatically. Existing tables and records are preserved.');
  console.log('Keep the CRM server stopped while this local setup command runs.');
  console.log('Enter the root password selected during MariaDB installation. It will not be displayed or saved.');
  await setupLocalDatabase({envPath:'.env',rootPassword:await hiddenPassword(),log:message=>console.log(message)});
}catch(error){console.error(setupErrorMessage(error));process.exitCode=1;}
