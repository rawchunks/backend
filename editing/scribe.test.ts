import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildScribeLyricsAndAlignment,
  buildForcedAlignmentLines,
  sanitizeAlignedLineWords,
  prepareVocalStemWavForElevenLabs,
} from './scribe.js';

test('buildScribeLyricsAndAlignment groups word timestamps into sung lines by acoustic pauses and punctuation', () => {
  const words = [
    { text: 'Walking', start: 1.0, end: 1.4, type: 'word' },
    { text: ' ', start: 1.4, end: 1.45, type: 'spacing' },
    { text: 'through', start: 1.45, end: 1.8, type: 'word' },
    { text: ' ', start: 1.8, end: 1.85, type: 'spacing' },
    { text: 'the', start: 1.85, end: 2.0, type: 'word' },
    { text: ' ', start: 2.0, end: 2.05, type: 'spacing' },
    { text: 'neon', start: 2.05, end: 2.5, type: 'word' },
    { text: ' ', start: 2.5, end: 2.55, type: 'spacing' },
    { text: 'rain', start: 2.55, end: 3.1, type: 'word' },
    // 1.2s pause triggers a line break
    { text: 'Shadows', start: 4.3, end: 4.8, type: 'word' },
    { text: ' ', start: 4.8, end: 4.85, type: 'spacing' },
    { text: 'call', start: 4.85, end: 5.2, type: 'word' },
    { text: ' ', start: 5.2, end: 5.25, type: 'spacing' },
    { text: 'my', start: 5.25, end: 5.5, type: 'word' },
    { text: ' ', start: 5.5, end: 5.55, type: 'spacing' },
    { text: 'name', start: 5.55, end: 6.1, type: 'word' },
  ];

  const { lyrics, alignment } = buildScribeLyricsAndAlignment(
    'Walking through the neon rain Shadows call my name',
    words,
  );

  assert.equal(lyrics, 'Walking through the neon rain\nShadows call my name');
  assert.ok(alignment);
  assert.equal(alignment.source, 'scribe_v2');
  assert.equal(alignment.lines.length, 2);
  assert.equal(alignment.lines[0].text, 'Walking through the neon rain');
  assert.equal(alignment.lines[0].start, 1.0);
  assert.equal(alignment.lines[0].end, 3.1);
  assert.equal(alignment.lines[0].words.length, 5);
  assert.equal(alignment.lines[1].text, 'Shadows call my name');
  assert.equal(alignment.lines[1].start, 4.3);
  assert.equal(alignment.lines[1].end, 6.1);
  assert.equal(alignment.lines[1].words.length, 4);
});

test('buildForcedAlignmentLines preserves section tags and maps aligned words onto original lyrics lines', () => {
  const rawLyrics = `[Verse 1]
City lights are fading out
Into the midnight glow

[Chorus]
We run forever`;

  const alignedTokens = [
    { text: 'City', start: 2.1, end: 2.5, loss: 0.01 },
    { text: 'lights', start: 2.55, end: 2.9, loss: 0.02 },
    { text: 'are', start: 2.95, end: 3.1, loss: 0.01 },
    { text: 'fading', start: 3.15, end: 3.6, loss: 0.01 },
    { text: 'out', start: 3.65, end: 4.1, loss: 0.02 },
    { text: 'Into', start: 4.6, end: 4.9, loss: 0.01 },
    { text: 'the', start: 4.95, end: 5.1, loss: 0.01 },
    { text: 'midnight', start: 5.15, end: 5.7, loss: 0.02 },
    { text: 'glow', start: 5.75, end: 6.4, loss: 0.01 },
    { text: 'We', start: 8.0, end: 8.3, loss: 0.01 },
    { text: 'run', start: 8.35, end: 8.8, loss: 0.01 },
    { text: 'forever', start: 8.85, end: 9.8, loss: 0.02 },
  ];

  const alignment = buildForcedAlignmentLines(rawLyrics, alignedTokens);
  assert.ok(alignment);
  assert.equal(alignment.source, 'forced_alignment');
  assert.equal(alignment.lines.length, 5);

  // [Verse 1] tag inherits start timestamp of the first sung line in that section
  assert.equal(alignment.lines[0].text, '[Verse 1]');
  assert.equal(alignment.lines[0].isTag, true);
  assert.equal(alignment.lines[0].start, 2.1);

  assert.equal(alignment.lines[1].text, 'City lights are fading out');
  assert.equal(alignment.lines[1].isTag, false);
  assert.equal(alignment.lines[1].start, 2.1);
  assert.equal(alignment.lines[1].end, 4.1);
  assert.equal(alignment.lines[1].words.length, 5);

  assert.equal(alignment.lines[2].text, 'Into the midnight glow');
  assert.equal(alignment.lines[2].start, 4.6);
  assert.equal(alignment.lines[2].end, 6.4);

  // [Chorus] tag inherits start timestamp of the chorus line
  assert.equal(alignment.lines[3].text, '[Chorus]');
  assert.equal(alignment.lines[3].isTag, true);
  assert.equal(alignment.lines[3].start, 8.0);

  assert.equal(alignment.lines[4].text, 'We run forever');
  assert.equal(alignment.lines[4].start, 8.0);
  assert.equal(alignment.lines[4].end, 9.8);
});

