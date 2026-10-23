import type { Knex } from 'knex';

export async function up(db: Knex) {
  const [columns] = await db.raw("SELECT TABLE_NAME AS table_name, COLLATION_NAME AS collation_name, CHARACTER_SET_NAME AS charset FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('messages','users') AND COLUMN_NAME='id'");
  const keyType = (table: string) => {
    const column = columns.find((item: any) => item.table_name === table);
    if (!column || ![column.charset, column.collation_name].every(value => typeof value === 'string' && /^[a-zA-Z0-9_]+$/.test(value))) throw new Error('Inbox read state requires the agency schema.');
    return `varchar(36) CHARACTER SET ${column.charset} COLLATE ${column.collation_name}`;
  };
  await db.raw(`CREATE TABLE IF NOT EXISTS inbox_reads (
    user_id ${keyType('users')} NOT NULL, message_id ${keyType('messages')} NOT NULL, read_at datetime(3) NOT NULL,
    PRIMARY KEY (user_id, message_id),
    CONSTRAINT inbox_reads_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT inbox_reads_message_fk FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

export async function down(db: Knex) { await db.schema.dropTableIfExists('inbox_reads'); }
