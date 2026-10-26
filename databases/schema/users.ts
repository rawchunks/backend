import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

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

export type WalletPairRow = typeof walletPairs.$inferSelect;
export type NewWalletPair = typeof walletPairs.$inferInsert;
