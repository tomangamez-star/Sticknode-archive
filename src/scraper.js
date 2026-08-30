'use strict';
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
// We'll import the parser functions later if needed directly here or via relative path
const { parseListing, parseDetail } = require('./parser');
// Utility exports (ensure these match your utils file)
const { sleep, clean, sha256, filenameFromUrl, fileTypeOf, tagsFromTitle, htmlEscape, formatBytes } = require('./utils');

// --- Configuration & Imports for Cloudflare Bypass ---
const USER_AGENT = String(process.env.STICKNODES_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36').trim();

// Import and configure Puppeteer with Stealth Plugin
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// Optional: If you want to handle cookies more persistently across restarts in the future 
// you might add a cookieJar lib here, but for now we manage via headers/cookies map.
puppeteer.use(StealthPlugin());

let browserInstance = null; // Persistent browser instance per process run

/**
 * Initialize or reuse the persistent headless browser instance.
 * This is called once at startup (or lazily) to avoid spinning up new browsers constantly.
 */
async function ensureBrowser() {
  if (!browserInstance) {
    console.log('[scraper] Initializing persistent Puppeteer session...');
    try {
      browserInstance = await puppeteer.launch({
        headless: 'new', // Use 'new' mode for better performance in Docker/Render environments
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage', // Reduce memory usage on containerized builds
          '--disable-gpu'         // Often safe and faster in serverless/container contexts
        ],
        defaultViewport: null, // Let Puppeteer manage viewport or set explicitly if needed
        timeout: 30000,        // Initial connection timeout
      });
      console.log('[scraper] Persistent browser session created.');
    } catch (err) {
      console.error('[scraper] Failed to launch persistent browser:', err.message);
      throw new Error('Persistent Browser Launch Failure');
    }
  } else {
    try {
      await browserInstance.pages()[0].waitForFunction(
        () => !document.querySelector('.cf-spinner') && document.body.innerHTML.length > 100, 
        { timeout: 5000 }, 
        'browser idle check' // Just a sanity check that JS has loaded somewhat before heavy ops if needed later
      ).catch(() => {}); 
    } catch (e) {}
  }

  return browserInstance;
}

/**
 * Fetches HTML from StickNodes using the persistent Puppeteer session.
 * This function handles Cloudflare challenges by loading the page in a headless context,
 * extracting `cf_clearance` cookies if present, and then returning the full content.
 */
async function fetchWithStealth(url) {
  const browser = await ensureBrowser();
  
  // Use an isolated newPage for this specific request to prevent cookie pollution across different scrape targets 
  // unless you want them all on one global tab (which is usually fine for same-domain sites).
  const page = await browser.newPage();
  
  try {
    console.log(`[stealth] Navigating to: ${url}`);

    await page.setUserAgent(USER_AGENT);

    // Set a realistic viewport so Cloudflare doesn't flag it as tiny/mobile-exception immediately if that's their rule.
    await page.setViewport({ width: 1920, height: 1080 }); 

    // Initial navigation with stealth plugin active.
    const response = await page.goto(url, { 
      waitUntil: 'networkidle2', // Wait until network idle for more robust loading of JS/Cookies
      timeout: 35000            // Slightly longer timeout for heavy sites like StickNodes
    });

    console.log(`[stealth] Status after initial load: ${response.status()}`);

    let content;

    if (response.ok()) {
        // If status is OK (2xx), we have real content!
        content = await page.content();
        
        // Extract and remember cookies from this successful session for future HTTP fetches.
        const cookies = await page.cookies(['cf_clearance']); 
        if (cookies.length > 0) {
          console.log('[scraper] Successful session loaded valid cf_clearance cookie.');
          return { success: true, html: content, headers: response.headers(), cookies };
        } else {
            console.warn('[stealth] Status OK but no cf_clearance found yet; might be first visit or short-lived.');
            return { success: true, html: content, headers: response.headers() };
        }

    } else if ([429, 503].includes(response.status())) {
         // Rate limit / Server error - try again after wait.
         await sleep(1000); 
         console.log(`[scraper] Retrying due to ${response.status()}...`);
         const retryResponse = await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 });
         
         if (retryResponse.ok()) {
             content = await retryResponse.json ? await retryResponse.text() : ''; // Fallback text extraction
             return { success: true, html: content || '', headers: retryResponse.headers() };
         } else {
            throw new Error(`Still blocked or rate limited after retry (${retryResponse.status()})`);
         }

    } else if ([401].includes(response.status())) { 
        // Auth required - unlikely for public pages but handled.
        console.warn('[stealth] Status 401 detected');
        const snippet = await responseSnippet(response.clone(), 500);
        const error = new Error(`HTTP 401 Unauthorized from StickNodes — ${snippet}`);
        error.code = 'STICKNODES_401';
        throw error;

    } else {
        // Likely a fresh Cloudflare Challenge (38, 67, etc.) or initial 403 blocking the body yet loading iframe.
        if (!response.ok() && !/Just a moment/.test(await page.content())) {
            console.log('[stealth] Non-OK status but might have loaded content with JS. Checking for challenge text...');
             content = await page.content(); 
             const titleCheck = content.includes('Just a moment...') || response.url().includes('/challenges.cloudflare.com');
             
             if (titleCheck) {
                 console.warn(`[scraper] Still seeing Cloudflare Challenge on ${url} after initial load.`);
                 // If we got here and still see 'Just a moment', the first goto didn't fully resolve or needed interaction.
                 // Sometimes waiting a bit helps if it was a dynamic redirect.
                 try {
                     await sleep(1500); // Wait 1-2s for JS to finish rendering challenge -> maybe refresh?
                     const freshResp = await page.goto(url, { waitUntil: 'networkidle0' }); 
                     content = await freshResp.text(); 
                     
                     if (freshResp.ok()) return { success: true, html: content, headers: freshResp.headers() };
                     else throw new Error(`Still blocked on retry (${freshResp.status()})`);

                 } catch(e) {
                     console.error('[stealth] Retry failed:', e.message);
                 }
             }
        } else {
            // Some other non-standard code, treat as error.
            const snippet = await responseSnippet(response.clone(), 500);
            console.warn(`[scraper] Non-2xx status from StickNodes: ${response.status()} — ${snippet}`);
            if (!response.ok()) throw new Error(`HTTP ${response.status()}: ${response.statusText} (Check Challenge)`); 
        }
    }

    return content || ""; 

  } finally {
      // Close the temporary page used for this specific fetch to free up resources? 
      // Or keep browser alive and manage pages manually. For now we leave it open for next scrape.
      // Note: We created 'page' locally here, closing isn't strictly needed unless memory is tight per request.
  }
}

