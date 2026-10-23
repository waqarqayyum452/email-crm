import type { Knex } from 'knex';

export async function up(db: Knex) {
  if (await db.schema.hasColumn('email_accounts', 'deleted_at')) return;
  try {
    await db.schema.alterTable('email_accounts', table => { table.dateTime('deleted_at', { precision: 3 }); });
  } catch (error) {
    // Multiple application instances may provision this additive column together.
    if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
  }
}

export async function down(db: Knex) {
  if (await db.schema.hasColumn('email_accounts', 'deleted_at')) await db.schema.alterTable('email_accounts', table => { table.dropColumn('deleted_at'); });
}
