// science-perplexity-exa.js — Multi-Tier Validation with Exa include_text
// Node.js 20+ compatible
//
// VALIDATION FLOW:
// - TIER 0: Wikipedia "On This Day" (free, fast, name-only for birthdays/deaths)
// - TIER 1: Wikipedia Article (free, requires QID, Portal URLs OK, GPT fallback)
// - TIER 2: Perplexity Validation (main validator, $0.003/event)
//   • YES → PASS immediately
//   • NO (date correct) → Year Auto-Correction
//   • NO (date wrong) → REJECT
//   • UNCLEAR → Proceed to Tier 3
// - TIER 3: Exa Search with include_text (date filter, $0.001/event, 3x retry)
// - TIER 4: Content Verification (GPT-4o-mini check on top results)

const fs = require("fs");
const https = require("https");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXA_API_KEY = process.env.EXA_API_KEY;
const DEBUG = !!Number(process.env.DEBUG ?? 0);

if (!PERPLEXITY_API_KEY) { console.error("❌ Missing PERPLEXITY_API_KEY"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("❌ Missing OPENAI_API_KEY"); process.exit(1); }
if (!EXA_API_KEY) { console.error("❌ Missing EXA_API_KEY"); process.exit(1); }

// ---------- CONFIG ----------

const SCIENCE_CATEGORIES = [
  { 
    name: "Physics & Astronomy", 
    count: 2, 
    description: "Major discoveries in physics (quantum mechanics, particle physics, CERN/LIGO detections), astronomical observations (first light telescopes, supernovae, exoplanets, black holes), breakthrough experiments. Focus on peer-reviewed, globally significant findings."
  },
  { 
    name: "Biology & Medicine", 
    count: 2, 
    description: "Medical breakthroughs (vaccines, antibiotics, surgical innovations, clinical trials), biological discoveries (DNA, genetics, evolution), disease milestones, peer-reviewed results. Focus on findings published in Nature, Science, The Lancet, Cell."
  },
  { 
    name: "Spaceflight & Robotics", 
    count: 1, 
    description: "Mission launches, landings, flybys, orbit insertions (NASA, ESA, Roscosmos, ISRO, CNSA). Rover milestones, satellite deployments, space station events, first-ever spaceflight achievements. Focus on actual missions, not company news."
  },
  { 
    name: "Earth & Climate Science", 
    count: 1, 
    description: "Climate research publications (IPCC reports, peer-reviewed climate studies), geological discoveries (new minerals, fossil findings, plate tectonics insights), oceanographic breakthroughs, environmental science milestones. Focus on SCIENTIFIC FINDINGS and RESEARCH, not natural disasters or casualties."
  },
  { 
    name: "Prizes & Standards", 
    count: 1, 
    description: "Nobel Prize announcements (Physics, Chemistry, Medicine), Fields Medal, Breakthrough Prize, Turing Award. IAU nomenclature decisions, IUPAC element namings, ISO standards. Focus on formal announcements and ratifications."
  },
];

// ---------- Metrics ----------
let METRICS = {
  apiCalls: { perplexity: 0, perplexity_validation: 0, openai: 0, openai_mini: 0, exa_search: 0, exa_contents: 0, wikidata: 0 },
  costs: { perplexity: 0, openai: 0, exa: 0 },
  events: { seeded: 0, enriched: 0, validated: 0, dropped: 0, fallback: 0 },
  dropReasons: {},
  cacheHits: 0,
  validation: {
    tier0_success: 0,
    tier0_fail: 0,
    tier1_success: 0,
    tier1_fail: 0,
    tier1_date_mismatch: 0,
    tier1_gpt_fallback: 0,
    tier2_yes: 0,
    tier2_no: 0,
    tier2_unclear: 0,
    tier2_year_corrected: 0,
    tier3_success: 0,
    tier3_fail: 0,
    tier3_retries: 0,
    tier4_success: 0,
    tier4_fail: 0
  }
};

// ---------- Global Cache ----------
const CONTENTS_CACHE = new Map();
const WIKI_ON_THIS_DAY_CACHE = new Map();
const EXA_SEARCH_CACHE = new Map();
const PERPLEXITY_VALIDATION_CACHE = new Map();
const WIKIDATA_CACHE = new Map();

// ---------- Helpers ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uniq(arr) { return [...new Set(arr)]; }
function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// Extract name from birthday/death titles
function extractName(title, type) {
  if (type !== 'birthday' && type !== 'death') return null;
  
  // Remove common prefixes
  let name = title
    .replace(/^Birth of /i, '')
    .replace(/^Death of /i, '')
    .replace(/^Born: /i, '')
    .replace(/^Died: /i, '')
    .replace(/'s Birthday$/i, '')
    .replace(/'s birth$/i, '')
    .replace(/, pioneer.*/i, '')
    .replace(/, English.*/i, '')
    .replace(/, German.*/i, '')
    .replace(/, American.*/i, '')
    .replace(/, French.*/i, '')
    .replace(/, [a-z]+ mathematician.*/i, '')
    .replace(/, [a-z]+ astronomer.*/i, '')
    .replace(/, [a-z]+ physicist.*/i, '')
    .replace(/, [a-z]+ scientist.*/i, '')
    .replace(/\s*\(\d{4}\)/, '') // Remove year in parentheses
    .trim();
  
  return name;
}

// Multilingual month names
const MONTH_TRANSLATIONS = {
  "January": ["January", "Januar", "Janvier", "Enero", "Gennaio", "1月"],
  "February": ["February", "Februar", "Février", "Febrero", "Febbraio", "2月"],
  "March": ["March", "März", "Mars", "Marzo", "Marzo", "3月"],
  "April": ["April", "April", "Avril", "Abril", "Aprile", "4月"],
  "May": ["May", "Mai", "Mai", "Mayo", "Maggio", "5月"],
  "June": ["June", "Juni", "Juin", "Junio", "Giugno", "6月"],
  "July": ["July", "Juli", "Juillet", "Julio", "Luglio", "7月"],
  "August": ["August", "August", "Août", "Agosto", "Agosto", "8月"],
  "September": ["September", "September", "Septembre", "Septiembre", "Settembre", "9月"],
  "October": ["October", "Oktober", "Octobre", "Octubre", "Ottobre", "10月"],
  "November": ["November", "November", "Novembre", "Noviembre", "Novembre", "11月"],
  "December": ["December", "Dezember", "Décembre", "Diciembre", "Dicembre", "12月"]
};

function getMultilingualDateStrings(monthName, day) {
  const translations = MONTH_TRANSLATIONS[monthName] || [monthName];
  const dayNum = parseInt(day);
  const dayPadded = String(dayNum).padStart(2, '0');
  
  const dateStrings = [];
  
  for (const month of translations) {
    dateStrings.push(
      `${month} ${dayNum}`,
      `${month} ${dayPadded}`,
      `${dayNum} ${month}`,
      `${dayPadded} ${month}`,
      month.toLowerCase() + ` ${dayNum}`,
      `${dayNum} ` + month.toLowerCase()
    );
  }
  
  return uniq(dateStrings);
}

// Parse date from Perplexity's ACTUAL_DATE field
function parsePerplexityDate(dateStr) {
  if (!dateStr) return null;
  
  const patterns = [
    /(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    /(\d{1,2})\s+(\w+),?\s+(\d{4})/i,
    /(\d{4})-(\d{2})-(\d{2})/,
  ];
  
  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      let month, day, year;
      
      if (pattern.source.includes('\\w+')) {
        if (match[1].match(/^\w+$/)) {
          month = match[1];
          day = parseInt(match[2]);
          year = parseInt(match[3]);
        } else {
          day = parseInt(match[1]);
          month = match[2];
          year = parseInt(match[3]);
        }
      } else {
        year = parseInt(match[1]);
        const monthNum = parseInt(match[2]);
        day = parseInt(match[3]);
        const months = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"];
        month = months[monthNum - 1];
      }
      
      return { month, day, year, monthNum: getMonthNumber(month) };
    }
  }
  
  return null;
}

function getMonthNumber(monthName) {
  const months = {
    'january': 1, 'february': 2, 'march': 3, 'april': 4,
    'may': 5, 'june': 6, 'july': 7, 'august': 8,
    'september': 9, 'october': 10, 'november': 11, 'december': 12
  };
  return months[monthName.toLowerCase()] || 0;
}

const UGC_BLOCK = [
  "youtube.com", "youtu.be", "dailymotion.com", "vimeo.com",
  "tiktok.com", "facebook.com", "instagram.com", "x.com", "twitter.com",
  "reddit.com", "medium.com"
];

const ALLOWED_DOMAINS = [
  "bbc.com", "bbc.co.uk", "reuters.com", "apnews.com", "theguardian.com",
  "cnn.com", "nytimes.com", "telegraph.co.uk", "independent.co.uk",
  "nature.com", "science.org", "sciencemag.org", "cell.com", "thelancet.com",
  "scientificamerican.com", "newscientist.com", "sciencedaily.com",
  "pnas.org", "journals.aps.org", "iopscience.iop.org",
  "nasa.gov", "esa.int", "spacex.com", "space.com", "planetary.org",
  "mit.edu", "stanford.edu", "harvard.edu", "ox.ac.uk", "cam.ac.uk",
  "nobelprize.org", "royalsociety.org", "aaas.org",
  "nih.gov", "cdc.gov", "who.int", "mayoclinic.org", "bmj.com",
  "ieee.org", "acm.org", "sciencedirect.com", "springer.com",
  "jstor.org", "archive.org", "loc.gov", "biodiversitylibrary.org",
  "historyofinformation.com", "todayinsci.com", "onthisday.com",
  "si.edu", "nhm.ac.uk", "amnh.org", "exploratorium.edu",
  "wikipedia.org", "en.wikipedia.org", "britannica.com",
  "smithsonianmag.com", "nationalgeographic.com"
];

const EU_DOMAINS = ["bbc.co.uk", "nature.com", "telegraph.co.uk", "theguardian.com", 
  "independent.co.uk", "esa.int", "ox.ac.uk", "cam.ac.uk", "royalsociety.org"];

const HIGH_TRUST_DOMAINS = [
  "wikipedia.org", "en.wikipedia.org", "britannica.com",
  "bbc.co.uk", "bbc.com", "reuters.com", "apnews.com",
  "theguardian.com", "nytimes.com",
  "nature.com", "science.org", "cell.com", "thelancet.com",
  "nasa.gov", "esa.int", "nih.gov", "cdc.gov", "who.int",
  "jstor.org", "archive.org", "loc.gov", "todayinsci.com", "onthisday.com"
];

const HISTORICAL_DOMAINS = [
  "history.com", "historytoday.com", "britannica.com",
  "onthisday.com", "todayinsci.com", "historyofinformation.com",
  "archive.org", "loc.gov", "jstor.org"
];

function allowed(url) {
  const h = host(url);
  return ALLOWED_DOMAINS.some(d => h.includes(d) || d.includes(h));
}

function hasEuropeanSource(sources) {
  return sources.some(url => {
    const h = host(url);
    return EU_DOMAINS.some(d => h.includes(d));
  });
}

function getJSON(hostname, path, headers = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path, method: "GET",
      headers: { ...headers }
    }, res => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", c => data += c);
      res.on("end", () => {
        let json;
        try { json = JSON.parse(data); }
        catch (e) { return reject(new Error(`Parse: ${e.message}`)); }
        if (res.statusCode >= 400) return reject(new Error(`${hostname} ${res.statusCode}: ${data.slice(0, 200)}`));
        resolve(json);
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("Timeout")));
    req.end();
  });
}

