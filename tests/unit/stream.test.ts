import { afterEach, describe, expect, it, vi } from 'vitest';
import { sdk, watch } from '../../../app/src/lib/sdk.js';
afterEach(() => vi.restoreAllMocks());

describe('completion transport', () => {
  it('decodes fragmented records and delivers readiness without another request', async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('{"status":"processing","progress":'));
      controller.enqueue(encoder.encode('40}\n{}\n{"status":"ready","title":"café"}\n'));
      controller.close();
    } }));
    const fetch = vi.spyOn(sdk, 'fetch').mockResolvedValue(response);
    const records: any[] = [];
    await watch('/api/generation/events/task?songId=song', new AbortController().signal, value => {
      if (value.status) records.push(value);
      return value.status === 'ready';
    });
    expect(records).toEqual([{ status: 'processing', progress: 40 }, { status: 'ready', title: 'café' }]);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('cancels an open reader when the page scope ends', async () => {
    const cancel = vi.fn();
    const fetch = vi.spyOn(sdk, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const controller = new AbortController();
    const pending = watch('/events', controller.signal, () => false);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not reconnect after the server reports a generation error', async () => {
    const fetch = vi.spyOn(sdk, 'fetch').mockResolvedValue(new Response('{"status":"error","error":"worker failed"}\n'));
    await expect(watch('/events', new AbortController().signal, value => { throw new Error(value.error); })).rejects.toThrow('worker failed');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reconnects an interrupted stream and accepts the durable receipt', async () => {
    const fetch = vi.spyOn(sdk, 'fetch')
      .mockResolvedValueOnce(new Response('{"status":"processing"}\n'))
      .mockResolvedValueOnce(new Response('{"status":"ready"}\n'));
    const records: any[] = [];
    await watch('/events', new AbortController().signal, value => { records.push(value); return value.status === 'ready'; });
    expect(records).toEqual([{ status: 'processing' }, { status: 'ready' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});


it('reconnects after a transport failure without reporting generation failure', async () => {
  const fetch = vi.spyOn(sdk, 'fetch').mockRejectedValueOnce(new Error('connection closed'))
    .mockResolvedValueOnce(new Response('{"status":"ready"}\n'));
  const records: any[] = [];
  await watch('/events', new AbortController().signal, value => { records.push(value); return value.status === 'ready'; });
  expect(records).toEqual([{ status: 'ready' }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
