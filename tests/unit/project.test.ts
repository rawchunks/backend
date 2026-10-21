import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDawStore, type Take, type DAWTrack } from '../../../app/src/lib/daw/store.js';
import { dawEngine } from '../../../app/src/lib/daw/engine.js';

const initial = useDawStore.getInitialState();
afterEach(() => useDawStore.setState(initial, true));

describe('project initialization', () => {
  it('uses only chosen lanes when adding a part', () => {
    useDawStore.getState().initProject('song', 'Session', 10, 'master.wav');
    useDawStore.getState().toggleLegoContext('bass');
    useDawStore.getState().toggleLegoContext('keys');
    expect(useDawStore.getState().legoContextTrackIds).toEqual(['bass', 'keys']);
    useDawStore.getState().toggleLegoContext('bass');
    expect(useDawStore.getState().legoContextTrackIds).toEqual(['keys']);
  });
  it('does not display versions from the previously opened song', () => {
    useDawStore.setState({ takes: [{ id: 'old' } as Take], commits: [{ id: 'old' } as any] });
    useDawStore.getState().initProject('next', 'Next', 10, 'next.wav');
    expect(useDawStore.getState().takes).toEqual([]);
    expect(useDawStore.getState().commits).toEqual([]);
  });
  it('restores cached lanes and takes during initialization', () => {
    const take = { id: 'take', song_id: 'song', take_number: 1, task: 'extract', url: 'take.wav', is_active: false } as Take;
    useDawStore.getState().initProject('song', 'Session', 10, 'master.wav', {
      stems: [{ id: 'bass', song_id: 'song', name: 'Bass', url: '', volume: .5, pan: 0, is_muted: false, is_solo: false }],
      takes: [take], commits: [],
    });
    expect(useDawStore.getState().tracks.map(track => track.id)).toEqual(['master', 'bass']);
    expect(useDawStore.getState().tracks[1].volume).toBe(.5);
    expect(useDawStore.getState().takes).toEqual([take]);
  });
  it('restores pending jobs, muted mounts, original section choices and tempo from the cache', () => {
    vi.spyOn(dawEngine, 'loadClip').mockResolvedValue();
    useDawStore.getState().initProject('song','Session',30,'master.wav');
    const master=useDawStore.getState().tracks[0];
    const overlay={...master,id:'part',activeTakeId:'part',muted:true,clips:[{...master.clips[0],id:'part:5:10',startTime:8,origin:5,duration:5}]};
    const operation={id:'edit-job',task:'repaint',status:'processing'} as const;
    useDawStore.getState().initProject('song','Session',30,'master.wav',{
      stems:[],takes:[{id:'part',task:'extract'} as Take],commits:[],
      session:{tracks:[master,overlay],originals:[{start:8,end:13}],operations:[operation],bpm:100},
    });
    expect(useDawStore.getState()).toMatchObject({bpm:100,originals:[{start:8,end:13}],operations:[operation]});
    expect(useDawStore.getState().tracks[1]).toMatchObject({muted:true,clips:[{startTime:8,origin:5}]});
  });
  it('restores saved notes, patterns, mixer settings and tempo without replacing current stem audio', () => {
    useDawStore.getState().initProject('song', 'Session', 10, 'master.wav');
    const master = useDawStore.getState().tracks[0];
    const keys = { ...master, id: 'keys', name: 'Keys', type: 'pianoroll', clips: [], volume: .4,
      pianoRollNotes: [{ id: 'note', pitch: 'C4', midi: 60, startTime: 0, duration: 1, velocity: .8 }] } as DAWTrack;
    const drums = { ...master, id: 'drums', name: 'Drums', type: 'sequencer', clips: [],
      sequencerVoices: [{ name: 'KICK', steps: [true, false], velocity: [.8, .8], muted: false }] } as DAWTrack;
    useDawStore.getState().initProject('song', 'Session', 10, 'current.wav', {
      stems: [], takes: [], commits: [{ id: 'snapshot', timeline_snapshot: { tracks: [master, keys, drums], bpm: 96 } } as any],
    });
    const state = useDawStore.getState();
    expect(state.tracks.map(track => track.id)).toEqual(['master', 'keys', 'drums']);
    expect(state.tracks[0].clips[0].url).toBe('current.wav');
    expect(state.tracks[1]).toMatchObject({ volume: .4, pianoRollNotes: keys.pianoRollNotes });
    expect(state.tracks[2].sequencerVoices).toEqual(drums.sequencerVoices);
    expect(state.bpm).toBe(96);
  });
});