function postJSON(hostname, path, payload, headers = {}, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname, port: 443, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers }
    }, res => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", c => data += c);
      res.on("end", () => {
        let json;
        try { json = JSON.parse(data); }
        catch (e) { return reject(new Error(`Parse: ${e.message}`)); }
        if (res.statusCode >= 400) return reject(new Error(`${hostname} ${res.statusCode}: ${json.error?.message || data.slice(0, 200)}`));
        resolve(json);
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("Timeout")));
    req.write(body); req.end();
  });
}

// ---------- Wikidata API ----------
async function getWikipediaUrlFromQID(qid) {
  if (!qid) return null;
  
  // Check cache
  if (WIKIDATA_CACHE.has(qid)) {
    console.log(`         💾 Wikidata cache hit: ${qid}`);
    METRICS.cacheHits++;
    return WIKIDATA_CACHE.get(qid);
  }
  
  try {
    console.log(`         🌐 Fetching Wikidata: ${qid}`);
    const json = await getJSON("www.wikidata.org", `/wiki/Special:EntityData/${qid}.json`);
    
    METRICS.apiCalls.wikidata++;
    
    const entity = json?.entities?.[qid];
    if (!entity) return null;
    
    const enwikiLink = entity.sitelinks?.enwiki;
    if (!enwikiLink) return null;
    
    const title = enwikiLink.title;
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    
    console.log(`         ✅ Found Wikipedia URL: ${url}`);
    
    // Cache it
    WIKIDATA_CACHE.set(qid, url);
    
    return url;
  } catch (err) {
    console.log(`         ⚠️ Wikidata lookup error: ${err.message}`);
    return null;
  }
}

