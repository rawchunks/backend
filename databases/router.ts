import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getWalletPair, getWalletPairsByAddresses, putWalletPair, getUserConsent, putUserConsent, getUserGuides, putUserGuides, parseAddress, updateProfile, getFollowedCreators, getCreatorFollowStats, toggleCreatorFollow } from './users.js';
import { listSongsByCreator, listAllSongs, getFullSongProject, updateSong, deleteSong, getSongById, createSong, copySong, queryPublicSongs, getMarketFolds, incrementSongPlay, getSongComments, addSongComment, deleteSongComment, getUserLikedSongIds, toggleSongLike } from './songs.js';
import * as songsModule from './songs.js';
import { randomUUID } from 'node:crypto';
import { listStemsBySong } from './stems.js';
import { listTakesBySong, deleteTake } from './takes.js';
import { RequestError, readUser, readSong, readTake, checkUser, checkUserOrPair } from './users.js';
import { requireSessionPayment, extractSessionToken, parseComposeToken, PaymentError, settleStreamCheckpoint, type SessionPaymentConfig } from '../broker/payment.js';
import { waitForInFlightAudio } from '../storage/r2.js';
import {
  createAlbum,
  getAlbumById,
  listAlbumsByCreator,
  listPublicAlbums,
  updateAlbum,
  deleteAlbum,
  addSongToAlbum,
  removeSongFromAlbum,
  getSongsByAlbum,
} from './albums.js';
import {
  createPlaylist,
  getPlaylistById,
  getPlaylistWithSongs,
  getPublicPlaylists,
  getPlaylistsByCreator,
  updatePlaylist,
  addSongToPlaylist,
  removeSongFromPlaylist,
  incrementPlaylistPlay,
  deletePlaylist,
} from './playlists.js';
import { ensureGenreCovers } from './genres.js';
import { getCreatorEarnings, recordSongEarning } from './earnings.js';

const text = z.string().refine(value => value.trim().length > 0, 'Value must not be empty');
const address = text.refine(value => { try { parseAddress(value); return true; } catch { return false; } }, 'Invalid wallet address');
const pairBody = z.object({
  evmAddress: address.optional(),
  svmAddress: address.optional(),
}).refine(data => Boolean(data.evmAddress || data.svmAddress), 'At least one wallet address is required');
const socialLinkSchema = z.object({
  platform: z.enum([
    'x',
    'instagram',
    'tiktok',
    'farcaster',
    'spotify',
    'soundcloud',
    'youtube',
    'discord',
    'telegram',
    'github',
    'twitch',
    'google',
    'apple',
  ]),
  handle: z.string().max(120),
  url: z.string().max(512),
  verified: z.boolean().optional(),
  providerId: z.string().max(160).optional(),
});

const profileBody = z.object({
  address: address.optional(),
  nickname: z.string().max(50).nullable().optional(),
  avatar: z.string().max(2048).nullable().optional(),
  bio: z.string().max(280).nullable().optional(),
  banner: z.string().max(2048).nullable().optional(),
  socials: z.array(socialLinkSchema).max(16).nullable().optional(),
  svmAddress: address.optional(),
  evmAddress: address.optional(),
});
const consentBody = z.object({
  address: address.optional(), evmAddress: address.optional(), svmAddress: address.optional(),
  disclaimerType: text.optional(), policyVersion: text.default('1.0.0'), signature: text,
  message: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(), chainId: z.number().int().positive().optional(),
}).refine(data => data.address || data.evmAddress || data.svmAddress, 'At least one address must be provided');
const guidesBody = z.object({
  address: address.optional(),
  guides: z.array(text).max(32),
});
const integerQuery = (minimum: number) => z.string().regex(/^\d+$/).transform(Number).refine(value => Number.isSafeInteger(value) && value >= minimum);
const listQuery = z.object({
  creator: z.string().optional(),
  limit: integerQuery(1).optional(),
  offset: integerQuery(0).optional(),
  sort: z.enum(['new', 'popular']).optional(),
  genre: z.string().optional(),
  search: z.string().optional(),
  sinceMinutes: integerQuery(1).optional(),
  paginated: z.string().optional(),
});
const consentQuery = z.object({ version: text.optional(), type: text.optional() });
const songPatch = z.object({
  title: text.optional(), version: z.number().int().positive().optional(), source: text.nullable().optional(),
  is_remix: z.boolean().optional(), parent_chain_song_id: text.nullable().optional(),
  url: text.optional(), licenses: z.number().int().nonnegative().optional(),
  stream_price: z.number().finite().nonnegative().optional(), license_price: z.number().finite().nonnegative().optional(),
  duration: z.number().finite().nonnegative().nullable().optional(),
  tags: z.array(z.string()).optional(),
  genres: z.array(z.string()).optional(),
  production: z.array(z.string()).optional(),
  mood: z.array(z.string()).optional(),
  vocal: z.array(z.string()).optional(),
  metadata_cid: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  album_id: z.string().nullable().optional(),
  public: z.boolean().optional(), network: text.optional(), chain_song_id: text.optional(), tx_hash: text.optional(),
}).strict().refine(data => Object.keys(data).length > 0, 'At least one song field is required');

