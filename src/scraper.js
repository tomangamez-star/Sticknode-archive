'use strict';
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { parseListing, parseDetail } = require('./parser');
const { sleep, clean, sha256, filenameFromUrl, fileTypeOf, tagsFromTitle, htmlEscape, formatBytes } = require('./utils');

// Cloudflare Bypass Dependencies
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Using a stable, realistic User Agent to prevent immediate detection
const USER_AGENT = String(process.env.STICKNODES_USER_AGENT || 
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36').trim();

/**
 * Uses a stealth headless browser to solve the Cloudflare "Just a moment" challenge.
 * Replace your standard http/axios calls with this function.
 */
async function fetchWithStealth(url) {
    const browser = await puppeteer.launch({ 
        headless: "new", 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    try {
        console.log(`[stealth] Navigating to: ${url}`);
        // networkidle2 ensures the Cloudflare JS challenge has completed
        await page.goto(url, { waitUntil: 'networkidle2' });

        // Wait for the actual content to load
        await page.waitForSelector('body', { timeout: 30000 });

        const content = await page.content();
        console.log('[stealth] Bypass successful.');
        return content;
    } catch (error) {
        console.error('[stealth] Bypass failed:', error.message);
        return null;
    } finally {
        await browser.close();
    }
}

const cookieJar = new Map();
let sessionWarmPromise = null;
let sessionWarmed = false;
let bot = null;
let runningPromise = null;

module.exports = {
    fetchWithStealth,
    // ... export your other existing functions here
};
