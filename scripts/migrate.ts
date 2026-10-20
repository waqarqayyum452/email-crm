import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { db } from '../server/db.js';
// Knex MigrationSource works with TS in tsx and compiled JS in dist.
const directory=fileURLToPath(new URL('../server/migrations/',import.meta.url));
const source={async getMigrations(){return (await readdir(directory)).filter(n=>/^\d+.*\.(ts|js)$/.test(n)).sort();},getMigrationName(name:string){return name.replace(/\.(ts|js)$/, '');},async getMigration(name:string){return import(pathToFileURL(path.join(directory,name)).href);}};
try {const result=process.argv[2]==='rollback'?await db.migrate.rollback({migrationSource:source}):await db.migrate.latest({migrationSource:source});console.log('Migration batch:',result[0],result[1]);}catch{console.error('Migration failed. Verify MySQL connectivity and inspect migration status privately.');process.exitCode=1;}finally{await db.destroy();}