const albumReleaseConfigSchema = z.object({
  targetNetwork: z.string().nullable().optional(),
  bundlePrice: z.number().finite().nonnegative().optional(),
  editionSize: z.number().int().nonnegative().optional(),
  releaseNotes: z.string().nullable().optional(),
  licenses: z.number().int().nonnegative().optional(),
  license_price: z.number().finite().nonnegative().optional(),
  stream_price: z.number().finite().nonnegative().optional(),
  network: z.string().nullable().optional(),
  remixable: z.boolean().optional(),
  status: z.enum(['draft', 'ready', 'released']).optional(),
  release_date: z.string().nullable().optional(),
}).nullable().optional();

const albumCreate = z.object({
  title: text,
  creator: text,
  description: z.string().nullable().optional(),
  concept: z.string().nullable().optional(),
  genre: z.string().nullable().optional(),
  cover: z.string().nullable().optional(),
  gallery: z.array(z.string()).optional(),
  release_config: albumReleaseConfigSchema,
  releaseConfig: albumReleaseConfigSchema,
  public: z.boolean().optional(),
});
const albumPatch = z.object({
  title: text.optional(),
  description: z.string().nullable().optional(),
  concept: z.string().nullable().optional(),
  genre: z.string().nullable().optional(),
  cover: z.string().nullable().optional(),
  gallery: z.array(z.string()).optional(),
  release_config: albumReleaseConfigSchema,
  releaseConfig: albumReleaseConfigSchema,
  public: z.boolean().optional(),
}).strict().refine(data => Object.keys(data).length > 0, 'At least one album field is required');

