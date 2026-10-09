import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clock = vi.hoisted(() => ({
  state: 'stopped', seconds: 0, loop: false, loopStart: 0, loopEnd: 10,
  start: vi.fn(), pause: vi.fn(), stop: vi.fn(),
  schedule: vi.fn(() => 0), clear: vi.fn(),
}));
const state = vi.hoisted(() => ({
  tracks: [] as { id: string; muted: boolean }[], selection: null,
  duration: 30, originals: [] as { start: number; end: number }[], setPlaying: vi.fn(), updateTrackMixer: vi.fn(),
}));
const players = vi.hoisted(() => ({ created: [] as any[], load: () => Promise.resolve() }));
vi.mock('../../../app/node_modules/tone/build/esm/index.js', () => ({
  getTransport: () => clock, getDestination: () => ({ mute: false }),
  Time: (value: number) => ({ toSeconds: () => value }), gainToDb: (value: number) => 20 * Math.log10(value),
  Player: class {
    loaded = false; disposed = false; scheduled = false;
    constructor() { players.created.push(this); }
    connect() { return this; }
    async load() { await players.load(); this.loaded = true; }
    sync() { return this; }
    start() { this.scheduled = true; return this; }
    dispose() { this.disposed = true; }
  },
}));
vi.mock('../../../app/src/lib/daw/store', () => ({ useDawStore: { getState: () => state, setState: vi.fn() } }));

import { dawEngine } from '../../../app/src/lib/daw/engine';

class Audio extends EventTarget {
  src = '';
  crossOrigin = '';
  preload = '';
  readyState = 3;
  currentTime = 0;
  paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  load() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { location: { href: 'http://localhost/' }, setInterval });
  vi.stubGlobal('Audio', Audio);
  Object.assign(clock, { state: 'stopped', seconds: 0, loop: false, loopStart: 0, loopEnd: 10 });
  clock.start = vi.fn(() => { clock.state = 'started'; });
  clock.pause = vi.fn(() => { clock.state = 'paused'; });
  clock.stop = vi.fn(() => { clock.state = 'stopped'; });
  vi.spyOn(dawEngine, 'resumeAudioContext').mockResolvedValue();
  vi.spyOn(dawEngine, 'init').mockResolvedValue();
  vi.spyOn(dawEngine, 'syncOriginals').mockImplementation(() => {});
  vi.spyOn(dawEngine, 'updateTrackMixer').mockImplementation(() => {});
  state.tracks = [];
  state.originals = [];
  players.created = [];
  players.load = () => Promise.resolve();
});

