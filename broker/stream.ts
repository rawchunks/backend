import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type Subscription = (message: (value: string) => void, error: (cause: Error) => void) => Promise<() => Promise<void>>;
/** Shared NDJSON lifecycle: back-to-back updates coalesce and every close releases its subscription. */
export function stateStreams(app: FastifyInstance) {
  const streams = new Set<Readable>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.push(null); });
  return <T>(request: FastifyRequest, reply: FastifyReply, options: {
    read: () => Promise<T>; terminal: (value: T) => boolean; subscribe: Subscription;
    event?: (value: string, send: (value: unknown) => void, update: () => Promise<void>) => void;
    intervalMs?: number;
  }) => {
    const stream = new Readable({ read() {} }); streams.add(stream);
    let closed = false, ended = false, running = false, dirty = false;
    let stop: (() => Promise<void>) | undefined;
    const send = (value: unknown) => { if (!closed && !ended) stream.push(JSON.stringify(value) + '\n'); };
    const finish = () => { if (!ended) { ended = true; stream.push(null); } };
    const fail = (error: Error) => { send({ status: 'error', error: error.message }); finish(); };
    const update = async () => {
      dirty = true; if (running || closed || ended) return; running = true;
      try {
        while (dirty && !closed && !ended) {
          dirty = false; const result = await options.read(); send(result);
          if (options.terminal(result)) { finish(); break; }
        }
      } catch (error: any) { fail(error); }
      finally { running = false; }
    };
    const heartbeat = setInterval(() => send({}), 15000); heartbeat.unref();
    const polling = options.intervalMs ? setInterval(() => { void update(); }, options.intervalMs) : undefined; polling?.unref();
    const cleanup = () => {
      if (closed) return; closed = true; clearInterval(heartbeat); if (polling) clearInterval(polling); streams.delete(stream);
      void stop?.().catch(error => request.log.warn(error, 'Failed to close state subscription')); stream.destroy();
    };
    reply.raw.on('close', cleanup); stream.on('close', cleanup);
    void (async () => {
      try {
        stop = await options.subscribe(value => {
          if (value === 'reconnected' || !value || !options.event) { void update(); return; }
          try { options.event(value, send, update); } catch (error: any) { fail(error); }
        }, error => { if (!closed && !ended) stream.destroy(error); });
        if (closed) await stop(); else await update();
      } catch (error: any) { fail(error); }
    })();
    return reply.header('Content-Type', 'application/x-ndjson').header('Cache-Control', 'no-store').header('X-Accel-Buffering', 'no').send(stream);
  };
}
