import type {Knex} from 'knex';
export async function up(db:Knex){
  if(await db.schema.hasColumn('sequence_steps','delay_seconds'))return;
  try{await db.schema.alterTable('sequence_steps',table=>{table.integer('delay_seconds').unsigned().nullable();});}
  catch(error){if((error as {code?:string}).code!=='ER_DUP_FIELDNAME')throw error;}
}
export async function down(db:Knex){if(await db.schema.hasColumn('sequence_steps','delay_seconds'))await db.schema.alterTable('sequence_steps',table=>table.dropColumn('delay_seconds'));}
