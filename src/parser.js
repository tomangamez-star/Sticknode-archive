'use strict';
const cheerio = require('cheerio');
const { clean, filenameFromUrl, fileTypeOf, parseByteSize, tagsFromTitle } = require('./utils');

const CATEGORY_NAMES = ['Backgrounds','Effects','Miscellaneous','Objects','Packs','People','Weapons','Vehicles'];
function absolute(base, href) { try { return new URL(href, base).href; } catch (_) { return ''; } }
function categoryFromDownload(downloadUrl) {
  try {
    const p = new URL(downloadUrl).pathname.toLowerCase();
    const found = CATEGORY_NAMES.find((x) => p.includes(`/download/${x.toLowerCase()}/`));
    return (found || 'Miscellaneous').toLowerCase();
  } catch (_) { return 'miscellaneous'; }
}
function findContainer($, node) {
  let current = $(node);
  for (let i = 0; i < 8 && current.length; i += 1) {
    const text = clean(current.text());
    if (/Hits:\s*[\d,]+/i.test(text) && current.find('a[href*="/sticks/"]').length) return current;
    current = current.parent();
  }
  return $(node).parent();
}

function parseListing(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  $('a[href*="/download/"]').each((_, node) => {
    const href = absolute(pageUrl, $(node).attr('href'));
    if (!href || seen.has(href)) return;
    const filename = filenameFromUrl(href);
    if (!/\.(?:nodes|nodemc|stk|zip)$/i.test(filename)) return;
    const container = findContainer($, node);
    const title = clean($(node).text()) || filename.replace(/\.(nodes|nodemc|stk|zip)$/i, '').replace(/[-_]+/g, ' ');
    const text = clean(container.text());
    const detailAnchor = container.find('a[href*="/sticks/"]').filter((__, a) => /comments|view/i.test($(a).text()) || /\/sticks\//i.test($(a).attr('href') || '')).first();
    const detailUrl = absolute(pageUrl, detailAnchor.attr('href'));
    const categoryMatch = text.match(/\((Backgrounds|Effects|Miscellaneous|Objects|People|Weapons|Vehicles|Packs)(?:\s+(\d+))?\)/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : categoryFromDownload(href);
    const packCount = categoryMatch && categoryMatch[2] ? Number(categoryMatch[2]) : 0;
    const hitsMatch = text.match(/Hits:\s*([\d,]+)/i);
    const dateMatch = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
    let creator = '';
    container.find('a').each((__, a) => {
      if (creator) return;
      const ahref = $(a).attr('href') || '';
      const label = clean($(a).text());
      if (!label || ahref === $(node).attr('href') || /comments|download|vote/i.test(label)) return;
      if (/\/members\/|\/author\/|\/members\//i.test(ahref)) creator = label;
    });
    const fileType = fileTypeOf(filename, title);
    items.push({
      source_url: href,
      download_url: href,
      detail_url: detailUrl,
      source_page: pageUrl,
      title,
      original_filename: filename,
      file_type: fileType,
      category: fileType === 'pack' ? 'packs' : category,
      categories: [fileType === 'pack' ? 'packs' : category],
      tags: tagsFromTitle(title, category, fileType),
      creator,
      source_date: dateMatch ? dateMatch[0] : '',
      source_hits: hitsMatch ? Number(hitsMatch[1].replace(/,/g, '')) : 0,
      pack_count: packCount,
      declared_size_bytes: 0,
      description: '',
      creator_handle: '',
    });
    seen.add(href);
  });
  return items;
}

function parseDetail(html, detailUrl, seed = {}) {
  const $ = cheerio.load(html);
  const bodyText = clean($('body').text());
  const heading = clean($('h1').first().text()) || seed.title || '';
  const fileMatch = bodyText.match(/File:\s*([^\s][^()]+?)\s*\(([^)]+)\)/i);
  const dateMatch = bodyText.match(/Date:\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/i);
  const categoryPattern = CATEGORY_NAMES.join('|');
  const categoryBlock = bodyText.match(new RegExp(`Category:\\s*((?:(?:${categoryPattern})\\s*)+)`, 'i'));
  const categories = [];
  if (categoryBlock) {
    for (const name of CATEGORY_NAMES) if (new RegExp(`\\b${name}\\b`, 'i').test(categoryBlock[1])) categories.push(name.toLowerCase());
  }
  const hashtags = [];
  $('a').each((_, a) => {
    const text = clean($(a).text());
    if (/^#[\p{L}\p{N}_-]+$/u.test(text)) hashtags.push(text.slice(1).toLowerCase());
  });
  let creator = seed.creator || '';
  let creatorHandle = '';
  const h1 = $('h1').first();
  let cursor = h1.nextAll().slice(0, 12);
  cursor.find('a').addBack('a').each((_, a) => {
    if (creatorHandle) return;
    const text = clean($(a).text());
    if (text && !text.startsWith('#') && !/download|log in/i.test(text)) {
      creator = creator || text;
      const nearby = clean($(a).parent().text());
      const m = nearby.match(/@([A-Za-z0-9_.-]+)/);
      if (m) creatorHandle = `@${m[1]}`;
    }
  });
  if (!creator) {
    const afterHeadingText = clean(h1.parent().text());
    const m = afterHeadingText.match(new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+([^\n]+?)\\s+(?:Joined:|Guest|File:)`, 'i'));
    if (m) creator = clean(m[1]);
  }

  let description = '';
  const main = $('main, article, .entry-content, .post-content').first();
  if (main.length) {
    const paragraphs = [];
    main.find('p').each((_, p) => {
      const t = clean($(p).text());
      if (t && !/^(File:|Date:|Category:|Downloaded|Download File|How to use:)/i.test(t)) paragraphs.push(t);
    });
    description = paragraphs.join('\n').slice(0, 6000);
  }
  if (!description) {
    const raw = bodyText;
    const start = raw.search(/Category:/i);
    const end = raw.search(/Download File/i);
    if (start >= 0 && end > start) {
      description = clean(raw.slice(start, end).replace(/^Category:\s*/i, '').replace(new RegExp(`^(?:${CATEGORY_NAMES.join('|')})(?:\s+(?:${CATEGORY_NAMES.join('|')}))*`, 'i'), '')).slice(0, 6000);
    }
  }

  const filename = fileMatch ? clean(fileMatch[1]) : seed.original_filename;
  const declaredSize = fileMatch ? parseByteSize(fileMatch[2]) : seed.declared_size_bytes || 0;
  const fileType = fileTypeOf(filename, heading);
  const primaryCategory = fileType === 'pack' ? 'packs' : (categories.find((x) => x !== 'packs') || seed.category || 'miscellaneous');
  const packMatch = bodyText.match(/ZIP\s+of\s+(\d+)\s+files?/i);
  const tags = [...new Set([...(seed.tags || []), ...hashtags, ...categories, ...tagsFromTitle(heading, primaryCategory, fileType)])];
  return {
    ...seed,
    detail_url: detailUrl || seed.detail_url || '',
    title: heading || seed.title,
    original_filename: filename || seed.original_filename,
    file_type: fileType,
    category: primaryCategory,
    categories: categories.length ? categories : (seed.categories || [primaryCategory]),
    tags,
    creator,
    creator_handle: creatorHandle,
    description,
    source_date: dateMatch ? dateMatch[1] : seed.source_date || '',
    declared_size_bytes: declaredSize,
    pack_count: packMatch ? Number(packMatch[1]) : Number(seed.pack_count || 0),
  };
}

module.exports = { parseListing, parseDetail, categoryFromDownload, CATEGORY_NAMES };
