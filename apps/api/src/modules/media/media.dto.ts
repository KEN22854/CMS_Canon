import { z } from 'zod';

const folder = z
  .string()
  .trim()
  .regex(/^\/([\w-]+\/)*([\w-]+)?$/, 'Folders look like /brand/logos')
  .max(200);

export const listMediaQuery = z.object({
  folder: folder.optional(),
  tag: z.string().max(50).optional(),
  kind: z.enum(['image', 'video', 'document']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  cursor: z.string().optional(),
});
export type ListMediaQuery = z.infer<typeof listMediaQuery>;

export const presignBody = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(100),
  size: z.number().int().positive(),
  folder: folder.default('/'),
});
export type PresignBody = z.infer<typeof presignBody>;

export const updateMediaBody = z
  .object({
    alt: z.string().max(300).nullable(),
    caption: z.string().max(500).nullable(),
    title: z.string().max(200).nullable(),
    folder,
    tags: z.array(z.string().trim().toLowerCase().min(1).max(50)).max(30),
  })
  .partial()
  .strict();
export type UpdateMediaBody = z.infer<typeof updateMediaBody>;

export const uploadFields = z.object({ folder: folder.default('/'), alt: z.string().max(300).optional() });
