import type { Knex } from 'knex';

export async function up(db: Knex) {
  if (await db.schema.hasColumn('email_accounts', 'signature')) return;
  try {
    await db.schema.alterTable('email_accounts', table => { table.text('signature').nullable(); });
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
  }
}

export async function down(db: Knex) {
  if (await db.schema.hasColumn('email_accounts', 'signature')) await db.schema.alterTable('email_accounts', table => { table.dropColumn('signature'); });
}
