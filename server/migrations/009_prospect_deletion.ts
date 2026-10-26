import type { Knex } from 'knex';
export async function up(db:Knex){if(await db.schema.hasColumn('contacts','deleted_at'))return;try{await db.schema.alterTable('contacts',t=>{t.dateTime('deleted_at',{precision:3}).nullable().index();});}catch(error){if((error as {code?:string}).code!=='ER_DUP_FIELDNAME')throw error;}}
export async function down(db:Knex){if(await db.schema.hasColumn('contacts','deleted_at'))await db.schema.alterTable('contacts',t=>t.dropColumn('deleted_at'));}
