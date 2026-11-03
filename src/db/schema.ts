import {
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  integer,
  boolean
} from 'drizzle-orm/pg-core';

export const usersTable = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),

  email: text('email').notNull().unique(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const apiKeysTable = pgTable('api_keys', {
  id: serial('id').primaryKey(),

  // UUID must match usersTable.id
  userId: uuid('user_id')
    .references(() => usersTable.id)
    .notNull(),

  key: text('key').unique().notNull(),

  name: text('name').notNull(),

  isActive: boolean('is_active').default(true).notNull(),

  usageCount: integer('usage_count').default(0).notNull(),

  monthlyLimit: integer('monthly_limit').default(100).notNull(),

  usageResetAt: timestamp('usage_reset_at')
    .defaultNow()
    .notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});