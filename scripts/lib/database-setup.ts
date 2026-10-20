import { randomBytes } from 'node:crypto';
import { readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import mysql from 'mysql2/promise';

export class SetupError extends Error {}
export type LocalDatabaseConfig = {host:string;port:number;database:string;user:string};
type Connection = {query:(sql:string,values?:any[])=>Promise<any>;end:()=>Promise<void>};
type Connect = (options:Record<string,unknown>)=>Promise<Connection>;

export function localConfig(values:Record<string,string>):LocalDatabaseConfig {
  if(['DB_HOST','DB_PORT','DB_NAME','DB_USER'].some(key=>!values[key]?.trim()))throw new SetupError('Set DB_HOST, DB_PORT, DB_NAME, and DB_USER in .env before running local database setup.');
  const host=values.DB_HOST||'127.0.0.1',port=Number(values.DB_PORT||3306),database=values.DB_NAME||'email_crm',user=values.DB_USER||'email_crm';
  if(!['127.0.0.1','localhost','::1'].includes(host))throw new SetupError('This setup command supports a local database only. It cannot modify Hostinger or another remote server.');
  if(!Number.isInteger(port)||port<1||port>65535)throw new SetupError('DB_PORT must be a valid database port.');
  if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(database)||['mysql','sys','information_schema','performance_schema'].includes(database.toLowerCase()))throw new SetupError('Use a separate CRM database name containing letters, numbers, and underscores.');
  if(!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(user)||['root','mysql','sys','mariadb','mariadb_sys'].includes(user.toLowerCase()))throw new SetupError('DB_USER must be a dedicated CRM account, not the database administrator.');
  return {host,port,database,user};
}

export function supportedEngine(version:string):'mariadb'|'mysql' {
  const maria=version.replace(/^5\.5\.5-/,'').match(/^(\d+)\.(\d+)\.\d+/);
  if(/mariadb/i.test(version)) {
    if(!maria||Number(maria[1])<10||(Number(maria[1])===10&&Number(maria[2])<11))throw new SetupError('This CRM requires MariaDB 10.11+ or MySQL 8+.');
    return 'mariadb';
  }
  if(Number(version.match(/^(\d+)\./)?.[1]||0)<8)throw new SetupError('This CRM requires MariaDB 10.11+ or MySQL 8+.');
  return 'mysql';
}

export function setEnvValue(text:string,key:string,value:string) {
  // Generated values use base64/base64url, with no quotes, backslashes or line breaks.
  if(!/^[A-Z_]+$/.test(key)||!/^[-A-Za-z0-9_+/=]+$/.test(value))throw new SetupError('Invalid generated configuration value.');
  const newline=text.includes('\r\n')?'\r\n':'\n';
  const pattern=new RegExp('^[ \\t]*(?:export[ \\t]+)?'+key+'[ \\t]*=');
  let found=false;
  const lines=text.split(/\r?\n/).filter(line=>{if(!pattern.test(line))return true;if(found)return false;found=true;return true;}).map(line=>pattern.test(line)?key+'='+value:line);
  if(!found){if(lines.at(-1)==='')lines.pop();lines.push(key+'='+value,'');}
  return lines.join(newline);
}

export function grantDatabaseIdentifier(database:string,partialRevokes=false) {
  // Database-level GRANT treats _ and % as wildcards unless MySQL partial_revokes is on.
  return '`'+(partialRevokes?database:database.replace(/_/g,'\\_'))+'`';
}

function checkedCount(row:any):number {
  const value=row?.count;if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))throw new SetupError('Could not verify database state. No security key was replaced.');
  const count=Number(value);if(!Number.isSafeInteger(count)||count<0)throw new SetupError('Could not verify database state. No security key was replaced.');return count;
}

export function setupErrorMessage(error:unknown) {
  if(error instanceof SetupError)return error.message;
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  if(code==='ER_ACCESS_DENIED_ERROR')return 'The MariaDB root login was rejected. Run this command again and enter the root password chosen during MariaDB installation.';
  if(['ECONNREFUSED','ETIMEDOUT','ENOTFOUND'].includes(code))return 'Cannot reach the local database. Check that the MariaDB service is running and DB_HOST/DB_PORT match its settings.';
  if(['EACCES','EPERM','EBUSY'].includes(code))return 'Could not save the local configuration. Close other programs using the configuration file and retry.';
  if(code==='EEXIST')return 'A .env.setup-pending file already exists. Finish or review that local pending configuration before running setup again.';
  return 'Local database setup failed. No raw database error or credentials were printed. Check the database service and administrator permissions.';
}