// ---------- Perplexity with Retry ----------
async function callPerplexity(prompt, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const json = await postJSON("api.perplexity.ai", "/chat/completions", {
        model: "sonar",
        messages: [
          { role: "system", content: "You are an expert science historian and researcher. Focus on groundbreaking scientific discoveries, research milestones, and technological achievements from ALL regions and institutions worldwide. Provide accurate information with Wikidata QIDs and reliable peer-reviewed sources." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 4000
      }, { "Authorization": `Bearer ${PERPLEXITY_API_KEY}` });

      METRICS.apiCalls.perplexity++;
      const tokens = (json.usage?.prompt_tokens || 0) + (json.usage?.completion_tokens || 0);
      METRICS.costs.perplexity += tokens * 0.001 / 1000;

      return json;
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      const delay = 1000 * Math.pow(2, attempt);
      if (DEBUG) console.log(`      ⏳ Perplexity retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
}

// ---------- OpenAI ----------
async function callOpenAI(systemPrompt, userPrompt, temperature = 0.7, maxTokens = 300, model = "gpt-4o") {
  try {
    const json = await postJSON("api.openai.com", "/v1/chat/completions", {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature,
      max_tokens: maxTokens
    }, { "Authorization": `Bearer ${OPENAI_API_KEY}` });

    if (model === "gpt-4o-mini") {
      METRICS.apiCalls.openai_mini++;
      const usage = json.usage || {};
      METRICS.costs.openai += (usage.prompt_tokens || 0) * 0.00015 / 1000 + (usage.completion_tokens || 0) * 0.0006 / 1000;
    } else {
      METRICS.apiCalls.openai++;
      const usage = json.usage || {};
      METRICS.costs.openai += (usage.prompt_tokens || 0) * 0.0025 / 1000 + (usage.completion_tokens || 0) * 0.01 / 1000;
    }

    return json.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    if (DEBUG) console.log(`      ⚠️ OpenAI error: ${err.message}`);
    throw err;
  }
}

// ---------- EXA ----------
async function exaSearch(query, opts = {}) {
  const cacheKey = JSON.stringify({ query, opts });
  if (EXA_SEARCH_CACHE.has(cacheKey)) {
    console.log(`      💾 Exa cache hit: "${query.substring(0, 50)}..."`);
    METRICS.cacheHits++;
    return EXA_SEARCH_CACHE.get(cacheKey);
  }
  
  const payload = {
    query,
    numResults: opts.numResults ?? 15,
    type: "neural",
    useAutoprompt: false,
    excludeDomains: UGC_BLOCK,
    ...(opts.includeText && { text: { includeHtmlTags: false, maxCharacters: 5000 } })
  };
  
  if (opts.includeText) {
    payload.includeText = opts.includeText;
  }
  
  const json = await postJSON("api.exa.ai", "/search", payload, { "x-api-key": EXA_API_KEY });
  
  METRICS.apiCalls.exa_search++;
  METRICS.costs.exa += 0.005;  // $5 per 1k requests
  
  const results = Array.isArray(json?.results) ? json.results : [];
  
  EXA_SEARCH_CACHE.set(cacheKey, results);
  
  return results;
}

async function exaContents(ids) {
  if (!ids.length) return [];
  
  const json = await postJSON("api.exa.ai", "/contents", { ids, text: true, format: "markdown" }, { "x-api-key": EXA_API_KEY });
  
  METRICS.apiCalls.exa_contents++;
  METRICS.costs.exa += ids.length * 0.001;  // $1 per 1k pages
  
  return Array.isArray(json?.results) ? json.results : [];
}

// ---------- TIER 0: Wikipedia "On This Day" ----------
async function getWikipediaOnThisDay(monthName, day) {
  const cacheKey = `${monthName}_${day}`;
  
  if (WIKI_ON_THIS_DAY_CACHE.has(cacheKey)) {
    console.log(`      💾 Cache hit: Wikipedia ${monthName}_${day} page`);
    METRICS.cacheHits++;
    return WIKI_ON_THIS_DAY_CACHE.get(cacheKey);
  }
  
  console.log(`      🌐 Fetching Wikipedia "On This Day" page: ${monthName}_${day}`);
  
  try {
    const searchQuery = `site:en.wikipedia.org/wiki/${monthName}_${day}`;
    const results = await exaSearch(searchQuery, { numResults: 1 });
    
    if (results.length === 0) {
      console.log(`      ⚠️ Could not find Wikipedia date page`);
      return null;
    }
    
    const contents = await exaContents([results[0].id]);
    if (contents.length === 0) {
      console.log(`      ⚠️ Could not fetch Wikipedia date page content`);
      return null;
    }
    
    const text = contents[0].text || "";
    console.log(`      ✅ Wikipedia date page fetched (${text.length} chars)`);
    
    WIKI_ON_THIS_DAY_CACHE.set(cacheKey, text);
    
    return text;
  } catch (err) {
    console.log(`      ⚠️ Error fetching Wikipedia date page: ${err.message}`);
    return null;
  }
}

async function validateWithWikipediaOnThisDay(event, monthName, day) {
  console.log(`\n      🔍 TIER 0: Wikipedia "On This Day" Check`);
  console.log(`         Event: ${event.title}`);
  console.log(`         Type: ${event.type}`);
  console.log(`         Year: ${event.year}`);
  
  const wikiText = await getWikipediaOnThisDay(monthName, day);
  
  if (!wikiText) {
    console.log(`         ⚠️ Could not load Wikipedia date page - skipping`);
    return { validated: false, reason: 'wiki-date-page-unavailable' };
  }
  
  const wikiLower = wikiText.toLowerCase();
  const yearStr = event.year.toString();
  
  // For birthdays/deaths: NAME-ONLY matching
  if (event.type === 'birthday' || event.type === 'death') {
    const name = extractName(event.title, event.type);
    if (name) {
      console.log(`         👤 Extracted name: "${name}"`);
      const nameLower = name.toLowerCase();
      
      if (wikiLower.includes(nameLower)) {
        console.log(`         ✅✅ NAME FOUND ON WIKIPEDIA "ON THIS DAY" PAGE!`);
        METRICS.validation.tier0_success++;
        return { validated: true, reason: 'wiki-on-this-day-name-confirmed' };
      } else {
        console.log(`         ❌ Name not found on Wikipedia date page`);
      }
    }
  }
  
  // For events: title or keywords + year
  const searchTerms = [
    event.title,
    ...(event.keywords || []),
    yearStr
  ];
  
  let foundMentions = [];
  
  for (const term of searchTerms) {
    if (term && wikiLower.includes(term.toLowerCase())) {
      foundMentions.push(term);
    }
  }
  
  console.log(`         🔎 Search terms found: ${foundMentions.length}/${searchTerms.length}`);
  if (foundMentions.length > 0) {
    console.log(`         📌 Found: ${foundMentions.join(', ')}`);
  }
  
  const hasYear = wikiLower.includes(yearStr);
  const titleFound = foundMentions.some(m => m === event.title);
  const keywordCount = foundMentions.filter(m => m !== event.title && m !== yearStr).length;
  
  if ((titleFound && hasYear) || (keywordCount >= 2 && hasYear)) {
    console.log(`         ✅✅ FOUND ON WIKIPEDIA "ON THIS DAY" PAGE!`);
    METRICS.validation.tier0_success++;
    return { validated: true, reason: 'wiki-on-this-day-confirmed' };
  } else {
    console.log(`         ❌ Not found on Wikipedia date page`);
    console.log(`         📊 Title: ${titleFound ? '✅' : '❌'} | Year: ${hasYear ? '✅' : '❌'} | Keywords: ${keywordCount}`);
    METRICS.validation.tier0_fail++;
    return { validated: false, reason: 'not-on-wiki-date-page' };
  }
}

// ---------- TIER 1: Wikipedia Article + QID ----------
async function validateWithWikipediaArticle(event, monthName, day) {
  console.log(`\n      🔍 TIER 1: Wikipedia Article Validation`);
  console.log(`         Event: ${event.title}`);
  console.log(`         Type: ${event.type}`);
  console.log(`         QID: ${event.qid || 'NONE'}`);
  
  let wikiSource = (event.sources || []).find(s => 
    s.includes('wikipedia.org') || s.includes('en.wikipedia.org')
  );
  
  // If no Wikipedia source but QID available, get URL from Wikidata
  if (!wikiSource && event.qid) {
    console.log(`         🔍 No Wikipedia source, trying Wikidata lookup...`);
    wikiSource = await getWikipediaUrlFromQID(event.qid);
  }
  
  if (!wikiSource) {
    console.log(`         ⚠️ No Wikipedia source - skipping`);
    return { validated: false, reason: 'no-wiki-source' };
  }
  
  console.log(`         📚 Wikipedia URL: ${wikiSource}`);
  
  // Check if it's a Portal/Selected Anniversaries page
  const isPortalPage = wikiSource.includes('/Portal:') || wikiSource.includes('Selected_anniversaries');
  if (isPortalPage) {
    console.log(`         📋 Detected Portal/Selected Anniversaries page`);
  }
  
  try {
    const wikiId = wikiSource.match(/wikipedia\.org\/wiki\/([^#?]+)/)?.[1];
    if (!wikiId) {
      return { validated: false, reason: 'bad-wiki-url' };
    }
    
    const results = await exaSearch(`site:en.wikipedia.org ${wikiId}`, { numResults: 1 });
    if (results.length === 0) {
      return { validated: false, reason: 'wiki-not-found' };
    }
    
    const contents = await exaContents([results[0].id]);
    if (contents.length === 0) {
      return { validated: false, reason: 'wiki-no-content' };
    }
    
    const wikiText = contents[0].text || "";
    console.log(`         ✅ Wikipedia article fetched (${wikiText.length} chars)`);
    
    CONTENTS_CACHE.set(wikiSource, { text: wikiText, timestamp: Date.now() });
    
    const wikiLower = wikiText.toLowerCase();
    
    // For Portal pages OR birthdays/deaths: NAME-ONLY matching
    if (isPortalPage || event.type === 'birthday' || event.type === 'death') {
      const name = extractName(event.title, event.type);
      if (name) {
        console.log(`         👤 Searching for name: "${name}"`);
        const nameLower = name.toLowerCase();
        
        if (wikiLower.includes(nameLower)) {
          console.log(`         ✅✅ NAME FOUND IN WIKIPEDIA ARTICLE!`);
          METRICS.validation.tier1_success++;
          return { validated: true, reason: 'wikipedia-article-name-confirmed' };
        } else {
          console.log(`         ❌ Name not found in article`);
        }
      }
    }
    
    // For regular articles: DATE PATTERN matching
    const monthLower = monthName.toLowerCase();
    const dayNum = parseInt(day);
    
    const datePatterns = [
      `${monthName} ${dayNum}`,
      `${monthName} ${day}`,
      `${dayNum} ${monthName}`,
      `${day} ${monthName}`,
      `${monthLower} ${dayNum}`,
      `${dayNum} ${monthLower}`,
    ];
    
    let dateFound = false;
    let foundPattern = '';
    
    for (const pattern of datePatterns) {
      const regex = new RegExp(`\\b${pattern.replace(/\s+/g, '\\s+')}\\b`, 'i');
      if (regex.test(wikiText)) {
        dateFound = true;
        foundPattern = pattern;
        break;
      }
    }
    
    console.log(`         📅 Date pattern (${monthName} ${dayNum}): ${dateFound ? `✅ (${foundPattern})` : '❌'}`);
    
    if (dateFound) {
      console.log(`         ✅✅ WIKIPEDIA ARTICLE VALIDATION PASSED!`);
      METRICS.validation.tier1_success++;
      return { validated: true, reason: 'wikipedia-article-confirmed' };
    }
    
    // GPT FALLBACK for birthdays/deaths (gpt-4o-mini)
    if (event.type === 'birthday' || event.type === 'death') {
      console.log(`         🤖 GPT Fallback: Checking with GPT-4o-mini...`);
      METRICS.validation.tier1_gpt_fallback++;
      
      const excerpt = wikiText.substring(0, 1000);
      const name = extractName(event.title, event.type);
      const action = event.type === 'birthday' ? 'born' : 'died';
      
      const prompt = `Does this Wikipedia article confirm that ${name} was ${action} on ${monthName} ${parseInt(day)}?

ARTICLE EXCERPT:
${excerpt}

Answer with ONE word only:
- YES: The article clearly confirms the date
- NO: The article contradicts or doesn't mention this date
- UNCLEAR: Cannot determine from this excerpt

Answer:`;

      try {
        const answer = await callOpenAI(
          "You are a fact-checker verifying historical dates from Wikipedia articles.",
          prompt,
          0.2,
          10,
          "gpt-4o-mini"
        );
        
        const answerUpper = answer.toUpperCase().trim();
        console.log(`         🤖 GPT says: ${answerUpper}`);
        
        if (answerUpper.includes('YES')) {
          console.log(`         ✅✅ GPT CONFIRMS DATE!`);
          METRICS.validation.tier1_success++;
          return { validated: true, reason: 'wikipedia-article-gpt-confirmed' };
        }
      } catch (err) {
        console.log(`         ⚠️ GPT fallback error: ${err.message}`);
      }
    }
    
    console.log(`         ❌ Date not confirmed - EVENT REJECTED`);
    METRICS.validation.tier1_fail++;
    METRICS.validation.tier1_date_mismatch++;
    return { validated: false, reason: 'wiki-date-mismatch' };
    
  } catch (err) {
    console.log(`         ⚠️ Wikipedia article error: ${err.message}`);
    METRICS.validation.tier1_fail++;
    return { validated: false, reason: 'wiki-error' };
  }
}

// ---------- TIER 2: Perplexity Validator ----------
async function validateWithPerplexity(event, monthName, day) {
  console.log(`\n      🔍 TIER 2: Perplexity Date Validator`);
  console.log(`         Event: ${event.title}`);
  console.log(`         Date: ${monthName} ${parseInt(day)}, ${event.year}`);
  
  const cacheKey = `${event.title}_${monthName}_${day}_${event.year}`;
  if (PERPLEXITY_VALIDATION_CACHE.has(cacheKey)) {
    console.log(`         💾 Using cached Perplexity result`);
    METRICS.cacheHits++;
    return PERPLEXITY_VALIDATION_CACHE.get(cacheKey);
  }
  
  const prompt = `Did this scientific event happen on the specified date?

EVENT: ${event.title}
CLAIMED DATE: ${monthName} ${parseInt(day)}, ${event.year}
CONTEXT: ${event.context.substring(0, 300)}

Research this event and verify if the date is correct.

Answer in this exact format:
VERDICT: YES / NO / UNCLEAR
CONFIDENCE: HIGH / MEDIUM / LOW
ACTUAL_DATE: [if different, provide the correct date in format "Month DD, YYYY"]
REASON: [1-2 sentence explanation with sources]

Be strict: Only answer YES if you can confirm the exact date with reliable sources.`;

  try {
    const response = await callPerplexity(prompt, 3);
    
    const content = response.choices?.[0]?.message?.content || "";
    console.log(`         🔎 Perplexity response:\n${content.substring(0, 400)}`);
    
    METRICS.apiCalls.perplexity_validation++;
    
    const lines = content.split('\n');
    const verdictLine = lines.find(l => l.toUpperCase().includes('VERDICT'));
    const confidenceLine = lines.find(l => l.toUpperCase().includes('CONFIDENCE'));
    const actualDateLine = lines.find(l => l.toUpperCase().includes('ACTUAL_DATE'));
    const reasonLine = lines.find(l => l.toUpperCase().includes('REASON'));
    
    let verdict = 'UNCLEAR';
    if (verdictLine) {
      const verdictText = verdictLine.toUpperCase();
      if (verdictText.includes('YES')) verdict = 'YES';
      else if (verdictText.includes('NO')) verdict = 'NO';
    }
    
    let confidence = 'LOW';
    if (confidenceLine) {
      const confText = confidenceLine.toUpperCase();
      if (confText.includes('HIGH')) confidence = 'HIGH';
      else if (confText.includes('MEDIUM')) confidence = 'MEDIUM';
    }
    
    let actualDate = null;
    if (actualDateLine && verdict === 'NO') {
      const dateMatch = actualDateLine.match(/ACTUAL_DATE:\s*(.+)/i);
      if (dateMatch) actualDate = dateMatch[1].trim();
    }
    
    let reason = 'No reason provided';
    if (reasonLine) {
      const reasonMatch = reasonLine.match(/REASON:\s*(.+)/i);
      if (reasonMatch) reason = reasonMatch[1].trim();
    }
    
    console.log(`         📊 Verdict: ${verdict} (Confidence: ${confidence})`);
    if (actualDate) console.log(`         📅 Actual date: ${actualDate}`);
    console.log(`         💬 Reason: ${reason.substring(0, 150)}...`);
    
    const result = { verdict, confidence, actualDate, reason };
    
    PERPLEXITY_VALIDATION_CACHE.set(cacheKey, result);
    
    if (verdict === 'YES') {
      METRICS.validation.tier2_yes++;
      console.log(`         ✅✅ PERPLEXITY CONFIRMS DATE!`);
    } else if (verdict === 'NO') {
      METRICS.validation.tier2_no++;
      console.log(`         ❌ PERPLEXITY REJECTS DATE`);
    } else {
      METRICS.validation.tier2_unclear++;
      console.log(`         ⚠️ PERPLEXITY UNCLEAR - needs further validation`);
    }
    
    return result;
    
  } catch (err) {
    console.log(`         ⚠️ Perplexity validation error: ${err.message}`);
    METRICS.validation.tier2_unclear++;
    return { verdict: 'UNCLEAR', confidence: 'LOW', actualDate: null, reason: `Error: ${err.message}` };
  }
}

// ---------- TIER 2.5: Year Auto-Correction ----------
async function correctEventYear(event, actualDateStr, reason, monthName, day) {
  console.log(`\n      🔧 TIER 2.5: Year Auto-Correction`);
  
  const actualDate = parsePerplexityDate(actualDateStr);
  
  if (!actualDate) {
    console.log(`         ⚠️ Could not parse actual date: ${actualDateStr}`);
    return null;
  }
  
  console.log(`         📅 Parsed: ${actualDate.month} ${actualDate.day}, ${actualDate.year}`);
  
  if (actualDate.month.toLowerCase() === monthName.toLowerCase() && 
      actualDate.day === parseInt(day)) {
    
    console.log(`         ✅ Month+Day correct (${monthName} ${day}), only YEAR wrong`);
    console.log(`         🔄 Correcting: ${event.year} → ${actualDate.year}`);
    
    const oldYear = event.year;
    event.year = actualDate.year;
    event.date = `${actualDate.year}-${String(actualDate.monthNum).padStart(2,'0')}-${String(actualDate.day).padStart(2,'0')}`;
    
    console.log(`         ✍️  Asking Perplexity to rewrite context with correct year...`);
    
    const rewritePrompt = `Rewrite this event description with the correct year.

EVENT: ${event.title}
INCORRECT YEAR: ${oldYear}
CORRECT YEAR: ${actualDate.year}
ORIGINAL CONTEXT: ${event.context}
REASON FOR CORRECTION: ${reason}

Rewrite the context to reflect the correct year (${actualDate.year}), keeping the same style and length (80-100 words). Use precise scientific language.

Return only the rewritten context:`;

    try {
      const rewriteResponse = await callPerplexity(rewritePrompt, 3);
      const correctedContext = rewriteResponse.choices?.[0]?.message?.content?.trim() || event.context;
      
      console.log(`         ✅ Context rewritten (${correctedContext.split(/\s+/).length} words)`);
      
      event.context = correctedContext;
      
      METRICS.validation.tier2_year_corrected++;
      
      return { corrected: true, oldYear, newYear: actualDate.year };
      
    } catch (err) {
      console.log(`         ⚠️ Context rewrite failed: ${err.message}`);
      console.log(`         ℹ️  Keeping original context with updated year`);
      return { corrected: true, oldYear, newYear: actualDate.year, contextRewriteFailed: true };
    }
    
  } else {
    console.log(`         ❌ Month or Day also wrong - cannot auto-correct`);
    console.log(`         Expected: ${monthName} ${day}`);
    console.log(`         Actual: ${actualDate.month} ${actualDate.day}`);
    return null;
  }
}

// ---------- TIER 3: Exa Search with include_text ----------
async function validateWithExaIncludeText(event, monthName, day, maxRetries = 3) {
  console.log(`\n      🔍 TIER 3: Exa include_text Validation`);
  console.log(`         Event: ${event.title}`);
  console.log(`         Date: ${monthName} ${parseInt(day)}, ${event.year}`);
  
  const keywords = event.keywords || [];
  const titleWords = event.title.split(' ').filter(w => w.length > 3).slice(0, 5);
  const allKeywords = [...keywords, ...titleWords];
  const query = allKeywords.slice(0, 5).join(' ');
  
  const dateStrings = getMultilingualDateStrings(monthName, day);
  console.log(`         🌐 Multilingual date filters: ${dateStrings.length} variants`);
  if (DEBUG) console.log(`         📋 Sample filters: ${dateStrings.slice(0, 5).join(', ')}...`);
  
  console.log(`         🔎 Query: "${query}"`);
  
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`         🔄 Attempt ${attempt + 1}/${maxRetries}`);
      
      const results = await exaSearch(query, { 
        numResults: 20,
        includeText: dateStrings,
        includeTextContent: true
      });
      
      console.log(`         📊 Results: ${results.length}`);
      
      if (results.length === 0) {
        if (attempt < maxRetries - 1) {
          console.log(`         ⚠️ No results, retrying...`);
          METRICS.validation.tier3_retries++;
          await sleep(1000);
          continue;
        } else {
          console.log(`         ❌ No results after ${maxRetries} attempts - REJECTED`);
          METRICS.validation.tier3_fail++;
          return { validated: false, results: [], reason: 'exa-no-results' };
        }
      }
      
      console.log(`         ✅ Step 1: Found ${results.length} results with date filter`);
      
      const qualityScore = calculateDomainQuality(results);
      console.log(`         📊 Domain Quality Score: ${qualityScore.score} points`);
      console.log(`         🏆 High-Trust: ${qualityScore.highTrust} | 📜 Historical: ${qualityScore.historical}`);
      
      if (results.length >= 5 && qualityScore.score >= 3) {
        console.log(`         ✅✅ STRONG SIGNAL - ${results.length} results + good domains!`);
        METRICS.validation.tier3_success++;
        return { validated: true, results, reason: 'exa-strong-signal' };
      }
      
      if (results.length >= 3 && qualityScore.highTrust > 0) {
        console.log(`         ✅ GOOD SIGNAL - high-trust domain present`);
        METRICS.validation.tier3_success++;
        return { validated: true, results, reason: 'exa-good-signal' };
      }
      
      console.log(`\n         🔍 Step 3: Content Verification (GPT check)`);
      const verified = await verifyContentWithGPT(event, monthName, day, results);
      
      if (verified.count >= 1) {
        console.log(`         ✅✅ EXA + GPT VALIDATION PASSED!`);
        console.log(`         📝 ${verified.count}/${verified.total} sources confirmed`);
        METRICS.validation.tier3_success++;
        return { validated: true, results, reason: 'exa-gpt-verified' };
      } else {
        if (attempt < maxRetries - 1) {
          console.log(`         ⚠️ Content verification failed, retrying...`);
          METRICS.validation.tier3_retries++;
          await sleep(1000);
          continue;
        } else {
          console.log(`         ❌ No sources confirmed after ${maxRetries} attempts - REJECTED`);
          METRICS.validation.tier3_fail++;
          return { validated: false, results: [], reason: 'exa-gpt-failed' };
        }
      }
      
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        console.log(`         ⚠️ Error: ${err.message}, retrying...`);
        METRICS.validation.tier3_retries++;
        await sleep(1000);
        continue;
      }
    }
  }
  
  console.log(`         ⚠️ All ${maxRetries} attempts failed`);
  if (lastError) console.log(`         Error: ${lastError.message}`);
  METRICS.validation.tier3_fail++;
  return { validated: false, results: [], reason: 'exa-error' };
}

// ---------- Domain Quality Calculation ----------
function calculateDomainQuality(results) {
  let score = 0;
  let highTrust = 0;
  let historical = 0;
  
  for (const result of results) {
    const url = result.url || "";
    const h = host(url);
    
    if (HIGH_TRUST_DOMAINS.some(d => h.includes(d) || d.includes(h))) {
      score += 2;
      highTrust++;
      if (DEBUG) console.log(`            ✓ High-trust: ${h}`);
    } else if (HISTORICAL_DOMAINS.some(d => h.includes(d) || d.includes(h))) {
      score += 1.5;
      historical++;
      if (DEBUG) console.log(`            ✓ Historical: ${h}`);
    } else if (allowed(url)) {
      score += 1;
      if (DEBUG) console.log(`            ✓ Allowed: ${h}`);
    }
  }
  
  return { score, highTrust, historical, total: results.length };
}

// ---------- TIER 4: Content Verification with GPT-4o-mini ----------
async function verifyContentWithGPT(event, monthName, day, results) {
  console.log(`         📚 Checking top 3 sources with GPT-4o-mini`);
  
  const topResults = results.slice(0, 3);
  let verifiedCount = 0;
  
  for (let i = 0; i < topResults.length; i++) {
    const result = topResults[i];
    const url = result.url;
    
    console.log(`         📄 Source ${i + 1}: ${url.substring(0, 60)}...`);
    
    let content = result.text || null;
    
    if (!content) {
      try {
        const contents = await exaContents([result.id]);
        if (contents.length > 0) {
          content = contents[0].text;
        }
      } catch (err) {
        console.log(`            ⚠️ Could not fetch content`);
        continue;
      }
    }
    
    if (!content || content.length < 100) {
      console.log(`            ⚠️ Content too short or empty`);
      continue;
    }
    
    const excerpt = content.substring(0, 600);
    
    const prompt = `Does this source text confirm that "${event.title}" happened on ${monthName} ${parseInt(day)}?

SOURCE TEXT:
${excerpt}

Answer with ONE word only:
- YES: The source clearly confirms the event on this date
- NO: The source contradicts or doesn't mention this date
- UNCLEAR: Cannot determine from this excerpt

Answer:`;

    try {
      const answer = await callOpenAI(
        "You are a fact-checker verifying historical dates from sources.",
        prompt,
        0.2,
        10,
        "gpt-4o-mini"
      );
      
      const answerUpper = answer.toUpperCase().trim();
      console.log(`            🤖 GPT says: ${answerUpper}`);
      
      if (answerUpper.includes('YES')) {
        verifiedCount++;
      }
    } catch (err) {
      console.log(`            ⚠️ GPT verification error`);
    }
    
    await sleep(300);
  }
  
  return { count: verifiedCount, total: topResults.length };
}

// ---------- MASTER VALIDATION ----------
async function validateEventReality(event, monthName, day) {
  console.log(`\n   🛡️ === MULTI-TIER VALIDATION ===`);
  
  // TIER 0: Wikipedia "On This Day" - ONLY for birthdays/deaths (name-matching is fast & cheap)
  if (event.type === 'birthday' || event.type === 'death') {
    const tier0 = await validateWithWikipediaOnThisDay(event, monthName, day);
    if (tier0.validated === true) {
      console.log(`      ✅ PASSED (Tier 0: Wikipedia OTD)`);
      return { valid: true, method: 'tier0-wiki-on-this-day', reason: tier0.reason };
    }
  }
  
  // TIER 1: Wikipedia Article - ONLY for birthdays/deaths with QID
  if ((event.type === 'birthday' || event.type === 'death') && event.qid) {
    const tier1 = await validateWithWikipediaArticle(event, monthName, day);
    if (tier1.validated === true) {
      console.log(`      ✅ PASSED (Tier 1: Wikipedia Article)`);
      return { valid: true, method: 'tier1-wiki-article', reason: tier1.reason };
    }
    if (tier1.reason === 'wiki-date-mismatch') {
      console.log(`      ❌ REJECTED (Tier 1: Wikipedia date mismatch)`);
      return { valid: false, method: 'tier1-wiki-article', reason: tier1.reason };
    }
  }
  
  // TIER 2: Perplexity Validation (for ALL events)
  const tier2 = await validateWithPerplexity(event, monthName, day);
  
  if (tier2.verdict === 'YES') {
    console.log(`      ✅ PASSED (Tier 2: Perplexity confirmed)`);
    return { valid: true, method: 'tier2-perplexity', reason: 'perplexity-confirmed' };
  }
  
  if (tier2.verdict === 'NO') {
    if (tier2.actualDate) {
      const correction = await correctEventYear(event, tier2.actualDate, tier2.reason, monthName, day);
      
      if (correction && correction.corrected) {
        console.log(`      🔄 PASSED (Tier 2: Year corrected ${correction.oldYear} → ${correction.newYear})`);
        return { valid: true, method: 'tier2-perplexity-year-corrected', reason: 'year-auto-corrected' };
      }
    }
    
    console.log(`      ❌ REJECTED (Tier 2: Perplexity definitive NO)`);
    return { valid: false, method: 'tier2-perplexity', reason: 'perplexity-rejected' };
  }
  
  if (tier2.verdict === 'UNCLEAR') {
    console.log(`\n      ⚠️ Perplexity UNCLEAR - proceeding to Exa include_text...`);
    
    const tier3 = await validateWithExaIncludeText(event, monthName, day, 3);
    
    if (tier3.validated === true) {
      console.log(`      ✅ PASSED (Tier 3: Exa include_text + GPT)`);
      return { valid: true, method: 'tier3-exa-include-text', reason: tier3.reason };
    } else {
      console.log(`      ❌ REJECTED (Tier 3: Exa validation failed)`);
      return { valid: false, method: 'tier3-exa-include-text', reason: tier3.reason };
    }
  }
  
  console.log(`      ❌ REJECTED (All tiers failed)`);
  return { valid: false, method: 'all-tiers-failed', reason: 'no-validation-passed' };
}

// ---------- Extract Context from Sources ----------
function extractContextFromSources(event, sources) {
  const snippets = [];
  
  for (const url of sources.slice(0, 4)) {
    if (!CONTENTS_CACHE.has(url)) continue;
    
    const cached = CONTENTS_CACHE.get(url);
    const text = cached.text || "";
    
    if (text.length < 100) continue;
    
    const titleWords = event.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const paragraphs = text.split(/\n\n+/).filter(p => p.length > 50);
    
    for (const para of paragraphs) {
      const paraLower = para.toLowerCase();
      const matchCount = titleWords.filter(w => paraLower.includes(w)).length;
      
      if (matchCount >= 2) {
        const snippet = para.slice(0, 500).trim();
        if (snippet.length > 100) {
          snippets.push(snippet);
          break;
        }
      }
    }
    
    if (snippets.length >= 4) break;
  }
  
  return snippets.join('\n\n');
}

// ---------- GPT-4o Polish (ONLY for final polishing) ----------
async function polishWithGPT(event, sources, additionalContext = "") {
  const sourcesText = sources.slice(0, 3).map((s, i) => `[${i+1}] ${s}`).join('\n');
  
  let contextSection = `CONTEXT: ${event.context}`;
  if (additionalContext && additionalContext.length > 100) {
    contextSection += `\n\nADDITIONAL SOURCE MATERIAL:\n${additionalContext}`;
  }
  
  const prompt = `Rewrite this scientific discovery concisely and accurately in about 85–100 words.
Use precise scientific language, focusing on the discovery's significance and methodology.

EVENT: ${event.title}
DATE: ${event.date}
TYPE: ${event.type}
${contextSection}

SOURCES:
${sourcesText}

Guidelines:
- Focus on SCIENTIFIC ACCURACY and peer-reviewed findings.
- Use precise terminology without oversimplification.
- Mention the date naturally in the text.
- Explain WHY this discovery mattered to the field.
- Keep factual, neutral tone - no emotional language.
- Past tense only.
Return only the rewritten text.`;

  try {
    let polished = await callOpenAI(
      "You are a science writer who creates accurate, precise summaries of scientific discoveries and breakthroughs.",
      prompt,
      0.7,
      300,
      "gpt-4o" // ONLY gpt-4o for polishing
    );
    
    // Comprehensive UTF-8 encoding fix
    polished = polished
      // Common accented characters
      .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í').replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú')
      .replace(/Ã /g, 'à').replace(/Ã¨/g, 'è').replace(/Ã¬/g, 'ì').replace(/Ã²/g, 'ò').replace(/Ã¹/g, 'ù')
      .replace(/Ã¢/g, 'â').replace(/Ãª/g, 'ê').replace(/Ã®/g, 'î').replace(/Ã´/g, 'ô').replace(/Ã»/g, 'û')
      .replace(/Ã¤/g, 'ä').replace(/Ã«/g, 'ë').replace(/Ã¯/g, 'ï').replace(/Ã¶/g, 'ö').replace(/Ã¼/g, 'ü')
      .replace(/Ã§/g, 'ç').replace(/Ã±/g, 'ñ')
      .replace(/Ã…/g, 'Å').replace(/Ã/g, 'Ä').replace(/Ã–/g, 'Ö').replace(/Ãœ/g, 'Ü')
      // Dashes and special characters
      .replace(/â€"/g, '–').replace(/â€"/g, '—').replace(/â€™/g, "'").replace(/â€˜/g, "'")
      .replace(/â€œ/g, '"').replace(/â€/g, '"').replace(/â€¦/g, '…')
      // Degree and other symbols
      .replace(/Â°/g, '°').replace(/Â±/g, '±').replace(/Â²/g, '²').replace(/Â³/g, '³')
      .replace(/Âµ/g, 'µ').replace(/Â·/g, '·').replace(/Ã—/g, '×').replace(/Ã·/g, '÷')
      // Extra spaces
      .replace(/Â /g, ' ').replace(/\u00A0/g, ' ')
      // Cleanup any remaining garbage
      .replace(/Ã‚/g, '').replace(/â€/g, '');
    
    return polished;
  } catch (err) {
    if (DEBUG) console.log(`      ⚠️ GPT polish failed: ${err.message}`);
    return event.context;
  }
}

// ---------- EXA Enrichment ----------
async function enrichWithEXA(event) {
  const dISO = event.date;
  if (!dISO || !dISO.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return [];
  }
  const [y, m, d] = dISO.split("-");
  const md = new Date(2000, Number(m) - 1, 1).toLocaleString("en", { month: "long" }) + " " + Number(d);
  
  // Use exact event title for precision
  const queries = [
    `"${event.title}" "${md}"`,  // Exact title + date
    `"${event.title}" ${event.year}`,  // Exact title + year
  ];
  
  // Only add broader search for very recent events (< 1 year old)
  const isVeryRecent = event.year >= new Date().getFullYear();
  if (isVeryRecent) {
    queries.push(`${event.title} (discovery OR breakthrough OR published OR announced)`);
  }
  
  const hits = [];
  for (const q of queries) {
    try {
      const r = await exaSearch(q, { numResults: 8 });
      hits.push(...r);
      if (DEBUG) console.log(`      🔎 "${q}" → +${r.length}`);
    } catch {}
  }
  
  const unique = Array.from(new Map(hits.map(h => [h.url, h])).values());
  const kept = unique.filter(h => allowed(h.url)).slice(0, 15);
  
  if (!kept.length) return [];
  
  const validated = [];
  const toFetch = kept.slice(0, 6);
  
  if (toFetch.length > 0) {
    const fetchIds = toFetch.map(k => k.id);
    const cont = await exaContents(fetchIds).catch(() => []);
    
    for (const c of cont) {
      const url = toFetch.find(k => k.id === c.id)?.url || c.url;
      const text = c.text || "";
      CONTENTS_CACHE.set(url, { text, timestamp: Date.now() });
      validated.push(url);
    }
  }
  
  return uniq(validated).slice(0, 8);
}

// ---------- Perplexity Seed ----------
function buildPerplexityPrompt(category, monthName, day) {
  return `Find ${category.count} significant scientific events, discoveries, or awards that occurred on ${monthName} ${parseInt(day)} (any year in history).

CATEGORY: ${category.name}
FOCUS: ${category.description}

CRITICAL: ONLY include REAL, historically documented scientific events with verifiable sources!

✅ INCLUDE:
- Major discoveries or breakthroughs
- Nobel Prize or major award announcements
- Publication of groundbreaking papers
- Significant experiments completed
- Scientific milestones achieved
- First images of discoveries (e.g., first black hole image)

❌ EXCLUDE:
- Speculative or unverified discoveries
- Minor incremental advances
- Events without clear documentation
- Hypothetical or fictional science
- Astronomy Picture of the Day (APOD) features
- APOD showcases or routine image highlights
- Image features that are not scientific discoveries
- "Featured on APOD" or "Image of the Day" events

For each event provide:

{
  "title": "Brief title (max 60 chars)",
  "date": "YYYY-MM-DD",
  "year": YYYY,
  "category": "science",
  "type": "event | birthday | death",
  "qid": "Wikidata QID (Q12345) or null",
  "context": "Detailed scientific description (100-120 words). Be precise and factual.",
  "sources": ["URL1", "URL2", "URL3"],
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

Return ONLY a valid JSON array with ${category.count} REAL scientific events.`;
}

async function seedCategory(category, monthName, day) {
  console.log(`\n🔬 ${category.name}`);
  
  const prompt = buildPerplexityPrompt(category, monthName, day);
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await callPerplexity(prompt, 5);
      
      const content = response.choices?.[0]?.message?.content;
      if (!content) throw new Error("No content in Perplexity response");
      
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array in response");
      
      let jsonStr = jsonMatch[0];
      jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
      
      let events;
      try {
        events = JSON.parse(jsonStr);
      } catch (parseErr) {
        if (attempt < 2) {
          console.log(`      🔄 Retry ${attempt + 1}/3...`);
          await sleep(1000);
          continue;
        }
        throw parseErr;
      }
      
      if (!Array.isArray(events) || events.length === 0) {
        if (attempt < 2) {
          console.log(`      🔄 Empty result, retry ${attempt + 1}/3...`);
          await sleep(1000);
          continue;
        }
        console.log("   ⚠️ No events found after retries");
        return [];
      }
      
      const validEvents = events.filter(e => {
        const titleLower = (e.title || "").toLowerCase();
        const contextLower = (e.context || "").toLowerCase();
        
        // Filter out Perplexity error responses
        const errorPhrases = [
          'search results do not', 'do not provide', 'no significant',
          'no major', 'no globally significant', 'no events found',
          'unable to find', 'not provide', 'hypothetical', 'fictional', 'imaginary'
        ];
        
        if (errorPhrases.some(phrase => titleLower.includes(phrase) || contextLower.includes(phrase))) {
          if (DEBUG) console.log(`      ⚠️ Filtering Perplexity error response: ${e.title}`);
          return false;
        }
        
        // Filter out APOD features
        const apodKeywords = [
          'apod', 'astronomy picture of the day', 'picture of the day',
          'featured on apod', 'image of the day', 'astronomical image of'
        ];
        
        if (apodKeywords.some(keyword => titleLower.includes(keyword) || contextLower.includes(keyword))) {
          const legitimateImageKeywords = [
            'first image', 'first light', 'first observation',
            'first photograph', 'first direct image', 'discovery image'
          ];
          
          const isLegitimateImage = legitimateImageKeywords.some(kw => 
            titleLower.includes(kw) || contextLower.includes(kw)
          );
          
          if (!isLegitimateImage) {
            if (DEBUG) console.log(`      ⚠️ Filtering out APOD feature: ${e.title}`);
            return false;
          }
        }
        
        if (!e.title || e.title.length < 10) return false;
        if (!e.date || !e.date.match(/^\d{4}-\d{2}-\d{2}$/)) return false;
        
        const [year, eventMonth, eventDay] = e.date.split('-');
        const monthIndex = new Date(2000, parseInt(eventMonth) - 1).getMonth();
        const expectedMonthIndex = new Date(Date.parse(monthName + " 1, 2000")).getMonth();
        
        if (monthIndex !== expectedMonthIndex || parseInt(eventDay) !== parseInt(day)) {
          return false;
        }
        
        if (!e.context || e.context.length < 50) return false;
        return true;
      });
      
      if (validEvents.length === 0) {
        if (attempt < 2) {
          console.log(`      🔄 No valid events, retry ${attempt + 1}/3...`);
          await sleep(1000);
          continue;
        }
        console.log("   ⚠️ No valid events after filtering");
        return [];
      }
      
      METRICS.events.seeded += validEvents.length;
      console.log(`   ✅ Seeded ${validEvents.length} event(s)`);
      
      return validEvents;
      
    } catch (err) {
      if (attempt < 2) {
        console.log(`   ⚠️ Error: ${err.message}`);
        console.log(`   🔄 Retry ${attempt + 1}/3...`);
        await sleep(2000);
        continue;
      }
      console.error(`   ❌ Seed failed: ${err.message}`);
      return [];
    }
  }
  
  return [];
}

// ---------- Birthdays/Deaths Fallback ----------
async function seedBirthdaysDeaths(needed, monthName, day) {
  console.log(`\n   🎂 Fallback: Birthdays/Deaths of World-Changing Scientists`);
  
  const prompt = `Find ${needed} births or deaths of scientists who fundamentally changed the world on ${monthName} ${parseInt(day)} (any year).

FOCUS: Scientists whose work had MASSIVE impact on humanity - Nobel laureates, breakthrough discoverers, field founders.

Examples: Einstein, Darwin, Curie, Newton, Pasteur, Tesla, Feynman, Hawking.

For each person provide:
{
  "title": "Name born/died (max 60 chars)",
  "date": "YYYY-MM-DD",
  "year": YYYY,
  "category": "science",
  "type": "birthday | death",
  "qid": "Wikidata QID or null",
  "context": "Brief biography focusing on world-changing contributions (80-100 words)",
  "sources": ["URL1", "URL2"],
  "keywords": ["keyword1", "keyword2"]
}

Return ONLY a valid JSON array with ${needed} scientists.`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await callPerplexity(prompt, 5);
      const content = response.choices?.[0]?.message?.content;
      if (!content) throw new Error("No content");
      
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array");
      
      let jsonStr = jsonMatch[0];
      jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
      
      let events = JSON.parse(jsonStr);
      
      if (!Array.isArray(events) || events.length === 0) {
        if (attempt < 2) {
          console.log(`      🔄 Retry ${attempt + 1}/3...`);
          await sleep(1000);
          continue;
        }
        return [];
      }
      
      const validEvents = events.filter(e => {
        if (!e.date || !e.date.match(/^\d{4}-\d{2}-\d{2}$/)) return false;
        
        const [year, eventMonth, eventDay] = e.date.split('-');
        const monthIndex = new Date(2000, parseInt(eventMonth) - 1).getMonth();
        const expectedMonthIndex = new Date(Date.parse(monthName + " 1, 2000")).getMonth();
        
        if (monthIndex !== expectedMonthIndex || parseInt(eventDay) !== parseInt(day)) {
          return false;
        }
        
        if (e.type !== 'birthday' && e.type !== 'death') return false;
        return true;
      });
      
      if (validEvents.length === 0) {
        if (attempt < 2) {
          console.log(`      🔄 Retry ${attempt + 1}/3...`);
          await sleep(1000);
          continue;
        }
        return [];
      }
      
      METRICS.events.seeded += validEvents.length;
      console.log(`   ✅ Found ${validEvents.length} scientist(s)`);
      
      return validEvents.slice(0, needed);
      
    } catch (err) {
      if (attempt < 2) {
        console.log(`   🔄 Retry ${attempt + 1}/3...`);
        await sleep(2000);
        continue;
      }
      return [];
    }
  }
  
  return [];
}

// ---------- Process Event ----------
async function processEvent(event, monthName, day) {
  console.log(`\n   📌 ${event.title} (${event.year})`);
  console.log(`      Type: ${event.type}`);
  console.log(`      QID: ${event.qid || 'NONE'}`);
  console.log(`      Sources: ${(event.sources || []).length}`);
  
  const validation = await validateEventReality(event, monthName, day);
  
  if (!validation.valid) {
    console.log(`\n      ❌ VALIDATION FAILED - Event dropped`);
    console.log(`         Method: ${validation.method}`);
    console.log(`         Reason: ${validation.reason}`);
    METRICS.events.dropped++;
    METRICS.dropReasons[validation.reason] = (METRICS.dropReasons[validation.reason] || 0) + 1;
    return null;
  }
  
  console.log(`\n      ✅ VALIDATION PASSED`);
  console.log(`         Method: ${validation.method}`);
  console.log(`         Reason: ${validation.reason}`);
  
  const perplexitySources = (event.sources || []).filter(s => s && allowed(s));
  const contextWordCount = (event.context || "").split(/\s+/).length;
  
  // Enrich if: (1) too few sources, (2) no EU source, or (3) context too short
  const needsEnrichment = perplexitySources.length < 2 || 
    (perplexitySources.length < 3 && !hasEuropeanSource(perplexitySources)) ||
    contextWordCount < 70;
  
  let finalSources = perplexitySources;
  
  if (needsEnrichment) {
    console.log(`      🔍 Needs enrichment`);
    const exaSources = await enrichWithEXA(event);
    finalSources = uniq([...perplexitySources, ...exaSources]);
    METRICS.events.enriched++;
  }
  
  // Filter out obviously wrong sources (no keyword overlap)
  if (finalSources.length > 2) {
    const titleWords = event.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const filtered = finalSources.filter(url => {
      const cached = CONTENTS_CACHE.get(url);
      if (!cached) return true; // Keep if no content cached yet
      const text = (cached.text || "").toLowerCase();
      // Keep if at least 1 important title word appears
      return titleWords.some(word => text.includes(word));
    });
    
    if (filtered.length >= 2) {
      const removed = finalSources.length - filtered.length;
      if (removed > 0) {
        console.log(`      🧹 Filtered ${removed} irrelevant source(s)`);
        finalSources = filtered;
      }
    }
  }
  
  if (finalSources.length === 0) {
    console.log(`      ✗ No valid sources`);
    METRICS.events.dropped++;
    METRICS.dropReasons["no-sources"] = (METRICS.dropReasons["no-sources"] || 0) + 1;
    return null;
  }
  
  let additionalContext = "";
  if (contextWordCount < 80) {
    console.log(`      📚 Context short (${contextWordCount} words)`);
    additionalContext = extractContextFromSources(event, finalSources);
  }
  
  console.log(`      ✍️  Polishing text...`);
  const polishedContext = await polishWithGPT(event, finalSources, additionalContext);
  const wordCount = polishedContext.split(/\s+/).length;
  console.log(`      ✅ ${wordCount} words`);
  
  event.context = polishedContext;
  event.sources = finalSources.slice(0, 6);
  
  METRICS.events.validated++;
  return event;
}

// ---------- Main ----------
async function fetchCategory(category, monthName, day) {
  const events = await seedCategory(category, monthName, day);
  if (events.length === 0) return [];
  
  const processed = [];
  for (const event of events) {
    const result = await processEvent(event, monthName, day);
    if (result) processed.push(result);
    await sleep(500);
  }
  
  console.log(`   ✅ Validated ${processed.length}/${category.count}`);
  
  return processed.slice(0, category.count);
}

// ---------- Export ----------
module.exports = {
  SCIENCE_CATEGORIES,
  METRICS,
  CONTENTS_CACHE,
  fetchCategory,
  processEvent,
  sleep
};

// ---------- Main ----------
if (require.main === module) {
  const TEST_DATE = "10-08";
  const [month, day] = TEST_DATE.split("-");
  const monthName = new Date(2000, parseInt(month) - 1).toLocaleString("en", { month: "long" });

  (async function run() {
    console.log(`\n🔬 SCIENCE EVENT VALIDATION v7 (Optimized Costs)\n${"=".repeat(70)}`);
    console.log(`📅 ${TEST_DATE} (${monthName} ${parseInt(day)})`);
    console.log(`🎯 ${SCIENCE_CATEGORIES.length} categories`);
    console.log(`🌐 Multilingual date filters enabled`);
    console.log(`👤 Name-only matching for birthdays/deaths`);
    console.log(`🔗 QID → Wikidata → Real Wikipedia URL`);
    console.log(`🤖 GPT-4o-mini for validation, GPT-4o for polishing`);
    console.log(`🔧 Year Auto-Correction: ENABLED`);
    console.log(`🔄 Exa 3x Retry: ENABLED`);
    console.log(`💰 Wiki-Check: Only for birthdays/deaths`);
    console.log(`${"=".repeat(70)}`);

    const all = [];
    for (const cat of SCIENCE_CATEGORIES) {
      const events = await fetchCategory(cat, monthName, day);
      all.push(...events);
      await sleep(2000);
    }

    const TARGET_TOTAL = 7;
    if (all.length < 5) {
      console.log(`\n⚠️ Only ${all.length} events validated - adding birthdays/deaths fallback...`);
      const needed = Math.min(TARGET_TOTAL - all.length, 5);
      
      const fallbackEvents = await seedBirthdaysDeaths(needed, monthName, day);
      
      for (const event of fallbackEvents) {
        const result = await processEvent(event, monthName, day);
        if (result) {
          all.push(result);
          METRICS.events.fallback++;
        }
        await sleep(500);
      }
      
      console.log(`   ✅ Added ${METRICS.events.fallback} fallback event(s)`);
    }

    for (const event of all) {
      if (event.date && event.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = event.date.split('-');
        event.date = `${month}-${day}`;
      }
    }

    const timestamp = Date.now();
    const file = `science-events-${TEST_DATE}-v7-${timestamp}.json`;
    
    fs.writeFileSync(file, JSON.stringify(all, null, 2));

    console.log(`\n${"=".repeat(70)}`);
    console.log(`📊 QUALITY REPORT v7`);
    console.log(`${"=".repeat(70)}`);
    console.log(`Events: ${METRICS.events.seeded} seeded → ${METRICS.events.validated} validated (${METRICS.events.dropped} dropped)`);
    console.log(`Success Rate: ${((METRICS.events.validated / METRICS.events.seeded) * 100).toFixed(1)}%`);
    console.log(`Fallback Events: ${METRICS.events.fallback}`);
    
    console.log(`\nValidation Breakdown:`);
    console.log(`  Tier 0 (Wiki "On This Day"): ${METRICS.validation.tier0_success} ✅ / ${METRICS.validation.tier0_fail} ❌`);
    console.log(`  Tier 1 (Wiki Article): ${METRICS.validation.tier1_success} ✅ / ${METRICS.validation.tier1_fail} ❌ (${METRICS.validation.tier1_date_mismatch} mismatches)`);
    if (METRICS.validation.tier1_gpt_fallback > 0) {
      console.log(`     └─> GPT Fallback: ${METRICS.validation.tier1_gpt_fallback} 🤖`);
    }
    console.log(`  Tier 2 (Perplexity): ${METRICS.validation.tier2_yes} YES / ${METRICS.validation.tier2_no} NO / ${METRICS.validation.tier2_unclear} UNCLEAR`);
    if (METRICS.validation.tier2_year_corrected > 0) {
      console.log(`     └─> Year Auto-Corrected: ${METRICS.validation.tier2_year_corrected} 🔧`);
    }
    console.log(`  Tier 3 (Exa include_text): ${METRICS.validation.tier3_success} ✅ / ${METRICS.validation.tier3_fail} ❌`);
    if (METRICS.validation.tier3_retries > 0) {
      console.log(`     └─> Retries: ${METRICS.validation.tier3_retries} 🔄`);
    }
    
    if (Object.keys(METRICS.dropReasons).length > 0) {
      console.log(`\nDrop Reasons:`);
      Object.entries(METRICS.dropReasons).forEach(([r, c]) => console.log(`  - ${r}: ${c}`));
    }
    
    console.log(`\nAPI Calls:`);
    console.log(`  - Perplexity (Seeding): ${METRICS.apiCalls.perplexity}`);
    console.log(`  - Perplexity (Validation): ${METRICS.apiCalls.perplexity_validation}`);
    console.log(`  - OpenAI (gpt-4o): ${METRICS.apiCalls.openai}`);
    console.log(`  - OpenAI (gpt-4o-mini): ${METRICS.apiCalls.openai_mini}`);
    console.log(`  - Exa Search: ${METRICS.apiCalls.exa_search}`);
    console.log(`  - Exa Contents: ${METRICS.apiCalls.exa_contents}`);
    console.log(`  - Wikidata: ${METRICS.apiCalls.wikidata}`);
    console.log(`  - Cache Hits: ${METRICS.cacheHits}`);
    
    console.log(`\nEstimated Costs:`);
    console.log(`  - Perplexity: $${METRICS.costs.perplexity.toFixed(4)}`);
    console.log(`  - OpenAI: $${METRICS.costs.openai.toFixed(4)}`);
    console.log(`  - Exa: $${METRICS.costs.exa.toFixed(4)}`);
    console.log(`  - Total: $${(METRICS.costs.perplexity + METRICS.costs.openai + METRICS.costs.exa).toFixed(4)}`);
    console.log(`${"=".repeat(70)}`);
    console.log(`\n💾 Saved ${all.length} items → ${file}`);
    console.log(`✅ Finished.\n`);
  })();
}
