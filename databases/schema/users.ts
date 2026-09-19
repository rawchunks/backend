import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const walletPairs = pgTable('wallet_pairs', {
  evm_address: text('evm_address').primaryKey(),
  svm_address: text('svm_address').unique(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  consented_at: timestamp('consented_at', { withTimezone: true }),
  consent_version: text('consent_version'),
  consent_signature: text('consent_signature'),
  consent_message: text('consent_message'),
  consent_metadata: jsonb('consent_metadata'),
  nickname: text('nickname'),
  avatar: text('avatar'),
});

export const users = pgTable('users', {
  evm_address: text('evm_address').primaryKey(),
  svm_address: text('svm_address'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  consented_at: timestamp('consented_at', { withTimezone: true }),
  consent_signature: text('consent_signature'),
  policy_version: text('policy_version').default('1.0.0').notNull(),
  nickname: text('nickname'),
  avatar: text('avatar'),
});

export type WalletPairRow = typeof walletPairs.$inferSelect;
export type NewWalletPair = typeof walletPairs.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
