import { pgTable, text, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export interface AlbumReleaseConfig {
  targetNetwork?: string | null;
  bundlePrice?: number;
  editionSize?: number;
  releaseNotes?: string | null;
  licenses?: number;
  license_price?: number;
  stream_price?: number;
  network?: string | null;
  remixable?: boolean;
  status?: 'draft' | 'ready' | 'released';
  release_date?: string | null;
}

export const albums = pgTable('albums', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  creator: text('creator').notNull(),
  description: text('description'),
  concept: text('concept'),
  genre: text('genre'),
  cover: text('cover'),
  gallery: jsonb('gallery').$type<string[]>().default([]).notNull(),
  release_config: jsonb('release_config').$type<AlbumReleaseConfig | null>().default({}),
  public: boolean('public').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('albums_creator_created_idx').on(table.creator, table.created_at.desc()),
  index('albums_public_created_idx').on(table.created_at.desc()).where(sql`${table.public} = true`),
]);

export type Album = typeof albums.$inferSelect;
export type NewAlbum = typeof albums.$inferInsert;
