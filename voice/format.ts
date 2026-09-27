import { parseAddress } from '../databases/users.js';

export class VoiceInputError extends Error {
  readonly statusCode = 400;
}

export function validateVoiceFormat(buffer: Buffer, fileName: string, mimeType: string): string {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new VoiceInputError('Audio file is empty');
  if (typeof fileName !== 'string' || !fileName.trim() || /[\\/\u0000-\u001f\u007f]/.test(fileName)) throw new VoiceInputError('Audio filename must be a plain filename');
  const mime = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  const formats: Record<string, { extension: string; valid: boolean }> = {
    'audio/wav': { extension: 'wav', valid: buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE' },
    'audio/x-wav': { extension: 'wav', valid: buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE' },
    'audio/mpeg': { extension: 'mp3', valid: buffer.toString('ascii', 0, 3) === 'ID3' || (buffer.length >= 2 && buffer[0] === 255 && (buffer[1] & 0xe0) === 0xe0) },
    'audio/flac': { extension: 'flac', valid: buffer.toString('ascii', 0, 4) === 'fLaC' },
    'audio/x-flac': { extension: 'flac', valid: buffer.toString('ascii', 0, 4) === 'fLaC' },
    'audio/ogg': { extension: 'ogg', valid: buffer.toString('ascii', 0, 4) === 'OggS' },
    'audio/aac': { extension: 'aac', valid: buffer.length >= 2 && buffer[0] === 255 && (buffer[1] & 0xf6) === 0xf0 },
    'audio/mp4': { extension: 'm4a', valid: buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' },
    'audio/x-m4a': { extension: 'm4a', valid: buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' },
    'audio/webm': { extension: 'webm', valid: buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3 },
  };
  const format = formats[mime];
  if (!format || !format.valid) throw new VoiceInputError('File content must match a supported audio format');
  const suffix = fileName.includes('.') ? fileName.split('.').pop()! : '';
  return /^[a-z\d]+$/i.test(suffix) ? suffix : format.extension;
}

export function validateVoiceCreator(creator: string): string {
  try { return parseAddress(creator).value; }
  catch { throw new VoiceInputError('creator must be a valid wallet address'); }
}
