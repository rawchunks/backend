import { describe, expect, it } from 'vitest';
import { isBase, mounted, preview, segments, source, clips, sourceInterval, pending, retained, masterArrangement, isMasterTargetTake, isFullSongRestyleTake } from '../../../app/src/lib/daw/takes.js';

const take = { id: 'take', stem_id: 'vocals', url: 'vocals.wav', is_active: true };
const tracks = [{ id: 'master', stemId: 'stem-master', clips: [{ url: 'master.wav' }] }, { id: 'vocals', clips: [{ url: 'vocals.wav' }] }];

describe('editor versions', () => {
  it('keeps only pending sections in Extracted and drops consumed mounts during restore', () => {
    const candidate = {...take,id:'candidate',is_active:false,provenance:{region:{start:5,end:10}}};
    expect(pending(candidate)).toBe(true);
    expect(pending({...candidate,is_active:true})).toBe(false);
    expect(pending({...candidate,is_active:true,provenance:undefined,repainting_start:5,repainting_end:10})).toBe(false);
    expect(pending({...candidate,model:'demucs-htdemucs'})).toBe(false);
    expect(pending({...candidate,task:'text2music',is_active:false})).toBe(false);
    expect(pending({...candidate,provenance:{mergedInto:'master'}})).toBe(false);
    const mountedTracks = [...tracks,{id:'candidate',activeTakeId:'candidate',clips:[]},{id:'deleted',activeTakeId:'deleted',clips:[]}];
    expect(retained(mountedTracks,[candidate])).toEqual(mountedTracks.slice(0,-1));
    expect(retained(mountedTracks,[])).toEqual(tracks);
  });
  it('marks only the take supplying the current lane audio as its base', () => {
    const older = { ...take, id: 'older', url: 'older.wav' }, versions = [take, older];
    expect(isBase(take, tracks, versions)).toBe(true);
    expect(isBase(older, tracks, versions)).toBe(false);
    expect(isBase({ ...take, is_active: false }, tracks, versions)).toBe(false);
  });
  it('recognizes the master when its persisted stem ID differs from the editor ID', () => {
    const master = { ...take, stem_id: 'stem-master', url: 'master.wav' };
    expect(isBase(master, tracks, [master])).toBe(true);
  });
  it('recognizes one active version stored under a separate audio object key', () => {
    const version = { ...take, url: 'versions/vocals.wav' };
    expect(isBase(version, tracks, [version])).toBe(true);
  });
  it('does not mark an unloaded take as base', () => {
    expect(isBase(take, [], [take])).toBe(false);
    expect(isBase({ ...take, stem_id: 'unloaded', url: 'master.wav' }, tracks, [take])).toBe(false);
  });
  it('previews a compact extracted segment from its source offset', () => {
    expect(preview({ ...take, repainting_start: 10, repainting_end: 20, provenance: { audioOffset: 0 } })).toEqual({ start: 0, end: 10, timelineStart: 10 });
  });
  it('previews a section in a full arrangement at its original interval', () => {
    expect(preview({ ...take, repainting_start: 10, repainting_end: 20 })).toEqual({ start: 10, end: 20, timelineStart: 10 });
  });
  it('previews a full version without imposing a section boundary', () => {
    expect(preview(take)).toEqual({ start: 0, end: undefined, timelineStart: 0 });
  });

  it('clears the base check when its lane is muted', () => {
    const muted = tracks.map(track => ({ ...track, muted: true }));
    expect(mounted(take, muted, [take])).toBe(false);
    expect(isBase(take, muted, [take])).toBe(true);
  });

  it('marks independent mounted versions without changing the persisted active take', () => {
    const version = { ...take, id: 'mounted', is_active: false };
    const track = { id: 'mounted', activeTakeId: 'mounted', muted: false, clips: [{ url: version.url }] };
    expect(mounted(version, [...tracks, track], [take, version])).toBe(true);
    expect(mounted(version, [...tracks, { ...track, muted: true }], [take, version])).toBe(true);
    expect(isBase(version, [...tracks, track], [take, version])).toBe(false);
  });

  it('resolves a candidate to its recorded source rather than its take ID', () => {
    expect(source({ ...take, id: 'candidate' }, tracks)).toBe('vocals');
    expect(source({ ...take, provenance: { target: 'master' } }, tracks)).toBe('master');
    expect(source({ ...take, stem_id: 'stm-master-1', task: 'repaint' }, [{ id: 'master', clips: [{ url: 'master.wav' }] }])).toBe('master');
    expect(source({ ...take, stem_id: 'missing' }, tracks)).toBeNull();
  });

  it('treats a rework take with a master stem_id as a master section candidate rather than a full-song restyle', () => {
    const rework = { ...take, id: 'rework', stem_id: 'stm-master-1', task: 'repaint', is_active: false, repainting_start: 4, repainting_end: 8, provenance: { target: 'master' as const, region: { start: 4, end: 8 } } };
    expect(isMasterTargetTake(rework)).toBe(true);
    expect(isFullSongRestyleTake(rework)).toBe(false);
    expect(pending(rework)).toBe(true);
  });

  it('resolves edits of a moved take to the recorded source interval', () => {
    const moved={id:take.id,activeTakeId:take.id,clips:[{url:take.url,startTime:25,origin:5,duration:10}]};
    expect(sourceInterval(take,[moved],{start:27,end:32})).toEqual({start:7,end:12});
    expect(sourceInterval(take,[],{start:7,end:12})).toEqual({start:7,end:12});
  });
  it('resolves a selection spanning the remaining clips of a moved take', () => {
    const moved={id:take.id,activeTakeId:take.id,clips:[
      {url:take.url,startTime:25,origin:5,duration:5},
      {url:take.url,startTime:40,origin:20,duration:5},
    ]};
    expect(sourceInterval(take,[moved],{start:25,end:45})).toEqual({start:5,end:25});
  });
  it('clips remaining candidate intervals at the matching audio offsets', () => {
    const candidate = { ...take, repainting_start: 5, repainting_end: 25, provenance: {
      audioOffset: 0, regions: [{start:5,end:10}, {start:20,end:25}],
    } };
    expect(clips(candidate, 30).map(({startTime, offset, duration}) => ({startTime, offset, duration}))).toEqual([
      {startTime:5, offset:0, duration:5}, {startTime:20, offset:15, duration:5},
    ]);
    expect(clips({...candidate, provenance:{...candidate.provenance, audioOffset:5}}, 30)[1].offset).toBe(20);
  });
  it('computes master arrangement separation and extension segments for mounted extend clips', () => {
    expect(masterArrangement(30, [])).toEqual({
      segments: [{ startTime: 0, offset: 0, duration: 30 }],
      duration: 30,
    });
    expect(masterArrangement(30, [{ startTime: 30, duration: 30 }])).toEqual({
      segments: [{ startTime: 0, offset: 0, duration: 30 }],
      duration: 60,
    });
    expect(masterArrangement(30, [{ startTime: 10, duration: 15 }])).toEqual({
      segments: [
        { startTime: 0, offset: 0, duration: 10 },
        { startTime: 25, offset: 10, duration: 20 },
      ],
      duration: 45,
    });
  });
});