// --- Helper Functions (Refactored from original) ---

const cookieJar = new Map();

function rememberCookies(headers) {
  let values = [];
  try {
    if (typeof headers.getSetCookie === 'function') values = headers.getSetCookie();
  } catch (_) {}
  
  if (!values.length) {
    const combined = headers.get('set-cookie');
    if (combined) values = [combined];
  }

  for (const raw of values) {
    // We only need the cookie name/value. Attributes are intentionally ignored.
    const first = String(raw || '').split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    
    // Handle potential double quotes in names/values which sometimes happen with cf_clearance etc. 
    // Split by '=' then trim spaces/quotes carefully.
    let parts = first.split('=');
    if(parts.length < 2) continue; 
    
    let name = parts[0].trim();
    let value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');

    if (name && !value.includes('.')) { // Basic filter: don't store weird paths as cookies unless they look like key=value pairs properly split
        cookieJar.set(name, value);
        console.log(`[scraper] Cookie remembered: ${name}=${value}`); // Debug logging for cf_clearance specifically would be useful.
    }
  }
  
  return cookieJar.size > 0; 
}

function cookiesHeader() {
  const arr = [...cookieJar.entries()].filter(([k]) => k !== 'cf_clearance'); // Exclude CF cookie from standard header set to prevent loop issues? Or include it later in fetch.
  if(arr.length === 0) return '';
  
  let result = arr.map(([k, v]) => `${k}=${v}`).join('; ');
  if(result) return `Cookie: ${result};`; 
  
  return ''; 
}

// Add cf_clearance handling specifically during fetchWithRetry or manual calls below.
async function warmPublicSession() {
    if (sessionWarmed) return true;
    if (sessionWarmPromise) return sessionWarmPromise;

    sessionWarmPromise = (async () => {
        const homeUrl = new URL('/', config.baseUrl); // StickNodes root
        console.log(`[scraper] Warming up public session at ${homeUrl}`);

        try {
            // Use the stealth browser to hit home first to grab initial cookies including potential cf_clearance from homepage redirect.
            let tempPage, tempResp; 
            tempPage = await ensureBrowser().then(b => b.newPage()); 
            
            await tempPage.setUserAgent(USER_AGENT);
            
            // Visit Home - this often sets a "session" cookie or refreshes cf_challenge state if any exists for IP.
            const resp = await tempPage.goto(homeUrl.href + '?wpfb_list_page=1', { waitUntil: 'networkidle2' }); 

            // Extract all set-cookie headers from this successful-looking (or challenge-redirecting) page
             const cookies = await tempPage.cookies();
             
             // If we got here and have at least one cookie, try to use it against the list URL. 
             // Sometimes just visiting home updates the session token even without explicit 403 bypass yet.
             if(cookies.length > 0) {
                 console.log(`[scraper] Found ${cookies.length} cookies on homepage.`);
                 
                 // Try to load listing with these cookies already attached conceptually for future fetches.
                 return true; 
             }

            return false; 

        } catch (error) {
           console.warn(`[scraper] Session warm-up failed: ${error.message}`);
           return false;
        } finally {
            tempPage.close(); // Clean up temp page used just for warming
            sessionWarmPromise = null;
        }
    })();

    try { await sessionWarmPromise; } catch(e){ /* ignore */ }; 
    return !!sessionWarmPromise || !sessionWarmPromise ? !!sessionWarmPromise : false; 
}


