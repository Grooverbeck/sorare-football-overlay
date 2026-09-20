import * as z from 'zod';

export const CardPictureIdSchema = z.string().uuid().transform(value => value.toLowerCase());
export const CardPlayerSlugSchema = z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const CardIdentitySchema = z.object({pictureId: CardPictureIdSchema, playerSlug: CardPlayerSlugSchema});
export const CardIdentitiesRequestSchema = z.object({
  pictureIds: z.array(CardPictureIdSchema).min(1).max(100).transform(ids => [...new Set(ids)]),
}).strict();
export const CardIdentitiesResponseSchema = z.object({
  data: z.array(CardIdentitySchema).max(100),
  retryAfterSeconds: z.number().int().min(60).max(86400),
});
export type CardIdentity = z.infer<typeof CardIdentitySchema>;
export type CardIdentitiesRequest = z.infer<typeof CardIdentitiesRequestSchema>;
export type CardIdentitiesResponse = z.infer<typeof CardIdentitiesResponseSchema>;

export function sorarePictureId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'assets.sorare.com') return null;
    const id = parsed.pathname.match(/\/cardsamplepicture\/([^/]+)\//)?.[1];
    const result = CardPictureIdSchema.safeParse(id);
    return result.success ? result.data : null;
  } catch { return null; }
}