describe('mounted takes', () => {
  const takes = [
    { id: 'first', take_number: 2, url: 'first.wav', task: 'extract', repainting_start: 4, repainting_end: 7, provenance: { audioOffset: 0 } },
    { id: 'second', take_number: 3, url: 'second.wav', task: 'cover' },
  ] as Take[];

  beforeEach(() => {
    vi.spyOn(dawEngine, 'loadClip').mockResolvedValue();
    vi.spyOn(dawEngine, 'updateTrackMixer').mockImplementation(() => {});
    vi.spyOn(dawEngine, 'disposeTrack').mockImplementation(() => {});
    vi.spyOn(dawEngine, 'stopAuditionTake').mockImplementation(() => {});
    useDawStore.getState().initProject('song', 'Session', 10, 'master.wav');
    useDawStore.getState().setTakes(takes);
  });

  it('mounts several takes without replacing the saved master', () => {
    useDawStore.getState().toggleTake('first');
    useDawStore.getState().toggleTake('second');
    const state = useDawStore.getState();
    expect(state.tracks.filter(track => track.activeTakeId).map(track => track.activeTakeId)).toEqual(['first', 'second']);
    expect(state.tracks[0].clips[0].url).toBe('master.wav');
    expect(state.takes).toEqual(takes);
    expect(state.commits).toEqual([]);
    expect(dawEngine.loadClip).toHaveBeenCalledWith('first', 'first:4:7', 'first.wav', 4, 0, 3);
  });

  it('unmounts one take without removing another', () => {
    useDawStore.getState().toggleTake('first');
    useDawStore.getState().toggleTake('second');
    useDawStore.getState().toggleTake('first');
    expect(useDawStore.getState().tracks.map(track => track.id)).toEqual(['master', 'second']);
    expect(dawEngine.disposeTrack).toHaveBeenCalledWith('first');
  });
  it('reconciles deleted merged mounts without discarding other pending layers', () => {
    useDawStore.getState().toggleTake('first');
    useDawStore.getState().toggleTake('second');
    useDawStore.getState().setTakes([takes[1]]);
    expect(useDawStore.getState().tracks.map(track => track.id)).toEqual(['master','second']);
    expect(dawEngine.disposeTrack).toHaveBeenCalledWith('first');
  });

  it('toggles a stem extract on its existing lane', () => {
    const state = useDawStore.getState();
    state.setTracks([...state.tracks, { ...state.tracks[0], id: 'bass', stemId: 'bass', name: 'Bass', clips: [{ ...state.tracks[0].clips[0], url: 'bass.wav' }] }]);
    state.setTakes([{ id: 'bass-take', stem_id: 'bass', task: 'extract', is_active: true, url: 'bass.wav' } as Take]);
    state.toggleTake('bass-take');
    expect(useDawStore.getState().tracks.find(track => track.id === 'bass')).toMatchObject({ muted: true, solo: false });
    state.toggleTake('bass-take');
    expect(useDawStore.getState().tracks.find(track => track.id === 'bass')).toMatchObject({ muted: false });
    expect(useDawStore.getState().tracks).toHaveLength(2);
    expect(useDawStore.getState().tracks[0].clips[0].url).toBe('master.wav');
  });

  it('restores independent mounts from the existing session snapshot', () => {
    useDawStore.getState().toggleTake('first');
    useDawStore.getState().toggleTake('second');
    const tracks = useDawStore.getState().tracks;
    useDawStore.getState().initProject('song', 'Session', 10, 'master.wav', {
      takes, stems: [], commits: [{ id: 'commit', timeline_snapshot: { tracks } } as any],
    });
    expect(useDawStore.getState().tracks.filter(track => track.activeTakeId).map(track => track.activeTakeId)).toEqual(['first', 'second']);
  });

  it('unmounts a silenced take when its mount button is clicked again', () => {
    useDawStore.getState().toggleTake('first');
    useDawStore.getState().updateTrackMixer('first', { muted: true });
    useDawStore.getState().toggleTake('first');
    expect(useDawStore.getState().tracks.some(track => track.id === 'first')).toBe(false);
  });

  it('does not remove an existing lane that stores its active take ID', () => {
    const state = useDawStore.getState();
    const bass = { ...state.tracks[0], id: 'bass', stemId: 'bass', activeTakeId: 'bass-take', name: 'Bass', clips: [{ ...state.tracks[0].clips[0], url: 'bass.wav' }] };
    state.setTracks([...state.tracks, bass]);
    state.setTakes([{ id: 'bass-take', stem_id: 'bass', task: 'extract', is_active: true, url: 'bass.wav' } as Take]);
    state.toggleTake('bass-take');
    expect(useDawStore.getState().tracks.find(track => track.id === 'bass')).toMatchObject({ muted: true });
    expect(dawEngine.disposeTrack).not.toHaveBeenCalledWith('bass');
  });

  it('does not consume an enabled layer excluded by another lane solo', async () => {
    await useDawStore.getState().toggleTake('first');
    useDawStore.getState().updateTrackMixer('master',{solo:true});
    const render=vi.spyOn(dawEngine,'render');
    await useDawStore.getState().mergeTakes(['first']);
    expect(render).not.toHaveBeenCalled();
    expect(useDawStore.getState().tracks.some(track=>track.id==='first')).toBe(true);
  });
  it('removes a failed mount without affecting other tracks', async () => {
    await useDawStore.getState().toggleTake('second');
    vi.mocked(dawEngine.loadClip).mockRejectedValueOnce(new Error('Audio unavailable'));
    await useDawStore.getState().toggleTake('first');
    expect(useDawStore.getState().tracks.map(track => track.id)).toEqual(['master', 'second']);
  });
});