test('sanitizeAlignedLineWords pulls premature CTC silence blips forward without touching held melismas', () => {
  // Case 1: Premature CTC blip on first word at 0.08s followed by 11.7s of silence before singing at 11.8s
  const blipWords = [
    { text: 'I', start: 0.08, end: 0.2, loss: 2.1 },
    { text: 'always', start: 11.8, end: 12.2, loss: 0.1 },
    { text: 'knew', start: 12.22, end: 12.5, loss: 0.1 },
  ];
  const fixedBlip = sanitizeAlignedLineWords(blipWords);
  assert.ok(fixedBlip[0].start >= 11.3, `Expected first word to be pulled near 11.8s, got ${fixedBlip[0].start}`);
  assert.ok(fixedBlip[0].end <= 11.8);

  // Case 2: Legitimate 3.8s held melisma on second word ("Before time" held from 169.28 -> 173.08)
  const melismaWords = [
    { text: 'Before', start: 168.58, end: 169.22, loss: 0.2 },
    { text: 'time', start: 169.28, end: 173.08, loss: 2.4 },
    { text: 'gets', start: 173.08, end: 173.34, loss: 0.1 },
  ];
  const preservedMelisma = sanitizeAlignedLineWords(melismaWords);
  assert.equal(preservedMelisma[0].start, 168.58);
  assert.equal(preservedMelisma[1].start, 169.28);
  assert.equal(preservedMelisma[1].end, 173.08);
});

test('prepareVocalStemWavForElevenLabs downsamples 48kHz stereo 16-bit WAV to 16kHz mono preserving exact duration', () => {
  const sampleRate = 48000;
  const numChannels = 2;
  const durationSec = 2;
  const totalFrames = sampleRate * durationSec;
  const dataSize = totalFrames * numChannels * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * 2, 28);
  buf.writeUInt16LE(numChannels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  const downsampled = prepareVocalStemWavForElevenLabs(buf);
  assert.equal(downsampled.readUInt16LE(22), 1); // mono
  assert.equal(downsampled.readUInt32LE(24), 16000); // 16kHz
  const outDataSize = downsampled.readUInt32LE(40);
  const outFrames = outDataSize / 2;
  assert.equal(outFrames / 16000, durationSec); // exact 2.0s duration preserved
  assert.ok(downsampled.length < buf.length / 5); // 6x smaller
});

test('buildForcedAlignmentLines treats multi-bracket tag lines as tags and preserves 1-to-1 line breaks', () => {
  const rawLyrics = `[Verse 1] [Intimate Vocal]
Walking through the neon rain, shadows call my name`;

  const alignedTokens = [
    { text: 'Walking', start: 1.0, end: 1.4, loss: 0.01 },
    { text: 'through', start: 1.45, end: 1.8, loss: 0.01 },
    { text: 'the', start: 1.85, end: 2.0, loss: 0.01 },
    { text: 'neon', start: 2.05, end: 2.5, loss: 0.01 },
    { text: 'rain,', start: 2.55, end: 3.1, loss: 0.01 },
    { text: 'shadows', start: 4.3, end: 4.8, loss: 0.01 },
    { text: 'call', start: 4.85, end: 5.2, loss: 0.01 },
    { text: 'my', start: 5.25, end: 5.5, loss: 0.01 },
    { text: 'name', start: 5.55, end: 6.1, loss: 0.01 },
  ];

  const alignment = buildForcedAlignmentLines(rawLyrics, alignedTokens);
  assert.ok(alignment);
  assert.equal(alignment.lines.length, 2);
  assert.equal(alignment.lines[0].text, '[Verse 1] [Intimate Vocal]');
  assert.equal(alignment.lines[0].isTag, true);
  assert.equal(alignment.lines[0].start, 1.0);
  assert.equal(alignment.lines[1].text, 'Walking through the neon rain, shadows call my name');
  assert.equal(alignment.lines[1].isTag, false);
  assert.equal(alignment.lines[1].start, 1.0);
  assert.equal(alignment.lines[1].end, 6.1);
  assert.equal(alignment.lines[1].words.length, 9);
});