afterEach(() => {
  dawEngine.resetProject();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('editor transport', () => {
  it('registers clip initialization before PLAY can inspect pending audio', async () => {
    let finish!: () => void;
    vi.mocked(dawEngine.init).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const nodes = { players: new Map(), input: {} } as any;
    vi.spyOn(dawEngine, 'getOrCreateTrackNodes').mockReturnValue(nodes);
    const load = dawEngine.loadClip('master', 'clip', 'master.wav', 0);
    expect((dawEngine as any).loading.size).toBe(1);
    await Promise.resolve();
    finish(); await load;
  });
  it('does not recreate players from an old project after audio initialization resolves', async () => {
    let finish!: () => void;
    vi.mocked(dawEngine.init).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const nodes = { players: new Map(), input: {} } as any;
    vi.spyOn(dawEngine, 'getOrCreateTrackNodes').mockReturnValue(nodes);
    const load = dawEngine.loadClip('master', 'clip', 'old.wav', 0);
    await Promise.resolve();
    dawEngine.resetProject(); finish(); await load;
    expect(players.created).toHaveLength(0);
    expect(nodes.players.size).toBe(0);
  });
  it('shares identical clip loads instead of replacing the player still decoding', async () => {
    const nodes = { players: new Map(), input: {} } as any;
    vi.spyOn(dawEngine, 'getOrCreateTrackNodes').mockReturnValue(nodes);
    await Promise.all([dawEngine.loadClip('master','clip','master.wav',0), dawEngine.loadClip('master','clip','master.wav',0)]);
    expect(players.created).toHaveLength(1);
    expect(players.created[0]).toMatchObject({loaded:true,disposed:false,scheduled:true});
  });
  it('waits for clip decoding before starting full arrangement playback', async () => {
    let finish!: () => void;
    const loading = new Promise<void>(resolve => { finish = resolve; });
    const pending = (dawEngine as unknown as { loading: Map<string, Promise<void>> }).loading;
    pending.set('master:clip', loading);
    const started = dawEngine.startTransport();
    await Promise.resolve();
    expect(clock.start).not.toHaveBeenCalled();
    finish();
    await started;
    pending.clear();
    expect(clock.start).toHaveBeenCalledOnce();
  });

  it('does not restart transport when stopped during clip decoding', async () => {
    let finish!: () => void;
    const pending = (dawEngine as unknown as { loading: Map<string, Promise<void>> }).loading;
    pending.set('master:clip', new Promise(resolve => { finish = resolve; }));
    const started = dawEngine.startTransport();
    await Promise.resolve();
    dawEngine.stopTransport();
    finish();
    await started;
    pending.clear();
    expect(clock.start).not.toHaveBeenCalled();
  });

  it('encodes commit audio without clipping summed samples before the master bus', async () => {
    const channels = [Float32Array.of(.5, 1.5, -1.25), Float32Array.of(-.5, .25, 0)];
    const wav = new DataView(await dawEngine.encodeWavBlob(channels, 48000, 3, true).arrayBuffer());
    expect(wav.getUint16(20, true)).toBe(3);
    expect(wav.getUint16(34, true)).toBe(32);
    expect(wav.getUint32(40, true)).toBe(24);
    expect(wav.getFloat32(52, true)).toBe(1.5);
    expect(wav.getFloat32(60, true)).toBe(-1.25);
  });
  it('preserves loop bounds after pausing and resuming', async () => {
    dawEngine.setLoop(true, 3, 8);
    await dawEngine.startTransport();
    dawEngine.pauseTransport();
    await dawEngine.startTransport();
    clock.seconds = 8;
    vi.advanceTimersByTime(200);
    expect(clock.seconds).toBe(3);
    expect(clock.state).toBe('started');
  });

  it('stops a section audition at its end and returns to its start', async () => {
    await dawEngine.auditionSection(2, 5);
    clock.seconds = 4.9;
    vi.advanceTimersByTime(200);
    expect(clock.state).toBe('started');
    clock.seconds = 5;
    vi.advanceTimersByTime(25);
    expect(clock.seconds).toBe(2);
    expect(clock.state).toBe('paused');
    expect(state.setPlaying).toHaveBeenLastCalledWith(false);
  });

  it('repeats a section audition within its bounds', async () => {
    await dawEngine.auditionSection(2, 5, true);
    clock.seconds = 5;
    vi.advanceTimersByTime(200);
    expect(clock.seconds).toBe(2);
    expect(clock.state).toBe('started');
  });

  it('does not restart a stopped take when the master loops', async () => {
    dawEngine.auditionTake('http://localhost/take.wav');
    const take = (dawEngine as unknown as { auditionTakeAudio: Audio }).auditionTakeAudio;
    dawEngine.stopAuditionTake();
    dawEngine.setLoop(true, 2, 5);
    await dawEngine.startTransport();
    const calls = take.play.mock.calls.length;
    clock.seconds = 5;
    vi.advanceTimersByTime(200);
    expect(clock.seconds).toBe(2);
    expect(take.paused).toBe(true);
    expect(take.play).toHaveBeenCalledTimes(calls);
  });

  it.each(['pauseTransport', 'stopTransport', 'stopAuditionTake'] as const)(
    '%s cancels a take that is still loading', action => {
      dawEngine.auditionTake('http://localhost/loaded-take.wav');
      const take = (dawEngine as unknown as { auditionTakeAudio: Audio }).auditionTakeAudio;
      take.readyState = 0;
      dawEngine.auditionTake('http://localhost/loading-take.wav');
      const calls = take.play.mock.calls.length;
      dawEngine[action]();
      take.readyState = 3;
      take.dispatchEvent(new Event('canplay'));
      expect(take.paused).toBe(true);
      expect(take.play).toHaveBeenCalledTimes(calls);
    }
  );

  it('isolates a lane without saving audition mutes and restores the working mixer on PLAY', async () => {
    state.tracks = [{id:'master',muted:false,solo:false},{id:'bass',muted:true,solo:false}] as any;
    const before = structuredClone(state.tracks);
    const nodes = (dawEngine as any).trackNodes as Map<string, any>;
    vi.stubGlobal('AudioContext', class {});
    const output = () => ({volume:{mute:false,volume:{rampTo:()=>{}}},panner:{pan:{rampTo:()=>{}}}});
    nodes.set('master', output()); nodes.set('bass', output());
    vi.mocked(dawEngine.updateTrackMixer).mockRestore();
    try {
      dawEngine.auditionTrack('bass');
      expect(nodes.get('master').volume.mute).toBe(true);
      expect(nodes.get('bass').volume.mute).toBe(false);
      expect(state.tracks).toEqual(before);
      await dawEngine.startTransport();
      expect(nodes.get('master').volume.mute).toBe(false);
      expect(nodes.get('bass').volume.mute).toBe(true);
      expect(state.tracks).toEqual(before);
    } finally { nodes.clear(); }
  });

  it('mutes the original master source without muting mounted layers', () => {
    state.tracks = [{id:'master',muted:true,solo:false},{id:'layer',activeTakeId:'layer',muted:false,solo:false}] as any;
    const nodes = (dawEngine as any).trackNodes as Map<string, any>;
    vi.stubGlobal('AudioContext', class {});
    const output = () => ({source:{gain:{value:1,setValueAtTime:vi.fn()}},volume:{mute:false,volume:{rampTo:()=>{}}},panner:{pan:{rampTo:()=>{}}}});
    nodes.set('master',output()); nodes.set('layer',output());
    vi.mocked(dawEngine.updateTrackMixer).mockRestore();
    vi.mocked(dawEngine.syncOriginals).mockRestore();
    try {
      dawEngine.updateTrackMixer('master');
      expect(nodes.get('master').source.gain.value).toBe(0);
      expect(nodes.get('master').volume.mute).toBe(false);
      expect(nodes.get('layer').volume.mute).toBe(false);
      state.tracks[0].muted = false;
      dawEngine.updateTrackMixer('master');
      expect(nodes.get('master').source.gain.value).toBe(1);
      state.tracks[1].muted = true;
      dawEngine.updateTrackMixer('layer');
      expect(nodes.get('layer').volume.mute).toBe(true);
      state.originals = [{start:5,end:10}]; clock.seconds = 7;
      dawEngine.syncOriginals();
      expect(nodes.get('master').source.gain.value).toBe(0);
      clock.seconds = 12; dawEngine.syncOriginals();
      expect(nodes.get('master').source.gain.value).toBe(1);
      state.tracks[0].muted = true;
      dawEngine.updateTrackMixer('master');
      expect(nodes.get('master').source.gain.value).toBe(0);
    } finally { nodes.clear(); }
  });

  it.each([{selected:['master']},{selected:['layer']},{selected:['master','layer']}])('auditions selected segment audio $selected without changing its mixer', async ({selected}) => {
    state.tracks = [{id:'master',muted:false,solo:false},{id:'layer',activeTakeId:'layer',muted:false,solo:false},{id:'other',muted:false,solo:false}] as any;
    const before = structuredClone(state.tracks);
    const nodes = (dawEngine as any).trackNodes as Map<string, any>;
    vi.stubGlobal('AudioContext', class {});
    const output = () => ({source:{gain:{value:1,setValueAtTime:vi.fn()}},volume:{mute:false,volume:{rampTo:()=>{}}},panner:{pan:{rampTo:()=>{}}}});
    for (const id of ['master','layer','other']) nodes.set(id,output());
    vi.mocked(dawEngine.updateTrackMixer).mockRestore();
    vi.mocked(dawEngine.syncOriginals).mockRestore();
    try {
      await dawEngine.auditionLayer(selected,5,10);
      expect(nodes.get('master').source.gain.value).toBe(selected.includes('master') ? 1 : 0);
      expect(nodes.get('master').volume.mute).toBe(false);
      expect(nodes.get('layer').volume.mute).toBe(!selected.includes('layer'));
      expect(nodes.get('other').volume.mute).toBe(true);
      expect(state.tracks).toEqual(before);
      await dawEngine.startTransport();
      expect(nodes.get('other').volume.mute).toBe(false);
      expect(state.tracks).toEqual(before);
    } finally {dawEngine.stopAuditionTake();nodes.clear();}
  });
});
