import type { Knex } from 'knex';

export async function up(db: Knex) {
  const [columns]=await db.raw("SELECT COLLATION_NAME AS collation_name, CHARACTER_SET_NAME AS charset FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='contacts' AND COLUMN_NAME='id'");
  const column=columns[0];
  if(!column||![column.charset,column.collation_name].every(value=>typeof value==='string'&&/^[a-zA-Z0-9_]+$/.test(value)))throw new Error('Website lead storage requires the agency contacts schema.');
  await db.raw(`CREATE TABLE IF NOT EXISTS website_lead_receipts (
    id varchar(64) PRIMARY KEY, contact_id varchar(36) CHARACTER SET ${column.charset} COLLATE ${column.collation_name} NOT NULL,
    created_at datetime(3) NOT NULL, INDEX website_receipt_contact (contact_id),
    CONSTRAINT website_receipt_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await db.raw(`CREATE TABLE IF NOT EXISTS website_sync_state (
    id varchar(64) PRIMARY KEY, data json NOT NULL, updated_at datetime(3) NOT NULL
  ) ENGINE=InnoDB`);
}
export async function down(db: Knex) {
  await db.schema.dropTableIfExists('website_sync_state');
  await db.schema.dropTableIfExists('website_lead_receipts');
}
