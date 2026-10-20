import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../server/db.js';
import { hashPassword } from '../server/lib/crypto.js';
import { id, audit, normalizeEmail } from '../server/lib/util.js';
import { z } from 'zod';
async function secretPrompt() { if(!stdin.isTTY) throw new Error('Set OWNER_PASSWORD privately in the environment for noninteractive bootstrap.');stdout.write('Owner password (14+ characters, hidden): ');stdin.setRawMode(true);stdin.resume();return new Promise<string>((resolve,reject)=>{let value='';function data(b:Buffer){const s=b.toString();if(s==='\u0003'){cleanup();reject(new Error('Cancelled'));}else if(s==='\r'||s==='\n'){cleanup();stdout.write('\n');resolve(value);}else if(s==='\u007f'||s==='\b'){value=value.slice(0,-1);}else if(!/[\u0000-\u001f]/.test(s)){value+=s;}}function cleanup(){stdin.off('data',data);stdin.setRawMode(false);stdin.pause();}stdin.on('data',data);}); }
try {
  const prompts=createInterface({input:stdin,output:stdout});
  const email=process.env.OWNER_EMAIL||await prompts.question('Owner email: ');const name=process.env.OWNER_NAME||await prompts.question('Owner name: ');prompts.close();
  const password=process.env.OWNER_PASSWORD||await secretPrompt();
  const body=z.object({email:z.string().email(),name:z.string().min(1).max(150),password:z.string().min(14).max(128)}).parse({email,name,password});
  await db.transaction(async trx=>{
    // Serialize bootstrap even if two CLI invocations race.
    await trx('business_settings').where({id:'agency'}).forUpdate().first();
    if(await trx('users').where({role:'owner'}).first())throw new Error('An owner already exists. Bootstrap is disabled.');
    const userId=id();await trx('users').insert({id:userId,name:body.name,email:normalizeEmail(body.email),password_hash:await hashPassword(body.password),role:'owner',permissions:'[]',disabled:false,created_at:new Date(),updated_at:new Date()});await audit(userId,'owner_bootstrapped','user',userId,{},trx);
  });console.log('Owner created. Sign in through the dashboard. Remove OWNER_PASSWORD from your environment.');
}catch(err){console.error(err instanceof Error && /owner already|Bootstrap|Cancelled/.test(err.message)?err.message:'Bootstrap failed. Check database access and required email, name and password length.');process.exitCode=1;}finally{delete process.env.OWNER_PASSWORD;await db.destroy();}
