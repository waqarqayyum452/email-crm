import type { Knex } from 'knex';
export async function up(db: Knex) {
  const [columns]=await db.raw("SELECT COLLATION_NAME AS collation_name, CHARACTER_SET_NAME AS charset FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='contacts' AND COLUMN_NAME='id'");
  const c=columns[0];
  if(!c||![c.charset,c.collation_name].every(v=>typeof v==='string'&&/^[a-zA-Z0-9_]+$/.test(v)))throw new Error('Contacts schema required.');
  await db.raw(`CREATE TABLE IF NOT EXISTS prospect_segments (id varchar(36) CHARACTER SET ${c.charset} COLLATE ${c.collation_name} PRIMARY KEY, name varchar(100) NOT NULL, created_at datetime(3) NOT NULL) ENGINE=InnoDB`);
  await db.raw(`CREATE TABLE IF NOT EXISTS segment_contacts (segment_id varchar(36) CHARACTER SET ${c.charset} COLLATE ${c.collation_name} NOT NULL, contact_id varchar(36) CHARACTER SET ${c.charset} COLLATE ${c.collation_name} NOT NULL, PRIMARY KEY(segment_id,contact_id), FOREIGN KEY(segment_id) REFERENCES prospect_segments(id) ON DELETE CASCADE, FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE) ENGINE=InnoDB`);
  if(!await db.schema.hasColumn('imports','segment_id'))try{await db.schema.alterTable('imports',t=>t.string('segment_id',36).nullable());}catch(e){if((e as {code?:string}).code!=='ER_DUP_FIELDNAME')throw e;}
}
export async function down(db: Knex) {await db.schema.dropTableIfExists('segment_contacts');await db.schema.dropTableIfExists('prospect_segments');if(await db.schema.hasColumn('imports','segment_id'))await db.schema.alterTable('imports',t=>t.dropColumn('segment_id'));}
