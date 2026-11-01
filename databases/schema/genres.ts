import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const genreCovers = pgTable('genre_covers', {
  slug: text('slug').primaryKey(),
  label: text('label').notNull(),
  image_url: text('image_url'),
  status: text('status').default('pending').notNull(), // 'pending' | 'ready' | 'failed'
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type GenreCover = typeof genreCovers.$inferSelect;
export type NewGenreCover = typeof genreCovers.$inferInsert;