export async function setupLocalDatabase(options:{envPath:string;rootPassword:string;connect?:Connect;log?:(message:string)=>void}) {
  const connect:Connect=options.connect||((c)=>mysql.createConnection(c));
  const log=options.log||(()=>{}),envPath=path.resolve(options.envPath),pending=envPath+'.setup-pending';
  const original=await readFile(envPath,'utf8');const values=parse(original),config=localConfig(values);
  const accountHosts=[config.host==='::1'?'::1':'127.0.0.1','localhost'];
  const admin=await connect({host:config.host,port:config.port,user:'root',password:options.rootPassword,connectTimeout:7000,multipleStatements:false});
  let staged=false,mutationStarted=false;
  try {
    const [[row]]=await admin.query('SELECT VERSION() AS version');const engine=supportedEngine(String(row.version));
    let partialRevokes=false;
    if(engine==='mysql'){const [[setting]]=await admin.query('SELECT @@GLOBAL.partial_revokes AS enabled');partialRevokes=Number(setting.enabled)===1;}
    const [[mailTable]]=await admin.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',[config.database,'email_accounts']);
    let encryptedMailboxes=false;
    if(checkedCount(mailTable)>0){
      // Any schema/read failure aborts instead of assuming that key rotation is safe.
      const [[state]]=await admin.query('SELECT COUNT(*) AS count FROM `'+config.database+'`.`email_accounts` WHERE smtp_secret IS NOT NULL OR imap_secret IS NOT NULL');
      encryptedMailboxes=checkedCount(state)>0;
    }
    const [accounts]=await admin.query('SELECT User, Host, plugin FROM mysql.user WHERE User = ? AND Host IN (?, ?)',[config.user,...accountHosts]);
    if(accounts.some((account:any)=>account.plugin&&!['mysql_native_password','caching_sha2_password','sha256_password'].includes(account.plugin)))throw new SetupError('The configured database user has a custom login method. Choose a separate CRM database user before running this helper.');
    const grantees=accountHosts.map(host=>`'${config.user}'@'${host}'`);
    const [globalGrants]=await admin.query('SELECT PRIVILEGE_TYPE FROM information_schema.user_privileges WHERE GRANTEE IN (?, ?) AND PRIVILEGE_TYPE <> ?',[...grantees,'USAGE']);
    if(globalGrants.length)throw new SetupError('The configured CRM user has server-wide privileges. Use a dedicated CRM account before running this helper.');
    const [[roles]]=engine==='mariadb'
      ? await admin.query('SELECT COUNT(*) AS count FROM mysql.roles_mapping WHERE User = ? AND Host IN (?, ?)',[config.user,...accountHosts])
      : await admin.query('SELECT COUNT(*) AS count FROM mysql.role_edges WHERE TO_USER = ? AND TO_HOST IN (?, ?)',[config.user,...accountHosts]);
    if(checkedCount(roles)>0)throw new SetupError('The configured CRM user has assigned database roles. Use a separate dedicated CRM account before running this helper.');
    if(encryptedMailboxes&&Buffer.from(values.ENCRYPTION_KEY||'','base64').length!==32)throw new SetupError('Saved mailbox credentials exist. Restore their original encryption key before changing configuration.');

    const password=randomBytes(32).toString('base64url');
    let updated=setEnvValue(original,'DB_PASSWORD',password);
    // This onboarding/recovery command rotates exposed local secrets. The mailbox
    // encryption key is preserved when existing ciphertext depends on it.
    updated=setEnvValue(updated,'SCHEDULER_SECRET',randomBytes(32).toString('base64'));
    if(!encryptedMailboxes)updated=setEnvValue(updated,'ENCRYPTION_KEY',randomBytes(32).toString('base64'));
    const file=await open(pending,'wx',0o600);staged=true;try{await file.writeFile(updated,'utf8');await file.sync();}finally{await file.close();}
    if(await readFile(envPath,'utf8')!==original)throw new SetupError('.env changed while setup was running. Save your edits and retry.');

    mutationStarted=true;
    await admin.query('CREATE DATABASE IF NOT EXISTS `'+config.database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    for(const host of accountHosts) {
      await admin.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?',[config.user,host,password]);
      await admin.query('ALTER USER ?@? IDENTIFIED BY ?',[config.user,host,password]);
      await admin.query('GRANT ALL PRIVILEGES ON '+grantDatabaseIdentifier(config.database,partialRevokes)+'.* TO ?@?',[config.user,host]);
    }
    let probe:Connection|undefined;
    try{probe=await connect({...config,password,connectTimeout:7000,multipleStatements:false});await probe.query('SELECT 1');}
    catch{throw new SetupError('The root login succeeded, but the new CRM login could not be verified. Its generated password is retained in .env.setup-pending; check local account permissions before continuing.');}
    finally{await probe?.end().catch(()=>{});}
    if(await readFile(envPath,'utf8')!==original)throw new SetupError('.env changed while setup was running. The generated configuration is retained in .env.setup-pending; merge it privately before continuing.');
    await rename(pending,envPath);staged=false;
    log('Database login verified. A matching CRM password was saved directly in .env.');
    log(encryptedMailboxes?'Scheduler secret replaced. Existing mailbox encryption key preserved; replacing it requires deliberate re-encryption.':'Fresh scheduler and encryption keys saved privately.');
    log('No existing database tables or records were deleted. Next run: npm.cmd run db:migrate');
    return {database:config.database,user:config.user,encryptionKeyPreserved:encryptedMailboxes};
  } catch(error) {
    if(staged&&mutationStarted)log('Generated configuration was retained privately in .env.setup-pending. Do not share it. If the password changed, use its DB_PASSWORD in .env before retrying; the root password was never saved.');
    else if(staged)await unlink(pending).catch(()=>{});
    throw error;
  } finally {await admin.end().catch(()=>{});}
}
