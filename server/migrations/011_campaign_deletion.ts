import type {Knex} from 'knex';
export async function up(db:Knex){
  if(await db.schema.hasColumn('campaigns','deleted_at'))return;
  try{await db.schema.alterTable('campaigns',table=>{table.dateTime('deleted_at',{precision:3}).nullable().index();});}
  catch(error){if((error as {code?:string}).code!=='ER_DUP_FIELDNAME')throw error;}
}
export async function down(db:Knex){if(await db.schema.hasColumn('campaigns','deleted_at'))await db.schema.alterTable('campaigns',table=>table.dropColumn('deleted_at'));}