function resolveViewerAddresses(request: FastifyRequest): string[] {
  const raw = [
    request.headers['x-user-address'],
    request.headers['x-paired-svm-address'],
    request.headers['x-account-address'],
    request.headers['x-session-user-address'],
  ];
  const token = extractSessionToken(request);
  if (token) {
    const parsed = parseComposeToken(token);
    if (parsed?.sub) raw.push(parsed.sub);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      for (const part of entry.split(',')) {
        const trimmed = part.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return Array.from(new Set(out));
}

const playlistCreate = z.object({
  title: text,
  creator: text,
  description: z.string().nullable().optional(),
  cover: z.string().nullable().optional(),
  song_ids: z.array(z.string()).optional(),
  public: z.boolean().optional(),
});
const playlistPatch = z.object({
  title: text.optional(),
  description: z.string().nullable().optional(),
  cover: z.string().nullable().optional(),
  song_ids: z.array(z.string()).optional(),
  public: z.boolean().optional(),
}).strict().refine(data => Object.keys(data).length > 0, 'At least one playlist field is required');

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown, message: string) {
  if (error instanceof PaymentError) {
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
    reply.header('access-control-expose-headers', Object.keys(error.headers).join(', '));
    return reply.status(error.statusCode).send(error.body);
  }
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') return reply.status(error.statusCode).send({ error: error instanceof Error ? error.message : 'Payment request failed' });
  if (error instanceof RequestError) return reply.status(error.statusCode).send({ error: error.message });
  request.log.error(error);
  let cause: any = error; while (cause?.cause) cause = cause.cause;
  const invalid = error instanceof z.ZodError || cause?.code === '23514' || cause?.code === '23502' || cause?.code === '23503' || /^(Invalid wallet address|Wallet pair not found|EVM address must|SVM address must)/.test(cause?.message || '');
  const status = cause?.code === '23505' ? 409 : invalid ? 400 : 500;
  return reply.status(status).send({ error: status === 409 ? 'Record conflicts with existing data' : invalid ? 'Invalid request' : message });
}

export async function resolveSongStreamPayment(request: FastifyRequest): Promise<SessionPaymentConfig | null> {
  const { id } = request.params as { id: string };
  const song = await getSongById(id);
  if (!song) {
    throw new RequestError('Song not found', 404);
  }
  (request as any).song = song;

  if (typeof request.headers['x-wallet-auth-token'] === 'string') {
    const { authenticate } = await import('../credits/auth.js');
    const identity = await authenticate(request);
    const creator = song.creator.startsWith('0x') ? song.creator.toLowerCase() : song.creator;
    if (identity.addresses.includes(creator)) return null;
  }
  const rate = Math.round(song.stream_price * 1000000);
  const durationSec = song.duration && song.duration > 0 ? song.duration : 180;
  const durationMs = Math.ceil(durationSec * 1000);
  if (!Number.isSafeInteger(rate) || rate < 0 || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new RequestError('Streaming price or duration unavailable', 503);
  if (!rate) return null;
  return {
    amountWei: String((BigInt(rate) * BigInt(durationMs) + 59999n) / 60000n),
    priceUsd: song.stream_price, durationMs, action: 'stream-playback', creatorAddress: song.creator,
  };
}

export const databaseRouter: FastifyPluginAsync = async app => {
  const requireSongReader = async (request: FastifyRequest, id: string) => {
    const song = await getSongById(id);
    if (!song) throw new RequestError('Song not found', 404);
    if (!song.public) await readSong(request, id);
    return song;
  };
  app.put('/user', async (request, reply) => {
    try {
      const parsed = pairBody.parse(request.body);
      const userAddress = readUser(request);
      const evmVal = parsed.evmAddress ? parseAddress(parsed.evmAddress).value : null;
      const svmVal = parsed.svmAddress ? parseAddress(parsed.svmAddress).value : null;
      if (userAddress !== evmVal && userAddress !== svmVal) throw new RequestError('userAddress does not match this pair', 403);
      return reply.send(await putWalletPair(parsed));
    }
    catch (error) { return failure(request, reply, error, 'Failed to register wallet pair'); }
  });
  app.get('/users', async (request, reply) => {
    try {
      const { addresses } = request.query as { addresses?: string };
      if (!addresses || typeof addresses !== 'string') return reply.send([]);
      const rawList = Array.from(new Set(addresses.split(',').map(s => s.trim()).filter(Boolean))).slice(0, 100);
      return reply.send(await getWalletPairsByAddresses(rawList));
    } catch (error) { return failure(request, reply, error, 'Failed to lookup wallet pairs'); }
  });
  app.get('/user/:address', async (request, reply) => {
    try {
      const { address: raw } = request.params as { address: string };
      address.parse(raw);
      const pair = await getWalletPair(raw);
      return pair ? reply.send(pair) : reply.status(404).send({ error: 'Wallet pair not found' });
    } catch (error) { return failure(request, reply, error, 'Failed to lookup wallet pair'); }
  });
  const handleProfile = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = profileBody.parse(request.body || {});
      const userAddress = readUser(request);
      const targetAddress = parsed.address || userAddress;
      await checkUserOrPair(userAddress, targetAddress);
      const pair = await updateProfile({
        address: targetAddress,
        nickname: parsed.nickname,
        avatar: parsed.avatar,
        bio: parsed.bio,
        banner: parsed.banner,
        socials: parsed.socials,
        svmAddress: parsed.svmAddress,
        evmAddress: parsed.evmAddress,
      });
      return reply.send(pair);
    } catch (error) { return failure(request, reply, error, 'Failed to update user profile'); }
  };
  app.patch('/user/profile', handleProfile);
  app.put('/user/profile', handleProfile);
  app.post('/user/profile', handleProfile);
  app.get('/user/consent/:address', async (request, reply) => {
    try {
      const { address: raw } = request.params as { address: string };
      address.parse(raw);
      const query = consentQuery.parse(request.query);
      const record = await getUserConsent({ address: raw, policyVersion: query.version, disclaimerType: query.type });
      return reply.send({ consented: Boolean(record), evmAddress: record?.evmAddress ?? null, svmAddress: record?.svmAddress ?? null, record: record ?? null });
    } catch (error) { return failure(request, reply, error, 'Failed to check consent'); }
  });
  const recordConsent = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = consentBody.parse(request.body);
      const userAddress = readUser(request);
      const signingAddress = parsed.address ?? parsed.evmAddress ?? parsed.svmAddress!;
      await checkUserOrPair(userAddress, signingAddress);
      const record = await putUserConsent({
        address: signingAddress, svmAddress: parsed.svmAddress, chainId: parsed.chainId,
        disclaimerType: parsed.disclaimerType, policyVersion: parsed.policyVersion, signature: parsed.signature,
        message: parsed.message, metadata: parsed.metadata,
      });
      return reply.send(record);
    } catch (error) { return failure(request, reply, error, 'Failed to record consent'); }
  };
  app.post('/user/consent', recordConsent);
  app.put('/user/consent', recordConsent);
  app.get('/user/guides/:address', async (request, reply) => {
    try {
      const { address: raw } = request.params as { address: string };
      address.parse(raw);
      return reply.send({ guides: await getUserGuides(raw) });
    } catch (error) { return failure(request, reply, error, 'Failed to lookup user guides'); }
  });
  const recordGuides = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = guidesBody.parse(request.body || {});
      const userAddress = readUser(request);
      const targetAddress = parsed.address || userAddress;
      await checkUserOrPair(userAddress, targetAddress);
      const guides = await putUserGuides({ address: targetAddress, guides: parsed.guides });
      return reply.send({ guides });
    } catch (error) { return failure(request, reply, error, 'Failed to update user guides'); }
  };
  app.post('/user/guides', recordGuides);
  app.put('/user/guides', recordGuides);
  app.get('/songs', async (request, reply) => {
    try {
      const query = listQuery.parse(request.query);
      if (query.creator && !query.paginated && !query.sort && !query.genre && !query.search) {
        address.parse(query.creator);
        await checkUserOrPair(readUser(request), query.creator);
        const rows = query.limit === undefined && query.offset === undefined
          ? await listSongsByCreator(query.creator)
          : await listSongsByCreator(query.creator, query.limit, query.offset);
        return reply.send(rows);
      }
      if (query.paginated === 'true' || query.sort || query.genre || query.search || query.sinceMinutes) {
        const result = await queryPublicSongs({
          sort: query.sort,
          limit: query.limit,
          offset: query.offset,
          creator: query.creator,
          genre: query.genre,
          search: query.search,
          sinceMinutes: query.sinceMinutes,
        });
        return reply.send(query.paginated === 'true' ? result : result.items);
      }
      const rows = query.limit === undefined && query.offset === undefined ? await listAllSongs() : await listAllSongs(query.limit, query.offset);
      return reply.send(rows);
    } catch (error) { return failure(request, reply, error, 'Failed to list songs'); }
  });
  app.get('/songs/new', async (request, reply) => {
    try {
      const query = listQuery.parse(request.query);
      const result = await queryPublicSongs({
        sort: 'new',
        limit: query.limit ?? 20,
        offset: query.offset ?? 0,
        creator: query.creator,
        genre: query.genre,
        search: query.search,
        sinceMinutes: query.sinceMinutes,
      });
      return reply.send(result);
    } catch (error) { return failure(request, reply, error, 'Failed to list new songs'); }
  });
  app.get('/songs/popular', async (request, reply) => {
    try {
      const query = listQuery.parse(request.query);
      const result = await queryPublicSongs({
        sort: 'popular',
        limit: query.limit ?? 20,
        offset: query.offset ?? 0,
        creator: query.creator,
        genre: query.genre,
        search: query.search,
      });
      return reply.send(result);
    } catch (error) { return failure(request, reply, error, 'Failed to list popular songs'); }
  });
  app.get('/market/folds', async (request, reply) => {
    try {
      const { limit, windowMinutes } = request.query as { limit?: string; windowMinutes?: string };
      const foldLimit = limit ? Math.min(Math.max(Number(limit) || 50, 4), 100) : 50;
      const winMin = windowMinutes ? Number(windowMinutes) || 60 : 60;
      const folds = await getMarketFolds(foldLimit, winMin);
      return reply.send(folds);
    } catch (error) { return failure(request, reply, error, 'Failed to load market folds'); }
  });
  app.get('/genres/covers', async (request, reply) => {
    try {
      const { genres } = request.query as { genres?: string | string[] };
      const rawList = Array.isArray(genres)
        ? genres
        : typeof genres === 'string'
          ? genres.split(',')
          : [];
      const covers = await ensureGenreCovers(rawList);
      return reply.send({ covers });
    } catch (error) { return failure(request, reply, error, 'Failed to load genre covers'); }
  });
  app.post('/songs/:id/play', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const playbackContext = String(request.headers['x-playback-context'] || '').trim().toLowerCase();
      if (playbackContext.startsWith('mypage')) {
        const existing = await getSongById(id);
        if (!existing) return reply.status(404).send({ error: 'Song not found' });
        return reply.send({ id: existing.id, plays: existing.plays ?? 0, last_played_at: existing.last_played_at, skipped: true });
      }
      const viewerAddresses = resolveViewerAddresses(request);
      const fallbackViewer =
        (request.headers['cf-connecting-ip'] as string | undefined) ||
        request.ip ||
        undefined;
      const updated = await incrementSongPlay(
        id,
        viewerAddresses.length > 0 ? viewerAddresses : fallbackViewer,
      );
      if (!updated) return reply.status(404).send({ error: 'Song not found' });
      return reply.send({ id: updated.id, plays: updated.plays ?? 0, last_played_at: updated.last_played_at });
    } catch (error) { return failure(request, reply, error, 'Failed to record song play'); }
  });
  app.get('/songs/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const existing = await getSongById(id);
      if (existing && !existing.public) {
        await readSong(request, id);
      }
      let project = await getFullSongProject(id);
      if (!project?.song && 'getDeletedParentSongProject' in songsModule && typeof songsModule.getDeletedParentSongProject === 'function') {
        project = await songsModule.getDeletedParentSongProject(id);
      }
      if (!project?.song) return reply.status(404).send({ error: 'Song not found' });
      return reply.send(project);
    } catch (error) { return failure(request, reply, error, 'Failed to retrieve song'); }
  });

  const streamSongHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const song = (request as any).song || (await getSongById(id));
      if (!song) return reply.status(404).send({ error: 'Song not found' });

      const isCreator = reply.getHeader('x-creator-exempt') === 'true';
      const paymentIntentId = (request as any).paymentIntentId || null;

      if (typeof waitForInFlightAudio === 'function' && song.url) {
        await waitForInFlightAudio(song.url);
      }

      if (request.headers.accept?.includes('application/json')) {
        return reply.send({
          id: song.id,
          title: song.title,
          url: song.url,
          duration: song.duration,
          creator: song.creator,
          isCreator,
          paymentIntentId,
          streamPriceUsd: isCreator ? 0 : song.stream_price,
          streamPriceWei: isCreator ? '0' : Math.round(song.stream_price * 1_000_000).toString(),
        });
      }

      return reply.redirect(song.url);
    } catch (error) { return failure(request, reply, error, 'Failed to stream song'); }
  };

  const streamCheckpointHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const listenedSeconds = (request.body as any)?.listenedSeconds;
      if (typeof listenedSeconds !== 'number' || !Number.isFinite(listenedSeconds) || listenedSeconds < 0 || ((request.body as any)?.terminal !== undefined && typeof (request.body as any)?.terminal !== 'boolean')) throw new RequestError('Invalid playback checkpoint', 400);
      const playbackContext = String(request.headers['x-playback-context'] || '').trim().toLowerCase();
      const isPrivateWorkspacePlayback = playbackContext.startsWith('mypage');
      const viewerAddresses = resolveViewerAddresses(request);
      const viewer =
        (request.headers['x-user-address'] as string | undefined) ||
        (request.headers['x-session-user-address'] as string | undefined) ||
        request.ip;

      const intentId = String((request.body as any)?.paymentIntentId || '');
      if (request.headers['x-credit-source'] || intentId.startsWith('crd:')) {
        if (listenedSeconds >= 10 && id && !isPrivateWorkspacePlayback) {
          await incrementSongPlay(id, viewerAddresses.length > 0 ? viewerAddresses : (viewer || intentId)).catch(() => {});
        }
        const { checkpointCredits } = await import('../credits/billing.js');
        const creditCheckpoint = await checkpointCredits(request);
        const receiptHeaders = (creditCheckpoint.result as any)?.headers as Record<string, string> | undefined;
        if (receiptHeaders) {
          for (const [name, value] of Object.entries(receiptHeaders)) reply.header(name, value);
          reply.header('access-control-expose-headers', Object.keys(receiptHeaders).join(', '));
        }
        const status = creditCheckpoint.result.status;
        return reply.status(status === 'queued' || status === 'submitted' ? 202 : 200).send(creditCheckpoint);
      }
      const song = await getSongById(id);
      if (!song) return reply.status(404).send({ error: 'Song not found' });

      const body = request.body as {
        paymentIntentId?: string;
        listenedSeconds?: number;
      } | undefined;

      const paymentIntentId = body?.paymentIntentId;

      if (!paymentIntentId) {
        return reply.status(400).send({ error: 'paymentIntentId is required for stream checkpoint' });
      }

      const network = request.headers['x-network-id'] as string;
      if (!network) throw new RequestError('x-network-id is required', 400);

      const result = await settleStreamCheckpoint({
        paymentIntentId,
        network,
        listenedSeconds,
        token: extractSessionToken(request) || undefined, songId: id, terminal: (request.body as any)?.terminal === true,
      });

      if (listenedSeconds >= 10 && !isPrivateWorkspacePlayback) {
        await incrementSongPlay(id, viewerAddresses.length > 0 ? viewerAddresses : (viewer || paymentIntentId)).catch(() => {});
      }

      for (const [name, value] of Object.entries(result.headers || {})) reply.header(name, value);
      reply.header('access-control-expose-headers', Object.keys(result.headers || {}).join(', '));
      return reply.status(result.status === 'queued' || result.status === 'submitted' ? 202 : 200).send({ success: true, result });
    } catch (error) {
      return failure(request, reply, error, 'Failed to settle stream checkpoint');
    }
  };

  app.get('/songs/:id/stream', { preHandler: [requireSessionPayment(resolveSongStreamPayment, { metered: true })] }, streamSongHandler);
  app.get('/stream/:id', { preHandler: [requireSessionPayment(resolveSongStreamPayment, { metered: true })] }, streamSongHandler);
  app.post('/songs/:id/stream/checkpoint', streamCheckpointHandler);
  app.post('/stream/:id/checkpoint', streamCheckpointHandler);
  app.get('/songs/:id/stems', async (request, reply) => {
    try { const { id } = request.params as { id: string }; await requireSongReader(request, id); return reply.send(await listStemsBySong(id)); }
    catch (error) { return failure(request, reply, error, 'Failed to retrieve stems'); }
  });
  app.patch('/songs/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await readSong(request, id);
      const patch = songPatch.parse(request.body);
      const updated = await updateSong(id, patch);
      return updated ? reply.send(updated) : reply.status(404).send({ error: 'Song not found' });
    } catch (error) { return failure(request, reply, error, 'Failed to update song'); }
  });
  app.post('/songs/:id/remix', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const creator = readUser(request);
      const source = await requireSongReader(request, id);
      if (source.source || source.is_remix) throw new RequestError('Remixes cannot be remixed', 409);
      if (!source.chain_song_id || !source.network || !source.url) throw new RequestError('The source song has not been minted', 409);
      const ensureOnly = Boolean((request.body as { ensureOnly?: boolean } | null | undefined)?.ensureOnly);
      if (ensureOnly) {
        const existingSongs = (await listSongsByCreator(creator)) || [];
        const existing = existingSongs.find((s) => s.source === source.id);
        if (existing) {
          return reply.status(200).send(existing);
        }
      }
      const song = await createSong({
        id: `sng-${randomUUID()}`, title: source.title, source: source.id,
        is_remix: true, parent_chain_song_id: source.chain_song_id,
        creator, url: source.url,
        duration: source.duration,
        tags: source.genres?.length ? source.genres : source.tags,
        genres: source.genres,
        production: source.production,
        mood: source.mood,
        vocal: source.vocal,
        licenses: 0, image: source.image,
        stream_price: source.stream_price, license_price: 0, network: source.network,
      });
      if (creator.toLowerCase() !== source.creator.toLowerCase() && (source.license_price ?? 0) > 0 && source.network) {
        const gross = BigInt(Math.round(Number(source.license_price) * 1_000_000));
        void recordSongEarning({
          id: `lic:${song.id}`,
          songId: source.id,
          creator: source.creator,
          network: source.network,
          kind: 'license',
          grossAtomics: gross,
          creatorAtomics: (gross * 8000n) / 10000n,
          streamedMs: 0n,
          txHash: source.tx_hash || null,
          payer: creator,
        }).catch(() => {});
      }
      return reply.status(201).send(song);
    } catch (error) { return failure(request, reply, error, 'Could not create remix'); }
  });
  app.delete('/songs/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await readSong(request, id);
      const licensees = Array.isArray((request.body as { licensees?: string[] } | null | undefined)?.licensees)
        ? (request.body as { licensees: string[] }).licensees
        : undefined;
      if (!licensees && 'preserveLicensedRemixesBeforeDelete' in songsModule && typeof songsModule.preserveLicensedRemixesBeforeDelete === 'function') {
        await songsModule.preserveLicensedRemixesBeforeDelete(id);
      }
      return await (licensees ? deleteSong(id, licensees) : deleteSong(id))
        ? reply.send({ success: true, id })
        : reply.status(404).send({ error: 'Song not found' });
    } catch (error) { return failure(request, reply, error, 'Failed to delete song'); }
  });
  app.post('/songs/:id/version', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await readSong(request, id);
      return reply.status(201).send(await copySong(id));
    } catch (error) { return failure(request, reply, error, 'Could not open a song version'); }
  });
  app.get('/songs/:id/takes', async (request, reply) => {
    try { const { id } = request.params as { id: string }; await requireSongReader(request, id); return reply.send(await listTakesBySong(id)); }
    catch (error) { return failure(request, reply, error, 'Failed to retrieve takes'); }
  });
  app.delete('/songs/:id/takes/:takeId', async (request, reply) => {
    try {
      const { id, takeId } = request.params as { id: string; takeId: string };
      const { song } = await readTake(request, takeId, id);
      if (song?.metadata_cid) throw new RequestError('Open an editable version before changing this song', 409);
      return await deleteTake(takeId, id) ? reply.send({ success: true, id: takeId }) : reply.status(404).send({ error: 'Take not found' });
    } catch (error) { return failure(request, reply, error, 'Failed to delete take'); }
  });
  app.delete('/takes/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { song } = await readTake(request, id);
      if (song.metadata_cid) throw new RequestError('Open an editable version before changing this song', 409);
      return await deleteTake(id, song.id) ? reply.send({ success: true, id }) : reply.status(404).send({ error: 'Take not found' });
    } catch (error) { return failure(request, reply, error, 'Failed to delete take'); }
  });

  // Album routes
  app.get('/albums', async (request, reply) => {
    try {
      const { creator, public: isPub } = request.query as { creator?: string; public?: string };
      if (creator) {
        return reply.send(await listAlbumsByCreator(creator));
      }
      if (isPub === 'true') {
        return reply.send(await listPublicAlbums());
      }
      return reply.send([]);
    } catch (error) {
      return failure(request, reply, error, 'Failed to list albums');
    }
  });

  app.post('/albums', async (request, reply) => {
    try {
      const body = albumCreate.parse(request.body);
      const userAddress = readUser(request);
      await checkUserOrPair(userAddress, body.creator);
      const id = `alb-${randomUUID()}`;
      const creator = body.creator.startsWith('0x') ? body.creator.toLowerCase() : body.creator;
      const album = await createAlbum({
        id,
        title: body.title,
        creator,
        description: body.description || null,
        concept: body.concept || null,
        genre: body.genre || null,
        cover: body.cover || null,
        gallery: body.gallery ?? [],
        release_config: body.release_config ?? body.releaseConfig ?? null,
        public: body.public ?? false,
      });
      return reply.status(201).send(album);
    } catch (error) {
      return failure(request, reply, error, 'Failed to create album');
    }
  });

  app.get('/albums/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const album = await getAlbumById(id);
      if (!album) return reply.status(404).send({ error: 'Album not found' });
      const songs = await getSongsByAlbum(id);
      return reply.send({ ...album, songs });
    } catch (error) {
      return failure(request, reply, error, 'Failed to get album');
    }
  });

  app.patch('/albums/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const userAddress = readUser(request);
      const existing = await getAlbumById(id);
      if (!existing) return reply.status(404).send({ error: 'Album not found' });
      await checkUserOrPair(userAddress, existing.creator);
      const parsed = albumPatch.parse(request.body);
      const { releaseConfig, ...rest } = parsed;
      const updates = {
        ...rest,
        ...(releaseConfig !== undefined && rest.release_config === undefined
          ? { release_config: releaseConfig }
          : {}),
      };
      const updated = await updateAlbum(id, updates);
      if (!updated) return reply.status(404).send({ error: 'Album not found' });
      return reply.send(updated);
    } catch (error) {
      return failure(request, reply, error, 'Failed to update album');
    }
  });

  app.delete('/albums/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const userAddress = readUser(request);
      const existing = await getAlbumById(id);
      if (!existing) return reply.status(404).send({ error: 'Album not found' });
      await checkUserOrPair(userAddress, existing.creator);
      const deleted = await deleteAlbum(id);
      if (!deleted) return reply.status(404).send({ error: 'Album not found' });
      return reply.send({ success: true, id });
    } catch (error) {
      return failure(request, reply, error, 'Failed to delete album');
    }
  });

  app.post('/albums/:id/songs', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const userAddress = readUser(request);
      const existing = await getAlbumById(id);
      if (!existing) return reply.status(404).send({ error: 'Album not found' });
      await checkUserOrPair(userAddress, existing.creator);
      const { songId } = z.object({ songId: text }).parse(request.body);
      await readSong(request, songId);
      const ok = await addSongToAlbum(id, songId);
      if (!ok) return reply.status(404).send({ error: 'Song not found' });
      return reply.send({ success: true, albumId: id, songId });
    } catch (error) {
      return failure(request, reply, error, 'Failed to add song to album');
    }
  });

  app.delete('/albums/:id/songs/:songId', async (request, reply) => {
    try {
      const { id, songId } = request.params as { id: string; songId: string };
      const userAddress = readUser(request);
      const existing = await getAlbumById(id);
      if (!existing) return reply.status(404).send({ error: 'Album not found' });
      await checkUserOrPair(userAddress, existing.creator);
      const ok = await removeSongFromAlbum(songId);
      if (!ok) return reply.status(404).send({ error: 'Song not found' });
      return reply.send({ success: true, songId });
    } catch (error) {
      return failure(request, reply, error, 'Failed to remove song from album');
    }
  });

  // Playlist routes
  app.get('/playlists', async (request, reply) => {
    try {
      const { creator, limit, offset } = request.query as { creator?: string; limit?: string; offset?: string };
      if (creator) {
        return reply.send(await getPlaylistsByCreator(creator));
      }
      return reply.send(await getPublicPlaylists(limit ? Number(limit) : 50, offset ? Number(offset) : 0));
    } catch (error) {
      return failure(request, reply, error, 'Failed to list playlists');
    }
  });

  app.get('/playlists/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await getPlaylistWithSongs(id);
      if (!result.playlist) return reply.status(404).send({ error: 'Playlist not found' });
      return reply.send({ ...result.playlist, songs: result.songs });
    } catch (error) {
      return failure(request, reply, error, 'Failed to retrieve playlist');
    }
  });

  app.post('/playlists', async (request, reply) => {
    try {
      const body = playlistCreate.parse(request.body);
      const hasAuthHeader = Boolean(
        request.headers['x-user-address'] ||
        request.headers['x-session-user-address'] ||
        request.headers['x-account-address'] ||
        request.headers.authorization
      );
      if (hasAuthHeader) {
        await checkUserOrPair(readUser(request), body.creator);
      }
      const id = `pl_${randomUUID()}`;
      const playlist = await createPlaylist({
        id,
        title: body.title.trim(),
        creator: body.creator,
        description: body.description || null,
        cover: body.cover || null,
        song_ids: body.song_ids ?? [],
        public: body.public ?? false,
      });
      return reply.status(201).send(playlist);
    } catch (error) {
      return failure(request, reply, error, 'Failed to create playlist');
    }
  });

  const handleUpdatePlaylist = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const existing = await getPlaylistById(id);
      if (!existing) return reply.status(404).send({ error: 'Playlist not found' });
      const hasAuthHeader = Boolean(
        request.headers['x-user-address'] ||
        request.headers['x-session-user-address'] ||
        request.headers['x-account-address'] ||
        request.headers.authorization
      );
      if (hasAuthHeader) {
        await checkUserOrPair(readUser(request), existing.creator);
      }
      const updates = playlistPatch.parse(request.body);
      const updated = await updatePlaylist(id, updates);
      if (!updated) return reply.status(404).send({ error: 'Playlist not found' });
      return reply.send(updated);
    } catch (error) {
      return failure(request, reply, error, 'Failed to update playlist');
    }
  };
  app.put('/playlists/:id', handleUpdatePlaylist);
  app.patch('/playlists/:id', handleUpdatePlaylist);

  app.post('/playlists/:id/songs', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const existing = await getPlaylistById(id);
      if (!existing) return reply.status(404).send({ error: 'Playlist not found' });
      const hasAuthHeader = Boolean(
        request.headers['x-user-address'] ||
        request.headers['x-session-user-address'] ||
        request.headers['x-account-address'] ||
        request.headers.authorization
      );
      if (hasAuthHeader) {
        await checkUserOrPair(readUser(request), existing.creator);
      }
      const { songId } = z.object({ songId: text }).parse(request.body);
      const updated = await addSongToPlaylist(id, songId);
      if (!updated) return reply.status(404).send({ error: 'Playlist not found' });
      return reply.send(updated);
    } catch (error) {
      return failure(request, reply, error, 'Failed to add song to playlist');
    }
  });

  app.delete('/playlists/:id/songs/:songId', async (request, reply) => {
    try {
      const { id, songId } = request.params as { id: string; songId: string };
      const existing = await getPlaylistById(id);
      if (!existing) return reply.status(404).send({ error: 'Playlist not found' });
      const hasAuthHeader = Boolean(
        request.headers['x-user-address'] ||
        request.headers['x-session-user-address'] ||
        request.headers['x-account-address'] ||
        request.headers.authorization
      );
      if (hasAuthHeader) {
        await checkUserOrPair(readUser(request), existing.creator);
      }
      const updated = await removeSongFromPlaylist(id, songId);
      if (!updated) return reply.status(404).send({ error: 'Playlist not found' });
      return reply.send(updated);
    } catch (error) {
      return failure(request, reply, error, 'Failed to remove song from playlist');
    }
  });

  app.post('/playlists/:id/play', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const updated = await incrementPlaylistPlay(id);
      if (!updated) return reply.status(404).send({ error: 'Playlist not found' });
      return reply.send(updated);
    } catch (error) {
      return failure(request, reply, error, 'Failed to record playlist play');
    }
  });

  app.delete('/playlists/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const existing = await getPlaylistById(id);
      if (!existing) return reply.status(404).send({ error: 'Playlist not found' });
      const hasAuthHeader = Boolean(
        request.headers['x-user-address'] ||
        request.headers['x-session-user-address'] ||
        request.headers['x-account-address'] ||
        request.headers.authorization
      );
      if (hasAuthHeader) {
        await checkUserOrPair(readUser(request), existing.creator);
      }
      const deleted = await deletePlaylist(id);
      if (!deleted) return reply.status(404).send({ error: 'Playlist not found' });
      return reply.send({ success: true, id });
    } catch (error) {
      return failure(request, reply, error, 'Failed to delete playlist');
    }
  });

  // Creator Earnings & Analytics route (EARN tab)
  app.get('/earnings', async (request, reply) => {
    try {
      const { creator, network, refresh } = request.query as {
        creator?: string;
        network?: string;
        refresh?: string;
      };
      if (!creator || !creator.trim()) {
        return reply.status(400).send({ error: 'creator address is required' });
      }
      address.parse(creator);
      const userAddress = readUser(request);
      await checkUserOrPair(userAddress, creator);
      const data = await getCreatorEarnings(creator, {
        network,
        refresh: refresh === 'true',
      });
      return reply.send(data);
    } catch (error) {
      return failure(request, reply, error, 'Failed to retrieve creator earnings');
    }
  });

  // =========================================================================
  // Social Streaming Routes: Timed Comments, Song Likes, Creator Follows
  // =========================================================================

  app.get('/songs/:id/comments', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const rows = await getSongComments(id);
      const authorAddresses = Array.from(new Set(rows.map((r) => r.author)));
      const pairs = authorAddresses.length > 0 ? await getWalletPairsByAddresses(authorAddresses) : [];
      const profileMap = new Map<string, { nickname?: string | null; avatar?: string | null }>();
      for (const p of pairs) {
        if (p.evmAddress) profileMap.set(p.evmAddress.toLowerCase(), p);
        if (p.svmAddress) profileMap.set(p.svmAddress, p);
      }
      const enriched = rows.map((row) => {
        const key = row.author.startsWith('0x') ? row.author.toLowerCase() : row.author;
        const prof = profileMap.get(key) || profileMap.get(row.author);
        return {
          ...row,
          authorNickname: prof?.nickname ?? null,
          authorAvatar: prof?.avatar ?? null,
        };
      });
      return reply.send(enriched);
    } catch (error) {
      return failure(request, reply, error, 'Failed to fetch song comments');
    }
  });

  app.post('/songs/:id/comments', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const userAddress = readUser(request);
      const bodySchema = z.object({
        body: z.string().trim().min(1).max(280),
        timestampSec: z.number().min(0).max(3600).default(0),
      });
      const parsed = bodySchema.parse(request.body);
      const created = await addSongComment({
        songId: id,
        author: userAddress,
        body: parsed.body,
        timestampSec: parsed.timestampSec,
      });
      const prof = await getWalletPair(created.author);
      return reply.status(201).send({
        ...created,
        authorNickname: prof?.nickname ?? null,
        authorAvatar: prof?.avatar ?? null,
      });
    } catch (error) {
      return failure(request, reply, error, 'Failed to post song comment');
    }
  });

  app.delete('/songs/:id/comments/:commentId', async (request, reply) => {
    try {
      const { id, commentId } = request.params as { id: string; commentId: string };
      const userAddress = readUser(request);
      const deleted = await deleteSongComment(id, commentId, userAddress);
      if (!deleted) return reply.status(404).send({ error: 'Comment not found' });
      return reply.send({ success: true, id: commentId });
    } catch (error) {
      return failure(request, reply, error, 'Failed to delete song comment');
    }
  });

  app.get('/likes', async (request, reply) => {
    try {
      const { user } = request.query as { user?: string };
      const targetUser = user?.trim() || (request.headers['x-session-user-address'] as string | undefined)?.trim();
      if (!targetUser) {
        return reply.send({ songIds: [] });
      }
      address.parse(targetUser);
      const songIds = await getUserLikedSongIds(targetUser);
      return reply.send({ songIds });
    } catch (error) {
      return failure(request, reply, error, 'Failed to retrieve liked songs');
    }
  });

  app.post('/songs/:id/like', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const userAddress = readUser(request);
      const bodySchema = z.object({ liked: z.boolean().optional() }).optional();
      const parsed = bodySchema.parse(request.body ?? {});
      const result = await toggleSongLike(id, userAddress, parsed?.liked);
      return reply.send(result);
    } catch (error) {
      return failure(request, reply, error, 'Failed to update song like');
    }
  });

  app.get('/follows', async (request, reply) => {
    try {
      const { user } = request.query as { user?: string };
      const targetUser = user?.trim() || (request.headers['x-session-user-address'] as string | undefined)?.trim();
      if (!targetUser) {
        return reply.send({ creators: [] });
      }
      address.parse(targetUser);
      const creators = await getFollowedCreators(targetUser);
      return reply.send({ creators });
    } catch (error) {
      return failure(request, reply, error, 'Failed to retrieve followed creators');
    }
  });

  app.get('/creators/:creatorAddress/social', async (request, reply) => {
    try {
      const { creatorAddress } = request.params as { creatorAddress: string };
      address.parse(creatorAddress);
      const { viewer } = request.query as { viewer?: string };
      const viewerAddr =
        viewer?.trim() ||
        (request.headers['x-session-user-address'] as string | undefined)?.trim() ||
        null;
      const stats = await getCreatorFollowStats(creatorAddress, viewerAddr);
      return reply.send(stats);
    } catch (error) {
      return failure(request, reply, error, 'Failed to retrieve creator social stats');
    }
  });

  app.post('/creators/:creatorAddress/follow', async (request, reply) => {
    try {
      const { creatorAddress } = request.params as { creatorAddress: string };
      address.parse(creatorAddress);
      const userAddress = readUser(request);
      const bodySchema = z.object({ following: z.boolean().optional() }).optional();
      const parsed = bodySchema.parse(request.body ?? {});
      const stats = await toggleCreatorFollow(userAddress, creatorAddress, parsed?.following);
      return reply.send(stats);
    } catch (error) {
      return failure(request, reply, error, 'Failed to update creator follow state');
    }
  });
};
