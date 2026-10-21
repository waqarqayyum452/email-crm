import type { Knex } from 'knex';

// Additive and idempotent: existing mail, jobs and credentials are untouched.
export async function up(knex: Knex) {
  const [columns]=await knex.raw("SELECT TABLE_NAME AS table_name, COLLATION_NAME AS collation_name, CHARACTER_SET_NAME AS charset FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('messages','users') AND COLUMN_NAME='id'");
  const keyType=(table:string)=>{const column=columns.find((column:any)=>column.table_name===table);if(!column||![column.charset,column.collation_name].every(value=>typeof value==='string'&&/^[a-zA-Z0-9_]+$/.test(value)))throw new Error('Mail storage requires the existing agency schema.');return `varchar(36) CHARACTER SET ${column.charset} COLLATE ${column.collation_name}`;};
  await knex.raw(`CREATE TABLE IF NOT EXISTS message_details (
    message_id ${keyType('messages')} PRIMARY KEY, from_name varchar(200) NOT NULL DEFAULT '', to_name varchar(200) NOT NULL DEFAULT '',
    attachments longtext NOT NULL, attachment_manifest longtext NOT NULL, created_at datetime(3) NOT NULL,
    CONSTRAINT mail_details_message_fk FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await knex.raw(`CREATE TABLE IF NOT EXISTS mail_drafts (
    id varchar(36) PRIMARY KEY, user_id ${keyType('users')} NOT NULL, encrypted_content longtext NOT NULL, summary longtext NOT NULL, updated_at datetime(3) NOT NULL,
    INDEX mail_drafts_user_updated (user_id, updated_at),
    CONSTRAINT mail_drafts_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}
export async function down(knex: Knex) { await knex.schema.dropTableIfExists('mail_drafts'); await knex.schema.dropTableIfExists('message_details'); }
