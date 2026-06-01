#!/usr/bin/env node
/**
 * WordPress XML export → Astro MDX migration script.
 *
 * Usage:
 *   node scripts/migrate-wp.mjs ./wp-export.xml ./src/content/blog/
 *
 * After running:
 *   1. Fix WP shortcodes that Turndown didn't convert cleanly
 *   2. Add coverImage paths for posts that had featured images
 *   3. Add description if empty (WP excerpts are often blank)
 *   4. Remove or fix any draft: false posts you don't want published
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { XMLParser } from 'fast-xml-parser';
import TurndownService from 'turndown';

const [, , inputFile, outputDir] = process.argv;

if (!inputFile || !outputDir) {
  console.error('Usage: node scripts/migrate-wp.mjs <wp-export.xml> <output-dir>');
  process.exit(1);
}

if (!existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

const xml = readFileSync(inputFile, 'utf-8');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  cdataPropName: '__cdata',
});
const data = parser.parse(xml);

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  hr: '---',
});

// Handle WP's pre/code blocks
td.addRule('wpPre', {
  filter: ['pre'],
  replacement: (content) => `\`\`\`\n${content.trim()}\n\`\`\`\n\n`,
});

// Strip WP shortcodes that can't be converted
td.addRule('wpShortcodes', {
  filter: (node) => node.nodeName === '#text',
  replacement: (content) => content.replace(/\[[\w_-]+[^\]]*\][\s\S]*?\[\/[\w_-]+\]|\[[\w_-]+[^\]]*\/?\]/g, ''),
});

function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val.__cdata) return val.__cdata;
  return String(val);
}

function extractCategories(item) {
  if (!item.category) return [];
  const cats = Array.isArray(item.category) ? item.category : [item.category];
  return cats
    .filter(c => c && c['@_domain'] !== 'category') // skip top-level categories, keep tags
    .map(c => extractText(c['#text'] ?? c))
    .filter(Boolean);
}

const channel = data.rss?.channel;
if (!channel) {
  console.error('Invalid WP export XML — no channel element found');
  process.exit(1);
}

const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
const posts = items.filter(
  item => extractText(item['wp:post_type']) === 'post' &&
          extractText(item['wp:status']) === 'publish'
);

console.log(`Found ${posts.length} published posts to migrate`);

let success = 0;
let skipped = 0;

for (const item of posts) {
  const title = extractText(item.title);
  const rawSlug = extractText(item['wp:post_name']) || slugify(title);
  const slug = slugify(rawSlug) || `post-${extractText(item['wp:post_id'])}`;

  const pubDate = new Date(extractText(item.pubDate));
  const dateStr = isNaN(pubDate.getTime()) ? new Date().toISOString().slice(0, 10) : pubDate.toISOString().slice(0, 10);

  const rawContent = extractText(item['content:encoded']);
  if (!rawContent.trim()) {
    console.log(`SKIP (empty content): ${title}`);
    skipped++;
    continue;
  }

  let markdown = '';
  try {
    markdown = td.turndown(rawContent);
  } catch (err) {
    console.warn(`WARN: Turndown error for "${title}": ${err.message}`);
    markdown = rawContent; // fallback to raw HTML
  }

  const excerpt = extractText(item['excerpt:encoded'])
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 200);

  const tags = extractCategories(item);
  const wpId = parseInt(extractText(item['wp:post_id']), 10);

  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedExcerpt = excerpt.replace(/"/g, '\\"');

  const frontmatter = [
    '---',
    `title: "${escapedTitle}"`,
    `description: "${escapedExcerpt || 'TODO: add description'}"`,
    `date: ${dateStr}`,
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    `draft: false`,
    wpId ? `wpId: ${wpId}` : '',
    '---',
    '',
  ].filter(line => line !== undefined).join('\n');

  const outPath = join(outputDir, `${slug}.mdx`);

  if (existsSync(outPath)) {
    console.log(`SKIP (exists): ${outPath}`);
    skipped++;
    continue;
  }

  writeFileSync(outPath, frontmatter + markdown + '\n');
  console.log(`OK: ${outPath}`);
  success++;
}

console.log(`\nDone: ${success} migrated, ${skipped} skipped`);
