import { pgTable, text, integer, real, boolean, timestamp, jsonb, bigint, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const songs = pgTable('songs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  version: integer('version').default(1).notNull(),
  family: text('family'),
  basis: text('basis'),
  source: text('source'), // Original song ID if forked / remixed
  is_remix: boolean('is_remix').default(false).notNull(),
  parent_chain_song_id: text('parent_chain_song_id'), // On-chain songId of parent song for remixes
  creator: text('creator').notNull(), // User EVM address
  url: text('url').notNull(), // Master stereo audio URL
  licenses: integer('licenses').default(0).notNull(), // Amount of licenses minted/available
  stream_price: real('stream_price').default(0.02).notNull(), // $ per minute
  license_price: real('license_price').default(25.0).notNull(), // $ per license
  duration: real('duration'), // Duration in seconds (dynamic, set on generation/playback)
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  genres: jsonb('genres').$type<string[]>().default([]).notNull(),
  production: jsonb('production').$type<string[]>().default([]).notNull(),
  mood: jsonb('mood').$type<string[]>().default([]).notNull(),
  vocal: jsonb('vocal').$type<string[]>().default([]).notNull(),
  metadata_cid: text('metadata_cid'), // IPFS Pinata CID for immutable decentralized metadata
  image: text('image'), // Album or song cover art URL / Data URL
  album_id: text('album_id'), // Associated album ID
  public: boolean('public').default(false).notNull(),
  network: text('network'),
  chain_song_id: text('chain_song_id'),
  tx_hash: text('tx_hash'),
  plays: integer('plays').default(0).notNull(),
  last_played_at: timestamp('last_played_at', { withTimezone: true }),
  published_at: timestamp('published_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('songs_creator_created_idx').on(table.creator, table.created_at.desc()),
  index('songs_created_idx').on(table.created_at.desc()),
  index('songs_public_created_idx').on(table.created_at.desc()).where(sql`${table.public} = true`),
  index('songs_public_plays_idx').on(table.plays.desc(), table.created_at.desc()).where(sql`${table.public} = true`),
  index('songs_family_idx').on(table.family, table.version),
  index('songs_basis_idx').on(table.basis),
  check('songs_values_check', sql`${table.version} > 0 and ${table.licenses} >= 0 and ${table.stream_price} >= 0 and ${table.stream_price} < 'Infinity'::real and ${table.license_price} >= 0 and ${table.license_price} < 'Infinity'::real and (${table.duration} is null or (${table.duration} >= 0 and ${table.duration} < 'Infinity'::real))`),
]);

export const songEarnings = pgTable('song_earnings', {
  id: text('id').primaryKey(),
  song_id: text('song_id').notNull().references(() => songs.id, { onDelete: 'cascade' }),
  creator: text('creator').notNull(),
  network: text('network').notNull(),
  kind: text('kind').notNull(),
  gross_atomics: bigint('gross_atomics', { mode: 'bigint' }).default(0n).notNull(),
  creator_atomics: bigint('creator_atomics', { mode: 'bigint' }).default(0n).notNull(),
  tx_hash: text('tx_hash'),
  payer: text('payer'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('song_earnings_song_idx').on(table.song_id),
  index('song_earnings_creator_idx').on(table.creator, table.network),
  check('song_earnings_kind_check', sql`${table.kind} in ('license', 'stream')`),
]);

export type Song = typeof songs.$inferSelect;
export type NewSong = typeof songs.$inferInsert;
export type SongEarning = typeof songEarnings.$inferSelect;
export type NewSongEarning = typeof songEarnings.$inferInsert;
