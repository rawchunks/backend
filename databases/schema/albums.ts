import { pgTable, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const albums = pgTable('albums', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  creator: text('creator').notNull(),
  description: text('description'),
  cover: text('cover'),
  public: boolean('public').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('albums_creator_created_idx').on(table.creator, table.created_at.desc()),
  index('albums_public_created_idx').on(table.created_at.desc()).where(sql`${table.public} = true`),
]);

export type Album = typeof albums.$inferSelect;
export type NewAlbum = typeof albums.$inferInsert;
