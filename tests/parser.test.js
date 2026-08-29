'use strict';
const assert = require('assert');
const { parseListing, parseDetail } = require('../src/parser');

const listing = `
<html><body><ul>
<li class="entry"><a href="/download/people/Cammy-White-Movieclip.nodemc">Cammy White Movieclip</a>
<a href="/members/mxanimator">MxAnimator</a><span>(People)</span><span>August 29, 2026</span><span>Hits: 163</span>
<a href="/sticks/cammy-white-movieclip-nodemc/">View comments (4) »</a></li>
<li class="entry"><a href="/download/packs/Arizona-Desert-Background-Pack.zip">Arizona Desert Background Pack</a>
<a href="/members/warlock">Warlock</a><span>(Packs 3)</span><span>August 29, 2026</span><span>Hits: 302</span>
<a href="/sticks/arizona-desert-background-pack-zip/">View comments (1) »</a></li>
</ul></body></html>`;
const items = parseListing(listing, 'https://sticknodes.com/stickfigures/');
assert.equal(items.length, 2);
assert.equal(items[0].file_type, 'movieclip');
assert.equal(items[0].category, 'people');
assert.equal(items[0].original_filename, 'Cammy-White-Movieclip.nodemc');
assert.equal(items[0].detail_url, 'https://sticknodes.com/sticks/cammy-white-movieclip-nodemc/');
assert.equal(items[1].file_type, 'pack');
assert.equal(items[1].category, 'packs');
assert.equal(items[1].pack_count, 3);

const detail = `<html><body><main><h1>Arizona Desert Background Pack</h1>
<p><a href="/members/warlock">Warlock</a> @demonic</p>
<p>File:Arizona-Desert-Background-Pack.zip (17.7 KB)</p>
<p>Date:August 29, 2026</p><p>Category:Packs Backgrounds</p>
<p>Hello, this time, I have a background.</p><p><a href="/tags/cactus">#cactus</a> <a href="/tags/desert">#desert</a></p>
<a href="/download/packs/Arizona-Desert-Background-Pack.zip">Download File</a></main></body></html>`;
const parsed = parseDetail(detail, 'https://sticknodes.com/sticks/arizona-desert-background-pack-zip/', items[1]);
assert.equal(parsed.title, 'Arizona Desert Background Pack');
assert.equal(parsed.original_filename, 'Arizona-Desert-Background-Pack.zip');
assert.equal(parsed.file_type, 'pack');
assert.equal(parsed.category, 'packs');
assert(parsed.categories.includes('backgrounds'));
assert(parsed.tags.includes('cactus'));
assert(parsed.tags.includes('desert'));
assert.equal(parsed.declared_size_bytes, Math.round(17.7 * 1024));
console.log('parser.test.js OK');
