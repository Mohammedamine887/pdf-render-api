import { pgTable, text, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
export const usersTable = pgTable('users', {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});
export const apiKeysTable = pgTable('api_keys', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
    key: text('key').notNull().unique(), // e.g., "pp_live_xxxxxxxx"
    name: text('name').notNull(), // e.g., "Production Key"
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});
