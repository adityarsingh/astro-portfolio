import type { CollectionEntry } from 'astro:content';

export function getTagCounts(posts: CollectionEntry<'blog'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

export function getSortedTags(posts: CollectionEntry<'blog'>[]): Array<[string, number]> {
  return Array.from(getTagCounts(posts).entries()).sort((a, b) => b[1] - a[1]);
}
