import { z } from 'zod';

export const generateSchema = z.object({
  creatorAddress: z.string().min(10), prompt: z.string().refine((value) => value.trim().length >= 3),
  licenses: z.number().int().nonnegative().optional(), stream_price: z.number().finite().nonnegative().optional(), license_price: z.number().finite().nonnegative().optional(),
  title: z.string().optional(), image: z.string().optional(), albumId: z.string().optional(), lyrics: z.string().optional(), instrumental: z.boolean().optional(),
  modelVariant: z.enum(['turbo', 'sft']).default('turbo'), vocalLanguage: z.string().optional(),
  bpm: z.number().finite().min(30).max(300).optional(), keyScale: z.string().optional(),
  audioDuration: z.number().finite().min(5).max(300).optional(), seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), voiceId: z.string().min(1).optional(),
  voiceReferenceUrl: z.string().url().optional(), voiceCoverStrength: z.number().finite().min(0).max(1).optional(), tags: z.array(z.string()).optional(),
  voiceMode: z.enum(['reference', 'trained']).optional(),
}).superRefine((value, context) => {
  if (value.voiceId && value.voiceReferenceUrl) context.addIssue({ code: 'custom', path: ['voiceReferenceUrl'], message: 'Choose a saved voice or direct reference audio' });
  if (value.voiceId && !value.voiceMode) context.addIssue({ code: 'custom', path: ['voiceMode'], message: 'Choose reference audio or a prepared saved voice' });
  if (value.voiceMode === 'trained' && !value.voiceId) context.addIssue({ code: 'custom', path: ['voiceId'], message: 'A trained voice requires its saved voice ID' });
  if (value.voiceMode === 'reference' && !value.voiceId && !value.voiceReferenceUrl) context.addIssue({ code: 'custom', path: ['voiceId'], message: 'A reference voice requires saved or direct audio' });
});