// --- Core Fetch Pipeline with Cloudflare Logic ---

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;

  const kind = options.kind || 'html'; // 'html' or 'file' (for downloads later which might need different UA handling if sticknodes blocks user agents on assets too).
  
  for (let i = 0; i < attempts; i += 1) {
    
    // Prepare headers based on current cookie jar state + UserAgent.
    const headersBase = requestHeaders(kind);

    try {
      // Attempt standard HTTP fetch first to save resources unless we know it's blocked/needs stealth.
      // But since Cloudflare intercepts, often the first raw fetch gets a 403 immediately.
      
      let response; 
      
      // Smart Retry Strategy: First try raw fetch, if 403 -> use Stealth Browser helper.
      response = await fetch(url, { redirect: 'follow', method: options.method || 'GET', headers: headersBase });
      
      rememberCookies(response.headers); 

      if (response.status === 403) {
          console.log(`[scraper] Raw Fetch got HTTP 403 on ${url}. Switching to Stealth Browser helper for this request.`);
          
          // Use our stealth helper which sets up the browser context and tries again.
          const result = await fetchWithStealth(url); 
          
          // If fetchWithStealth returned an object with html/headers, use that. 
          if (result && typeof result.html !== 'undefined') {
              response = new Response(result.html);
              response.url = url; // Mock URL property since Response might need it? Not strictly needed here but good practice.
              
              rememberCookies(response.headers || {}); 
              return response; 
          } else {
             throw blockedError(url, response.clone()); 
          }

      } else if ([429, 503].includes(response.status())) {
        const retryAfterStr = String(response.headers.get('retry-after') || 0).split('/')[0]; // handle seconds/mins
        const retryMs = Number(retryAfterStr) * (Number(new Date().getTimezoneOffset()/60)) > 1 ? Math.max(10, Number(retryAfterStr)*60*1000) : Math.max(2, Number(retryAfterStr) * 1000); 
        
         console.log(`[scraper] Rate limited (${response.status}). Waiting ${retryMs/1000}s before next attempt.`); 
         await sleep(Math.min(retryMs, 3500)); // Cap wait at ~3.5s to avoid long hangs in CI
         continue;

      } else if (!response.ok && [408, 504].includes(response.status())) {
          // Network timeout or gateway errors from StickNodes side. Wait and retry.
           const ms = Math.min(2**(i+1)*500, 6000);
           console.warn(`[scraper] Transient network error (${response.status}). Retrying...`);
           await sleep(ms);
           continue;
      }

      return response; 
      
    } catch (error) {
        lastError = error;
        if (lastError.code === 'STICKNODES_FORBIDDEN' && i + 1 < attempts) {
            console.log(`[scraper] Re-trying blocked request ${i + 1}/${attempts}...`);
             // Try stealth helper for this specific retry attempt.
             const result = await fetchWithStealth(url); 
             if(result && typeof result.html !== 'undefined') {
                 return new Response(result.html, { headers: Object.fromEntries(Object.entries(response.headers).concat([['url', url], ['statusText', response.statusText]])) });
             } else {
                 throw lastError; // Retry failed or still stuck.
             }
        } else if (error.message === 'Too many open files' || error.code === 'ERR_TOO_MANY_REDIRECTS') {
            console.warn(`[scraper] ${error.message}`);
            await sleep(1000); // Short wait for socket cleanup etc.
        } else {
            console.error(`[scraper] Fetch Error on attempt ${i}:`, error.message); 
            await sleep(1000 * Math.pow(2, i)); // Exponential backoff for other errors.
        }
    }

  }

  throw lastError || new Error('Request failed after attempts');
}


// --- Standard HTTP Request Helpers (Used by existing pipeline) ---

function requestHeaders(kind = 'html', referer = '') {
  const html = kind === 'html';
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': html ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' : 'application/octet-stream,application/zip;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no
