import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import * as userSchema from './schema/users.js';
import * as songSchema from './schema/songs.js';
import * as stemSchema from './schema/stems.js';
import * as takeSchema from './schema/takes.js';
import * as commitSchema from './schema/commits.js';

// Load .env from backend directory
dotenv.config({ path: resolve(process.cwd(), '.env') });

const sanitizeUrl = (url?: string) => url?.trim().replace(/^['"]|['"]$/g, '');
const userDbUrl = sanitizeUrl(process.env.USER_DATABASE_URL);
const songDbUrl = sanitizeUrl(process.env.SONG_DATABASE_URL);

if (!userDbUrl) {
  throw new Error('USER_DATABASE_URL environment variable is missing.');
}

if (!songDbUrl) {
  throw new Error('SONG_DATABASE_URL environment variable is missing.');
}

// User Neon Database Client & Drizzle Instance
const userSql = neon(userDbUrl);
export const userDb = drizzle(userSql, { schema: { ...userSchema } });

// Song Neon Database Client & Drizzle Instance (includes stems, takes, and commits)
const songSql = neon(songDbUrl);
export const songDb = drizzle(songSql, {
  schema: {
    ...songSchema,
    ...stemSchema,
    ...takeSchema,
    ...commitSchema,
  },
});

export { userSql, songSql };
