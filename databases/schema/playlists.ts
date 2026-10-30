import { pgTable, text, boolean, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const playlists = pgTable('playlists', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  creator: text('creator').notNull(),
  description: text('description'),
  cover: text('cover'),
  song_ids: jsonb('song_ids').$type<string[]>().default([]).notNull(),
  public: boolean('public').default(false).notNull(),
  plays: integer('plays').default(0).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('playlists_creator_created_idx').on(table.creator, table.created_at.desc()),
  index('playlists_public_created_idx').on(table.created_at.desc()).where(sql`${table.public} = true`),
  index('playlists_public_plays_idx').on(table.plays.desc(), table.created_at.desc()).where(sql`${table.public} = true`),
]);

export type Playlist = typeof playlists.$inferSelect;
export type NewPlaylist = typeof playlists.$inferInsert;
