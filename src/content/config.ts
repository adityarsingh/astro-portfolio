import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title:       z.string(),
    description: z.string(),
    date:        z.coerce.date(),
    updated:     z.coerce.date().optional(),
    tags:        z.array(z.string()).default([]),
    coverImage:  z.string().optional(),
    coverAlt:    z.string().optional(),
    draft:       z.boolean().default(false),
    canonical:   z.string().url().optional(),
    wpId:        z.number().optional(),
  }),
});

const photos = defineCollection({
  type: 'data',
  schema: z.object({
    title:       z.string(),
    description: z.string(),
    date:        z.coerce.date(),
    coverImage:  z.string(),
    coverAlt:    z.string(),
    location:    z.string(),
    images: z.array(z.object({
      src:     z.string(),
      alt:     z.string(),
      width:   z.number(),
      height:  z.number(),
      caption: z.string().optional(),
    })),
  }),
});

export const collections = { blog, photos };
