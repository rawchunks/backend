import { pgTable, text, timestamp, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';

export const walletPairs = pgTable('wallet_pairs', {
  evm_address: text('evm_address').unique(),
  svm_address: text('svm_address').unique(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  consented_at: timestamp('consented_at', { withTimezone: true }),
  consent_version: text('consent_version'),
  consent_signature: text('consent_signature'),
  consent_message: text('consent_message'),
  consent_metadata: jsonb('consent_metadata'),
  nickname: text('nickname'),
  avatar: text('avatar'),
  bio: text('bio'),
  guides_seen: jsonb('guides_seen').$type<string[]>().default([]).notNull(),
});

export const follows = pgTable('follows', {
  follower_address: text('follower_address').notNull(),
  creator_address: text('creator_address').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.follower_address, table.creator_address] }),
  index('follows_creator_idx').on(table.creator_address, table.created_at.desc()),
  index('follows_follower_idx').on(table.follower_address, table.created_at.desc()),
]);

export type WalletPairRow = typeof walletPairs.$inferSelect;
export type NewWalletPair = typeof walletPairs.$inferInsert;
export type FollowRow = typeof follows.$inferSelect;