describe('lane audition', () => {
  it('keeps the saved arrangement unchanged during an isolated audition', () => {
    vi.spyOn(dawEngine, 'startTransport').mockResolvedValue();
    vi.spyOn(dawEngine, 'updateTrackMixer').mockImplementation(() => {});
    useDawStore.getState().initProject('song', 'Session', 30, 'master.wav');
    const master = useDawStore.getState().tracks[0];
    useDawStore.getState().setTracks([master, { ...master, id: 'vocals', muted: true, mixer: { ...master.mixer!, muted: true } }]);
    const before = structuredClone(useDawStore.getState().tracks);
    dawEngine.auditionTrack('vocals');
    expect(useDawStore.getState().tracks).toEqual(before);
    dawEngine.stopAuditionTake();
    expect(useDawStore.getState().tracks).toEqual(before);
  });
});

describe('candidate placement', () => {
  beforeEach(async () => {
    vi.spyOn(dawEngine, 'loadClip').mockResolvedValue();
    vi.spyOn(dawEngine, 'disposeTrack').mockImplementation(() => {});
    vi.spyOn(dawEngine, 'pauseTransport').mockImplementation(() => {});
    useDawStore.getState().initProject('song', 'Session', 30, 'master.wav');
    useDawStore.getState().setTakes([{ id:'part', take_number:2, url:'part.wav', task:'extract', is_active:false,
      provenance:{region:{start:5,end:15},audioOffset:0,regions:[{start:5,end:8},{start:12,end:15}]} } as Take]);
    await useDawStore.getState().toggleTake('part');
  });
  it('moves all remaining regions together without changing source offsets or committed duration', async () => {
    await useDawStore.getState().moveTake('part', 4);
    const state = useDawStore.getState();
    expect(state.tracks.find(track => track.id === 'part')?.clips.map(clip => [clip.startTime,clip.offset,clip.duration])).toEqual([[9,0,3],[16,7,3]]);
    expect(state.duration).toBe(30);
    expect(state.takes[0].provenance?.region).toEqual({start:5,end:15});
  });
  it('resets the placement and clamps movement before timeline zero', async () => {
    await useDawStore.getState().moveTake('part', -10);
    expect(useDawStore.getState().tracks.find(track => track.id === 'part')?.clips[0].startTime).toBe(0);
    await useDawStore.getState().moveTake('part', 0);
    expect(useDawStore.getState().tracks.find(track => track.id === 'part')?.clips.map(clip => clip.startTime)).toEqual([5,12]);
  });
  it('silences ORG when mounting a master rework take with a master stem_id and updates master audio on merge even when stems are empty', async () => {
    const { sdk } = await import('../../../app/src/lib/sdk.js');
    vi.spyOn(dawEngine, 'syncOriginals').mockImplementation(() => {});
    vi.spyOn(dawEngine, 'render').mockResolvedValue(new Blob(['wav'], { type: 'audio/wav' }));
    const rework = {
      id: 'rework-1',
      song_id: 'song',
      stem_id: 'stm-master-song',
      take_number: 2,
      task: 'repaint',
      url: 'rework.wav',
      is_active: false,
      repainting_start: 4,
      repainting_end: 8,
      provenance: { target: 'master', region: { start: 4, end: 8 }, audioOffset: 4, outputDuration: 30 },
    } as Take;
    useDawStore.getState().initProject('song', 'Session', 30, 'master.wav');
    useDawStore.getState().setTakes([rework]);
    await useDawStore.getState().toggleTake('rework-1');
    expect(useDawStore.getState().originals).toEqual([{ start: 4, end: 8 }]);
    expect(dawEngine.syncOriginals).toHaveBeenCalled();

    const mergedTake = {
      id: 'take-merge-1',
      song_id: 'song',
      stem_id: 'stm-master-song',
      take_number: 3,
      task: 'merge',
      url: 'merged-master.wav',
      is_active: true,
      provenance: { target: 'master', region: { start: 4, end: 8 }, outputDuration: 30 },
    } as Take;
    vi.spyOn(sdk, 'fetch').mockImplementation((async (url: string) => {
      if (url.startsWith('/api/editing/source')) {
        return { ok: true, json: async () => ({ url: 'uploaded-render.wav' }) } as any;
      }
      if (url === '/api/editing/activate') {
        return { ok: true, json: async () => ({ success: true, activeTakeId: mergedTake.id, take: mergedTake, versionState: 'merged' }) } as any;
      }
      if (url.startsWith('/api/editing/history/')) {
        return { ok: true, json: async () => ({ stems: [], takes: [mergedTake], commits: [{ id: 'commit-merge-1', timeline_snapshot: { action: 'merge', activeTakeId: mergedTake.id, provenance: mergedTake.provenance } }] }) } as any;
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as any);

    await useDawStore.getState().activateTake('rework-1', 'merge');
    expect(dawEngine.render).toHaveBeenCalledWith(['master', 'rework-1'], 8, true, 4);
    const after = useDawStore.getState();
    expect(after.tracks.map(t => t.id)).toEqual(['master']);
    expect(after.tracks[0].clips[0].url).toBe('merged-master.wav');
    expect(after.originalMasterUrl).toBe('merged-master.wav');
    expect(after.originals).toEqual([]);
    expect(after.takes).toEqual([mergedTake]);
  });
});
