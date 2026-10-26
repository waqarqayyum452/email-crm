import type {Knex} from 'knex';
export async function up(db:Knex){
 const add=async(table:string,column:string,build:(t:Knex.CreateTableBuilder)=>void)=>{if(!await db.schema.hasColumn(table,column))try{await db.schema.alterTable(table,build);}catch(e){if((e as {code?:string}).code!=='ER_DUP_FIELDNAME')throw e;}};
 for(const table of ['sequence_steps','templates']){await add(table,'design',t=>{t.json('design').nullable();});await add(table,'preview_text',t=>{t.string('preview_text',300).nullable();});}
 await add('templates','email_type',t=>{t.string('email_type',20).nullable();});
 await add('messages','campaign_sender_name',t=>{t.string('campaign_sender_name',200).nullable();});await add('messages','campaign_reply_to',t=>{t.string('campaign_reply_to',254).nullable();});
 await db.raw('CREATE TABLE IF NOT EXISTS campaign_images (id varchar(64) PRIMARY KEY, content_type varchar(30) NOT NULL, encrypted_content longtext NOT NULL, size int NOT NULL, created_at datetime(3) NOT NULL) ENGINE=InnoDB');
}
export async function down(db:Knex){await db.schema.dropTableIfExists('campaign_images');for(const table of ['sequence_steps','templates'])for(const column of ['design','preview_text'])if(await db.schema.hasColumn(table,column))await db.schema.alterTable(table,t=>t.dropColumn(column));for(const [table,column] of [['templates','email_type'],['messages','campaign_sender_name'],['messages','campaign_reply_to']])if(await db.schema.hasColumn(table,column))await db.schema.alterTable(table,t=>t.dropColumn(column));}