describe('applied master segments', () => {
  const merge = (id: string, start: number, end: number, target = 'master') => ({
    id: `commit-${id}`, timeline_snapshot: { action: 'merge', activeTakeId: id, provenance: { target, region: { start, end } } },
  });
  const base = (id: string) => ({ id: `base-${id}`, timeline_snapshot: { action: 'base', activeTakeId: id } });
  it('retains disjoint merges', () => {
    expect(segments([merge('second', 30, 40), merge('first', 5, 15)])).toEqual([
      { id: 'first', start: 5, end: 15 }, { id: 'second', start: 30, end: 40 },
    ]);
  });
  it('splits an earlier segment around an overlapping replacement', () => {
    expect(segments([merge('second', 10, 20), merge('first', 5, 25)])).toEqual([
      { id: 'first', start: 5, end: 10 }, { id: 'first', start: 20, end: 25 }, { id: 'second', start: 10, end: 20 },
    ]);
  });
  it('removes fully covered intervals', () => {
    expect(segments([merge('second', 0, 30), merge('first', 5, 25)])).toEqual([{ id: 'second', start: 0, end: 30 }]);
  });
  it('restores intervals belonging to a previously applied base', () => {
    expect(segments([base('first'), merge('second', 30, 40), merge('first', 5, 15)])).toEqual([{ id: 'first', start: 5, end: 15 }]);
  });
  it('clears markers when an original or compact extract becomes base', () => {
    expect(segments([base('original'), merge('first', 5, 15)])).toEqual([]);
  });
  it('excludes edits belonging to individual stems', () => {
    expect(segments([merge('voice', 10, 20, 'vocals'), merge('first', 5, 15)])).toEqual([{ id: 'first', start: 5, end: 15 }]);
  });
});
