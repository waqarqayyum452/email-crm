import type { Knex } from 'knex';

export async function up(db: Knex) {
  const [columns] = await db.raw("SELECT COLLATION_NAME AS collation_name, CHARACTER_SET_NAME AS charset FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='messages' AND COLUMN_NAME='id'");
  const column = columns[0];
  if (!column || ![column.charset, column.collation_name].every(value => typeof value === 'string' && /^[a-zA-Z0-9_]+$/.test(value))) throw new Error('Inbox folders require the agency messages schema.');
  await db.raw(`CREATE TABLE IF NOT EXISTS inbox_spam (
    message_id varchar(36) CHARACTER SET ${column.charset} COLLATE ${column.collation_name} PRIMARY KEY,
    created_at datetime(3) NOT NULL,
    CONSTRAINT inbox_spam_message_fk FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

export async function down(db: Knex) { await db.schema.dropTableIfExists('inbox_spam'); }
