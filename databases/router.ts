import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getWalletPair, putWalletPair, getUserConsent, putUserConsent, parseAddress, updateProfile } from './users.js';
import { listSongsByCreator, listAllSongs, getFullSongProject, updateSong, deleteSong, getSongById, createSong, copySong } from './songs.js';
import { randomUUID } from 'node:crypto';
import { listStemsBySong } from './stems.js';
import { listTakesBySong, deleteTake } from './takes.js';
import { RequestError, readUser, readSong, readTake, checkUser } from './users.js';
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

const text = z.string().refine(value => value.trim().length > 0, 'Value must not be empty');
const address = text.refine(value => { try { parseAddress(value); return true; } catch { return false; } }, 'Invalid wallet address');
const pairBody = z.object({ evmAddress: address, svmAddress: address });
const profileBody = z.object({
  address: address.optional(),
  nickname: z.string().max(50).nullable().optional(),
  avatar: z.string().max(2048).nullable().optional(),
  svmAddress: address.optional(),
});
const consentBody = z.object({
  address: address.optional(), evmAddress: address.optional(), svmAddress: address.optional(),
  disclaimerType: text.optional(), policyVersion: text.default('1.0.0'), signature: text,
  message: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(), chainId: z.number().int().positive().optional(),
}).refine(data => data.address || data.evmAddress || data.svmAddress, 'At least one address must be provided');
const integerQuery = (minimum: number) => z.string().regex(/^\d+$/).transform(Number).refine(value => Number.isSafeInteger(value) && value >= minimum);
const listQuery = z.object({ creator: z.string().optional(), limit: integerQuery(1).optional(), offset: integerQuery(0).optional() });
const consentQuery = z.object({ version: text.optional(), type: text.optional() });
const songPatch = z.object({
  title: text.optional(), version: z.number().int().positive().optional(), source: text.nullable().optional(),
  url: text.optional(), licenses: z.number().int().nonnegative().optional(),
  stream_price: z.number().finite().nonnegative().optional(), license_price: z.number().finite().nonnegative().optional(),
  duration: z.number().finite().nonnegative().nullable().optional(), tags: z.array(z.string()).optional(),
  metadata_cid: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  album_id: z.string().nullable().optional(),
  public: z.boolean().optional(), network: text.optional(), chain_song_id: text.optional(), tx_hash: text.optional(),
}).strict().refine(data => Object.keys(data).length > 0, 'At least one song field is required');

const albumCreate = z.object({
  title: text,
  creator: text,
  description: z.string().optional(),
  cover: z.string().optional(),
  public: z.boolean().optional(),
});
const albumPatch = z.object({
  title: text.optional(),
  description: z.string().nullable().optional(),
  cover: z.string().nullable().optional(),
  public: z.boolean().optional(),
}).strict().refine(data => Object.keys(data).length > 0, 'At least one album field is required');

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown, message: string) {
  if (error instanceof RequestError) return reply.status(error.statusCode).send({ error: error.message });
  request.log.error(error);
  let cause: any = error; while (cause?.cause) cause = cause.cause;
  const invalid = error instanceof z.ZodError || cause?.code === '23514' || cause?.code === '23502' || cause?.code === '23503' || /^(Invalid wallet address|Wallet pair not found|EVM address must|SVM address must)/.test(cause?.message || '');
  const status = cause?.code === '23505' ? 409 : invalid ? 400 : 500;
  return reply.status(status).send({ error: status === 409 ? 'Record conflicts with existing data' : invalid ? 'Invalid request' : message });
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
      if (userAddress !== parseAddress(parsed.evmAddress).value && userAddress !== parseAddress(parsed.svmAddress).value) throw new RequestError('userAddress does not match this pair', 403);
      return reply.send(await putWalletPair(parsed));
    }
    catch (error) { return failure(request, reply, error, 'Failed to register wallet pair'); }
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
      checkUser(userAddress, targetAddress);
      const pair = await updateProfile({
        address: targetAddress,
        nickname: parsed.nickname,
        avatar: parsed.avatar,
        svmAddress: parsed.svmAddress,
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
      checkUser(userAddress, signingAddress);
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
  app.get('/songs', async (request, reply) => {
    try {
      const query = listQuery.parse(request.query);
      if (query.creator) {
        address.parse(query.creator);
        checkUser(readUser(request), query.creator);
        const rows = query.limit === undefined && query.offset === undefined
          ? await listSongsByCreator(query.creator)
          : await listSongsByCreator(query.creator, query.limit, query.offset);
        return reply.send(rows);
      }
      const rows = query.limit === undefined && query.offset === undefined ? await listAllSongs() : await listAllSongs(query.limit, query.offset);
      return reply.send(rows);
    } catch (error) { return failure(request, reply, error, 'Failed to list songs'); }
  });
  app.get('/songs/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await requireSongReader(request, id);
      const project = await getFullSongProject(id);
      return project.song ? reply.send(project) : reply.status(404).send({ error: 'Song not found' });
    } catch (error) { return failure(request, reply, error, 'Failed to retrieve song'); }
  });
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
      if (source.source) throw new RequestError('Remixes cannot be remixed', 409);
      if (!source.chain_song_id || !source.network || !source.url) throw new RequestError('The source song has not been minted', 409);
      const song = await createSong({
        id: `sng-${randomUUID()}`, title: source.title, source: source.id, creator, url: source.url,
        duration: source.duration, tags: source.tags, licenses: 0, image: source.image,
        stream_price: source.stream_price, license_price: 0, network: source.network,
      });
      return reply.status(201).send(song);
    } catch (error) { return failure(request, reply, error, 'Could not create remix'); }
  });
  app.delete('/songs/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await readSong(request, id);
      return await deleteSong(id) ? reply.send({ success: true, id }) : reply.status(404).send({ error: 'Song not found' });
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
      const id = `alb-${randomUUID()}`;
      const creator = body.creator.startsWith('0x') ? body.creator.toLowerCase() : body.creator;
      const album = await createAlbum({
        id,
        title: body.title,
        creator,
        description: body.description || null,
        cover: body.cover || null,
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
      const updates = albumPatch.parse(request.body);
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
      const { songId } = z.object({ songId: text }).parse(request.body);
      const ok = await addSongToAlbum(id, songId);
      if (!ok) return reply.status(404).send({ error: 'Song not found' });
      return reply.send({ success: true, albumId: id, songId });
    } catch (error) {
      return failure(request, reply, error, 'Failed to add song to album');
    }
  });

  app.delete('/albums/:id/songs/:songId', async (request, reply) => {
    try {
      const { songId } = request.params as { id: string; songId: string };
      const ok = await removeSongFromAlbum(songId);
      if (!ok) return reply.status(404).send({ error: 'Song not found' });
      return reply.send({ success: true, songId });
    } catch (error) {
      return failure(request, reply, error, 'Failed to remove song from album');
    }
  });
};
