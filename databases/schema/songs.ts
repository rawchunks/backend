import { pgTable, text, integer, real, boolean, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const songs = pgTable('songs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  version: integer('version').default(1).notNull(),
  family: text('family'),
  basis: text('basis'),
  source: text('source'), // Original song ID if forked / remixed
  creator: text('creator').notNull(), // User EVM address
  url: text('url').notNull(), // Master stereo audio URL
  licenses: integer('licenses').default(0).notNull(), // Amount of licenses minted/available
  stream_price: real('stream_price').default(0.02).notNull(), // $ per minute
  license_price: real('license_price').default(25.0).notNull(), // $ per license
  duration: real('duration'), // Duration in seconds (dynamic, set on generation/playback)
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  metadata_cid: text('metadata_cid'), // IPFS Pinata CID for immutable decentralized metadata
  image: text('image'), // Album or song cover art URL / Data URL
  album_id: text('album_id'), // Associated album ID
  public: boolean('public').default(false).notNull(),
  network: text('network'),
  chain_song_id: text('chain_song_id'),
  tx_hash: text('tx_hash'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('songs_creator_created_idx').on(table.creator, table.created_at.desc()),
  index('songs_created_idx').on(table.created_at.desc()),
  index('songs_public_created_idx').on(table.created_at.desc()).where(sql`${table.public} = true`),
  index('songs_family_idx').on(table.family, table.version),
  index('songs_basis_idx').on(table.basis),
  check('songs_values_check', sql`${table.version} > 0 and ${table.licenses} >= 0 and ${table.stream_price} >= 0 and ${table.stream_price} < 'Infinity'::real and ${table.license_price} >= 0 and ${table.license_price} < 'Infinity'::real and (${table.duration} is null or (${table.duration} >= 0 and ${table.duration} < 'Infinity'::real))`),
]);

export type Song = typeof songs.$inferSelect;
export type NewSong = typeof songs.$inferInsert;
