// science-perplexity-exa-optimized-optionB.js — Option B: Perplexity + Exa Fallback
// Multi-Tier Validation: Wikipedia → Perplexity (Main) → Exa Differential (Fallback)
// Node.js 20+ compatible
//
// VALIDATION FLOW:
// - TIER 0: Wikipedia "On This Day" (free, fast)
// - TIER 1: Wikipedia Article (free, requires QID)
// - TIER 2: Perplexity Validation (main validator, $0.003/event)
//   • YES → PASS immediately
//   • NO (date correct) → Year Auto-Correction
//   • NO (date wrong) → REJECT
//   • UNCLEAR → Proceed to Tier 3
// - TIER 3: Exa Differential (fallback, $0.006/event, only on UNCLEAR)
// - TIER 4: Content Verification (last resort, only on UNCLEAR)

const fs = require("fs");
const https = require("https");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXA_API_KEY = process.env.EXA_API_KEY;
const DEBUG = !!Number(process.env.DEBUG ?? 0);
// Option B: Perplexity + Exa Fallback (no GPT Sanity Check)

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
  apiCalls: { perplexity: 0, perplexity_validation: 0, openai: 0, openai_mini: 0, exa_search: 0, exa_contents: 0 },
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
    tier2_yes: 0,  // Perplexity YES
    tier2_no: 0,   // Perplexity NO
    tier2_unclear: 0,  // Perplexity UNCLEAR
    tier2_year_corrected: 0,
    tier3_success: 0,  // Exa Differential success
    tier3_fail: 0,
    tier3_uncertain: 0,
    tier3_falsification_failed: 0,
    tier3_title_matches: 0,
    tier4_success: 0,  // Content verification success
    tier4_fail: 0
  }
};

// ---------- Global Cache ----------
const CONTENTS_CACHE = new Map();
const WIKI_ON_THIS_DAY_CACHE = new Map(); // month-day -> text
const EXA_SEARCH_CACHE = new Map(); // query -> results
const PERPLEXITY_VALIDATION_CACHE = new Map(); // event_key -> verdict

// ---------- Helpers ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uniq(arr) { return [...new Set(arr)]; }
function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// Parse date from Perplexity's ACTUAL_DATE field (e.g., "October 8, 1975")
function parsePerplexityDate(dateStr) {
  if (!dateStr) return null;
  
  // Try to parse various date formats
  const patterns = [
    /(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,  // "October 8, 1975" or "October 8 1975"
    /(\d{1,2})\s+(\w+),?\s+(\d{4})/i,  // "8 October, 1975"
    /(\d{4})-(\d{2})-(\d{2})/,         // "1975-10-08"
  ];
  
  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      let month, day, year;
      
      if (pattern.source.includes('\\w+')) {
        // Text month format
        if (match[1].match(/^\w+$/)) {
          // "October 8, 1975"
          month = match[1];
          day = parseInt(match[2]);
          year = parseInt(match[3]);
        } else {
          // "8 October, 1975"
          day = parseInt(match[1]);
          month = match[2];
          year = parseInt(match[3]);
        }
      } else {
        // ISO format "1975-10-08"
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
  // News
  "bbc.com", "bbc.co.uk", "reuters.com", "apnews.com", "theguardian.com",
  "cnn.com", "nytimes.com", "telegraph.co.uk", "independent.co.uk",
  // Science Journals & Publications
  "nature.com", "science.org", "sciencemag.org", "cell.com", "thelancet.com",
  "scientificamerican.com", "newscientist.com", "sciencedaily.com",
  "pnas.org", "journals.aps.org", "iopscience.iop.org",
  // Space Agencies
  "nasa.gov", "esa.int", "spacex.com", "space.com", "planetary.org",
  // Academic & Research
  "mit.edu", "stanford.edu", "harvard.edu", "ox.ac.uk", "cam.ac.uk",
  "nobelprize.org", "royalsociety.org", "aaas.org",
  // Medical
  "nih.gov", "cdc.gov", "who.int", "mayoclinic.org", "bmj.com",
  // Technology
  "ieee.org", "acm.org", "sciencedirect.com", "springer.com",
  // Historical & Archives (for older events 1700s-1900s)
  "jstor.org", "archive.org", "loc.gov", "biodiversitylibrary.org",
  "historyofinformation.com", "todayinsci.com", "onthisday.com",
  // Museums & Institutions
  "si.edu", "nhm.ac.uk", "amnh.org", "exploratorium.edu",
  // General
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
  "nasa.gov", "esa.int", "nih.gov", "cdc.gov", "who.int"
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
  // Check cache first
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
    excludeDomains: UGC_BLOCK
  };
  
  const json = await postJSON("api.exa.ai", "/search", payload, { "x-api-key": EXA_API_KEY });
  
  METRICS.apiCalls.exa_search++;
  METRICS.costs.exa += 0.001;
  
  const results = Array.isArray(json?.results) ? json.results : [];
  
  // Cache the results
  EXA_SEARCH_CACHE.set(cacheKey, results);
  
  return results;
}

async function exaContents(ids) {
  if (!ids.length) return [];
  
  const json = await postJSON("api.exa.ai", "/contents", { ids, text: true, format: "markdown" }, { "x-api-key": EXA_API_KEY });
  
  METRICS.apiCalls.exa_contents++;
  METRICS.costs.exa += ids.length * 0.0001;
  
  return Array.isArray(json?.results) ? json.results : [];
}

// ---------- TIER 0: Wikipedia "On This Day" ----------
async function getWikipediaOnThisDay(monthName, day) {
  const cacheKey = `${monthName}_${day}`;
  
  // Check cache first
  if (WIKI_ON_THIS_DAY_CACHE.has(cacheKey)) {
    console.log(`      💾 Cache hit: Wikipedia ${monthName}_${day} page`);
    METRICS.cacheHits++;
    return WIKI_ON_THIS_DAY_CACHE.get(cacheKey);
  }
  
  console.log(`      🌐 Fetching Wikipedia "On This Day" page: ${monthName}_${day}`);
  
  try {
    // Search for the Wikipedia date page
    const searchQuery = `site:en.wikipedia.org/wiki/${monthName}_${day}`;
    const results = await exaSearch(searchQuery, { numResults: 1 });
    
    if (results.length === 0) {
      console.log(`      ⚠️ Could not find Wikipedia date page`);
      return null;
    }
    
    // Get content
    const contents = await exaContents([results[0].id]);
    if (contents.length === 0) {
      console.log(`      ⚠️ Could not fetch Wikipedia date page content`);
      return null;
    }
    
    const text = contents[0].text || "";
    console.log(`      ✅ Wikipedia date page fetched (${text.length} chars)`);
    
    // Cache it
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
  console.log(`         Year: ${event.year}`);
  
  const wikiText = await getWikipediaOnThisDay(monthName, day);
  
  if (!wikiText) {
    console.log(`         ⚠️ Could not load Wikipedia date page - skipping`);
    return { validated: false, reason: 'wiki-date-page-unavailable' };
  }
  
  // Search for event in the text
  // Try multiple search strategies
  const searchTerms = [
    event.title,
    ...(event.keywords || []),
    event.year.toString()
  ];
  
  let foundMentions = [];
  const wikiLower = wikiText.toLowerCase();
  
  // Look for title or keywords + year
  for (const term of searchTerms) {
    if (term && wikiLower.includes(term.toLowerCase())) {
      foundMentions.push(term);
    }
  }
  
  console.log(`         🔎 Search terms found: ${foundMentions.length}/${searchTerms.length}`);
  if (foundMentions.length > 0) {
    console.log(`         📌 Found: ${foundMentions.join(', ')}`);
  }
  
  // Check if year is mentioned near the event
  const yearStr = event.year.toString();
  const hasYear = wikiLower.includes(yearStr);
  
  // Need at least title OR 2+ keywords + year
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

// ---------- TIER 2: GPT Sanity Check + Keyword Optimization ----------
async function validateWithGPTSanityCheck(event, monthName, day) {
  console.log(`\n      🔍 TIER 2: GPT Sanity Check + Keyword Optimization`);
  console.log(`         Event: ${event.title}`);
  console.log(`         Date: ${monthName} ${parseInt(day)}, ${event.year}`);
  
  const prompt = `Evaluate this scientific event:

EVENT: ${event.title}
DATE: ${monthName} ${parseInt(day)}, ${event.year}
CONTEXT: ${event.context.substring(0, 200)}...

Task 1: Is this date PLAUSIBLE?
Answer: PLAUSIBLE / IMPLAUSIBLE / UNCERTAIN

Task 2: If plausible/uncertain, provide 3-5 SPECIFIC search keywords that would uniquely identify this event.
Use DISTINCTIVE terms (names, places, specific concepts), NOT dates, months, years, or generic words.

Format:
VERDICT: [your answer]
KEYWORDS: keyword1, keyword2, keyword3`;

  try {
    const response = await callOpenAI(
      "You are a historical fact-checker specializing in science history.",
      prompt,
      0.3,
      100,
      "gpt-4o-mini"
    );
    
    console.log(`         🤖 GPT Response: ${response.substring(0, 100)}...`);
    
    const lines = response.split('\n');
    const verdictLine = lines.find(l => l.toUpperCase().includes('VERDICT'));
    const keywordsLine = lines.find(l => l.toUpperCase().includes('KEYWORDS'));
    
    let verdict = 'UNCERTAIN';
    if (verdictLine) {
      if (verdictLine.toUpperCase().includes('IMPLAUSIBLE')) verdict = 'IMPLAUSIBLE';
      else if (verdictLine.toUpperCase().includes('PLAUSIBLE')) verdict = 'PLAUSIBLE';
    }
    
    console.log(`         📊 Verdict: ${verdict}`);
    
    if (verdict === 'IMPLAUSIBLE') {
      console.log(`         ❌ GPT says IMPLAUSIBLE - EVENT REJECTED`);
      METRICS.validation.tier2_implausible++;
      return { validated: false, keywords: null, reason: 'gpt-implausible' };
    }
    
    let betterKeywords = null;
    if (keywordsLine) {
      const keywordsPart = keywordsLine.split(':')[1]?.trim();
      if (keywordsPart) {
        const rawKeywords = keywordsPart.split(',').map(k => k.trim()).filter(k => k.length > 2);
        
        // CRITICAL FIX: Filter out dates, months, years from keywords
        const datePatterns = [
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
          /\b\d{1,2}\b/,  // day numbers
          /\b\d{4}\b/,    // years
          /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i
        ];
        
        betterKeywords = rawKeywords.filter(keyword => {
          const hasDate = datePatterns.some(pattern => pattern.test(keyword));
          return !hasDate;
        });
        
        console.log(`         🔑 Optimized keywords (dates filtered): ${betterKeywords.join(', ')}`);
      }
    }
    
    console.log(`         ✅ GPT says ${verdict} - continuing validation`);
    METRICS.validation.tier2_plausible++;
    return { validated: null, keywords: betterKeywords, reason: 'gpt-plausible' };
    
  } catch (err) {
    console.log(`         ⚠️ GPT sanity check error: ${err.message}`);
    return { validated: null, keywords: null, reason: 'gpt-error' };
  }
}

// ---------- TIER 2: Perplexity Validator (Main Validator) ----------
async function validateWithPerplexity(event, monthName, day) {
  console.log(`\n      🔍 TIER 2: Perplexity Date Validator`);
  console.log(`         Event: ${event.title}`);
  console.log(`         Date: ${monthName} ${parseInt(day)}, ${event.year}`);
  
  // Check cache first
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
    
    // Parse response
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
    
    // Cache the result
    PERPLEXITY_VALIDATION_CACHE.set(cacheKey, result);
    
    // Update metrics
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
  
  // Check if month and day match (only year is wrong)
  if (actualDate.month.toLowerCase() === monthName.toLowerCase() && 
      actualDate.day === parseInt(day)) {
    
    console.log(`         ✅ Month+Day correct (${monthName} ${day}), only YEAR wrong`);
    console.log(`         🔄 Correcting: ${event.year} → ${actualDate.year}`);
    
    // Update event metadata
    const oldYear = event.year;
    event.year = actualDate.year;
    event.date = `${actualDate.year}-${String(actualDate.monthNum).padStart(2,'0')}-${String(actualDate.day).padStart(2,'0')}`;
    
    // Ask Perplexity to rewrite context with correct year
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

// ---------- TIER 1: Wikipedia Article + QID ----------
async function validateWithWikipediaArticle(event, monthName, day) {
  console.log(`\n      🔍 TIER 1: Wikipedia Article Validation`);
  console.log(`         Event: ${event.title}`);
  console.log(`         QID: ${event.qid || 'NONE'}`);
  
  if (!event.qid) {
    console.log(`         ⚠️ No QID - skipping article check`);
    return { validated: false, reason: 'no-qid' };
  }
  
  const wikiSource = (event.sources || []).find(s => 
    s.includes('wikipedia.org') || s.includes('en.wikipedia.org')
  );
  
  if (!wikiSource) {
    console.log(`         ⚠️ No Wikipedia source - skipping`);
    return { validated: false, reason: 'no-wiki-source' };
  }
  
  console.log(`         📚 Wikipedia URL: ${wikiSource}`);
  
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
    
    // Cache it
    CONTENTS_CACHE.set(wikiSource, { text: wikiText, timestamp: Date.now() });
    
    // Search for date patterns (ONLY month + day, year doesn't matter!)
    const wikiLower = wikiText.toLowerCase();
    const monthLower = monthName.toLowerCase();
    const dayNum = parseInt(day);
    
    // Build date patterns for this specific month and day
    const datePatterns = [
      `${monthName} ${dayNum}`,       // "October 8"
      `${monthName} ${day}`,          // "October 08"
      `${dayNum} ${monthName}`,       // "8 October"
      `${day} ${monthName}`,          // "08 October"
      `${monthLower} ${dayNum}`,      // "october 8"
      `${dayNum} ${monthLower}`,      // "8 october"
    ];
    
    let dateFound = false;
    let foundPattern = '';
    
    for (const pattern of datePatterns) {
      // Look for the pattern as a whole phrase (not split up)
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
    } else {
      console.log(`         ❌ Date pattern not found in article - EVENT REJECTED`);
      METRICS.validation.tier1_fail++;
      METRICS.validation.tier1_date_mismatch++;
      return { validated: false, reason: 'wiki-date-mismatch' };
    }
    
  } catch (err) {
    console.log(`         ⚠️ Wikipedia article error: ${err.message}`);
    METRICS.validation.tier1_fail++;
    return { validated: false, reason: 'wiki-error' };
  }
}

// ---------- TIER 3: Enhanced Differential with Natural Language + Title Analysis ----------
async function validateWithDifferentialQuery(event, monthName, day, optimizedKeywords = null) {
  console.log(`\n      🔍 TIER 3: Enhanced Differential + Falsification`);
  console.log(`         Event: ${event.title}`);
  
  const keywords = optimizedKeywords || event.keywords || [];
  if (keywords.length === 0) {
    console.log(`         ⚠️ No keywords - using title words`);
    const titleWords = event.title.split(' ').filter(w => w.length > 3).slice(0, 5);
    keywords.push(...titleWords);
  }
  
  // Generate wrong date (+7 days, handles month overflow)
  const correctDate = new Date(Date.parse(`${monthName} ${parseInt(day)}, 2000`));
  const wrongDate = new Date(correctDate);
  wrongDate.setDate(correctDate.getDate() + 7);
  const wrongMonthName = wrongDate.toLocaleString("en", { month: "long" });
  const wrongDay = wrongDate.getDate();
  
  // BASE QUERY: Just keywords (no date)
  const baseQuery = keywords.slice(0, 5).join(' ');
  
  // NATURAL LANGUAGE QUERIES with dates
  const correctNLQuery = `What happened on ${monthName} ${parseInt(day)} ${event.year} ${baseQuery}`;
  const wrongNLQuery = `What happened on ${wrongMonthName} ${wrongDay} ${event.year} ${baseQuery}`;
  
  console.log(`         Query A (baseline): "${baseQuery}"`);
  console.log(`         Query B (correct NL):  "${correctNLQuery}"`);
  console.log(`         Query C (wrong NL):    "${wrongNLQuery}"`);
  
  try {
    // Query A: Baseline
    console.log(`         🔎 Running Query A...`);
    const resultsA = await exaSearch(baseQuery, { numResults: 15 });
    const countA = resultsA.length;
    console.log(`         📊 A (baseline): ${countA}`);
    
    if (countA === 0) {
      console.log(`         ⚠️ No baseline results`);
      return { validated: false, results: [], reason: 'no-baseline-results' };
    }
    
    await sleep(500);
    
    // Query B: Correct date (Natural Language)
    console.log(`         🔎 Running Query B...`);
    const resultsB = await exaSearch(correctNLQuery, { numResults: 15 });
    const countB = resultsB.length;
    console.log(`         📊 B (correct NL):  ${countB}`);
    
    await sleep(500);
    
    // Query C: Wrong date (Natural Language - falsification test)
    console.log(`         🔎 Running Query C...`);
    const resultsC = await exaSearch(wrongNLQuery, { numResults: 15 });
    const countC = resultsC.length;
    console.log(`         📊 C (wrong NL):    ${countC}`);
    
    const retentionB = (countB / countA) * 100;
    const retentionC = (countC / countA) * 100;
    
    console.log(`         📈 Retention B (correct): ${retentionB.toFixed(1)}%`);
    console.log(`         📈 Retention C (wrong):   ${retentionC.toFixed(1)}%`);
    
    // TITLE DATE ANALYSIS (NEW!)
    console.log(`\n         🔍 TITLE DATE ANALYSIS:`);
    const titleMatchesB = countTitleDateMatches(resultsB, monthName, parseInt(day), event.year);
    const titleMatchesC = countTitleDateMatches(resultsC, wrongMonthName, wrongDay, event.year);
    
    console.log(`         📰 Titles with correct date: ${titleMatchesB}/${countB}`);
    console.log(`         📰 Titles with wrong date: ${titleMatchesC}/${countC}`);
    
    METRICS.validation.tier3_title_matches += titleMatchesB;
    
    // DECISION LOGIC
    
    // Strong title signal?
    if (titleMatchesB >= 5 && titleMatchesC === 0) {
      console.log(`         ✅✅ PASSED - Strong title date matches (${titleMatchesB} vs ${titleMatchesC})`);
      METRICS.validation.tier3_success++;
      return { validated: true, results: resultsB, reason: 'title-date-strong' };
    }
    
    if (titleMatchesB >= 3 && titleMatchesC < 2 && titleMatchesB > titleMatchesC * 2) {
      console.log(`         ✅ PASSED - Good title date signal (${titleMatchesB} vs ${titleMatchesC})`);
      METRICS.validation.tier3_success++;
      return { validated: true, results: resultsB, reason: 'title-date-good' };
    }
    
    // FALSIFICATION TEST: Wrong date should perform WORSE than correct date
    if (retentionC > retentionB) {
      console.log(`         ❌ REJECTED - Wrong date performs BETTER (${retentionC.toFixed(1)}% > ${retentionB.toFixed(1)}%)`);
      console.log(`         🚨 This suggests the date is incorrect!`);
      METRICS.validation.tier3_fail++;
      METRICS.validation.tier3_falsification_failed++;
      return { validated: false, results: [], reason: 'differential-falsification-failed' };
    }
    
    // Correct date is better - check retention threshold
    if (retentionB >= 60 && titleMatchesB > 0) {
      console.log(`         ✅ PASSED - Correct date strong (${retentionB.toFixed(1)}%), ${titleMatchesB} title matches`);
      METRICS.validation.tier3_success++;
      return { validated: true, results: resultsB, reason: 'differential-high' };
    } else if (retentionB >= 40 && titleMatchesB >= 2) {
      console.log(`         ✅ PASSED - Moderate retention + title matches`);
      METRICS.validation.tier3_success++;
      return { validated: true, results: resultsB, reason: 'differential-moderate-with-titles' };
    } else if (retentionB >= 40) {
      console.log(`         ⚠️ Uncertain (40-60%, ${titleMatchesB} title matches) - needs content verification`);
      return { validated: null, results: resultsB, reason: 'differential-uncertain' };
    } else {
      console.log(`         ❌ REJECTED - Low retention (< 40%)`);
      METRICS.validation.tier3_fail++;
      return { validated: false, results: [], reason: 'differential-low' };
    }
    
  } catch (err) {
    console.log(`         ⚠️ Differential query error: ${err.message}`);
    METRICS.validation.tier3_fail++;
    return { validated: false, results: [], reason: 'differential-error' };
  }
}

// Helper: Count how many titles contain the date
function countTitleDateMatches(results, monthName, day, year) {
  if (!results || results.length === 0) return 0;
  
  let matches = 0;
  const monthLower = monthName.toLowerCase();
  const monthShort = monthName.substring(0, 3).toLowerCase(); // "oct"
  const dayStr = day.toString();
  const dayPadded = day.toString().padStart(2, '0'); // "08"
  const yearStr = year ? year.toString() : null;
  
  // Date patterns to look for in titles
  const patterns = [
    new RegExp(`\\b${monthName}\\s+${dayStr}\\b`, 'i'),         // "October 8"
    new RegExp(`\\b${monthName}\\s+${dayPadded}\\b`, 'i'),      // "October 08"
    new RegExp(`\\b${dayStr}\\s+${monthName}\\b`, 'i'),         // "8 October"
    new RegExp(`\\b${dayPadded}\\s+${monthName}\\b`, 'i'),      // "08 October"
    new RegExp(`\\b${monthShort}\\.?\\s+${dayStr}\\b`, 'i'),    // "Oct. 8" or "Oct 8"
    new RegExp(`\\b${dayStr}\\s+${monthShort}\\b`, 'i'),        // "8 Oct"
  ];
  
  // Add year patterns if year is available
  if (yearStr) {
    patterns.push(
      new RegExp(`\\b${monthName}\\s+${dayStr},?\\s+${yearStr}\\b`, 'i'),  // "October 8, 1958"
      new RegExp(`\\b${dayStr}\\s+${monthName}\\s+${yearStr}\\b`, 'i'),    // "8 October 1958"
      new RegExp(`\\b${yearStr}-\\d{2}-${dayPadded}\\b`, 'i')               // "1958-10-08"
    );
  }
  
  for (const result of results) {
    const title = result.title || "";
    const url = result.url || "";
    
    // Check title
    for (const pattern of patterns) {
      if (pattern.test(title)) {
        matches++;
        if (DEBUG) console.log(`            ✓ Title match: "${title.substring(0, 80)}..."`);
        break; // Count each result only once
      }
    }
  }
  
  return matches;
}

// ---------- TIER 4: Content Verification (Last Resort) ----------
async function validateWithSourceContent(event, monthName, day, differentialResults) {
  console.log(`\n      🔍 TIER 4: Source Content Verification (Last Resort)`);
  console.log(`         Event: ${event.title}`);
  
  const topResults = differentialResults.slice(0, 2);
  console.log(`         📚 Checking top ${topResults.length} sources`);
  
  let verifiedCount = 0;
  
  for (let i = 0; i < topResults.length; i++) {
    const result = topResults[i];
    const url = result.url;
    
    console.log(`         📄 Source ${i + 1}: ${url.substring(0, 50)}...`);
    
    let content;
    if (CONTENTS_CACHE.has(url)) {
      console.log(`            💾 Using cached content`);
      content = CONTENTS_CACHE.get(url).text;
    } else {
      try {
        const contents = await exaContents([result.id]);
        if (contents.length > 0) {
          content = contents[0].text;
          CONTENTS_CACHE.set(url, { text: content, timestamp: Date.now() });
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
  
  console.log(`         ✅ Verified in ${verifiedCount}/${topResults.length} sources`);
  
  if (verifiedCount >= 1) {
    console.log(`         ✅✅ CONTENT VERIFICATION PASSED!`);
    METRICS.validation.tier4_success++;
    return { validated: true, reason: 'source-content-verified' };
  } else {
    console.log(`         ❌ No sources confirmed the date - EVENT REJECTED`);
    METRICS.validation.tier4_fail++;
    return { validated: false, reason: 'no-source-confirmation' };
  }
}

// ---------- MASTER VALIDATION (OPTION B: Perplexity + Exa Fallback) ----------
async function validateEventReality(event, monthName, day) {
  console.log(`\n   🛡️ === MULTI-TIER VALIDATION (OPTION B) ===`);
  
  // TIER 0: Wikipedia "On This Day" (Free)
  const tier0 = await validateWithWikipediaOnThisDay(event, monthName, day);
  if (tier0.validated === true) {
    console.log(`      ✅ PASSED (Tier 0: Wikipedia OTD)`);
    return { valid: true, method: 'tier0-wiki-on-this-day', reason: tier0.reason };
  }
  
  // TIER 1: Wikipedia Article (Free, requires QID)
  if (event.qid) {
    const tier1 = await validateWithWikipediaArticle(event, monthName, day);
    if (tier1.validated === true) {
      console.log(`      ✅ PASSED (Tier 1: Wikipedia Article)`);
      return { valid: true, method: 'tier1-wiki-article', reason: tier1.reason };
    }
    // If explicit date mismatch, reject immediately
    if (tier1.reason === 'wiki-date-mismatch') {
      console.log(`      ❌ REJECTED (Tier 1: Wikipedia date mismatch)`);
      return { valid: false, method: 'tier1-wiki-article', reason: tier1.reason };
    }
  }
  
  // TIER 2: Perplexity Validation ($0.003 per event - Main Validator)
  const tier2 = await validateWithPerplexity(event, monthName, day);
  
  if (tier2.verdict === 'YES') {
    // Perplexity confirmed - PASS immediately
    console.log(`      ✅ PASSED (Tier 2: Perplexity confirmed)`);
    return { valid: true, method: 'tier2-perplexity', reason: 'perplexity-confirmed' };
  }
  
  if (tier2.verdict === 'NO') {
    // Check if we can auto-correct the year (month+day correct, only year wrong)
    if (tier2.actualDate) {
      const correction = await correctEventYear(event, tier2.actualDate, tier2.reason, monthName, day);
      
      if (correction && correction.corrected) {
        console.log(`      🔄 PASSED (Tier 2: Year corrected ${correction.oldYear} → ${correction.newYear})`);
        return { valid: true, method: 'tier2-perplexity-year-corrected', reason: 'year-auto-corrected' };
      }
    }
    
    // Cannot correct - full date mismatch
    console.log(`      ❌ REJECTED (Tier 2: Perplexity definitive NO)`);
    return { valid: false, method: 'tier2-perplexity', reason: 'perplexity-rejected' };
  }
  
  // TIER 3: Exa Differential Query (Fallback for UNCLEAR, $0.006)
  if (tier2.verdict === 'UNCLEAR') {
    console.log(`\n      ⚠️ Perplexity UNCLEAR - proceeding to Exa Differential...`);
    
    const tier3 = await validateWithDifferentialQuery(event, monthName, day, event.keywords);
    
    if (tier3.validated === true) {
      console.log(`      ✅ PASSED (Tier 3: Exa Differential)`);
      return { valid: true, method: 'tier3-exa-differential', reason: tier3.reason };
    }
    
    if (tier3.validated === false) {
      console.log(`      ❌ REJECTED (Tier 3: Exa Differential failed)`);
      return { valid: false, method: 'tier3-exa-differential', reason: tier3.reason };
    }
    
    // TIER 4: Content Verification (Last Resort, only when Exa is uncertain)
    if (tier3.validated === null) {
      console.log(`\n      ⚠️ Exa uncertain - final content check...`);
      const tier4 = await validateWithSourceContent(event, monthName, day, tier3.results);
      
      if (tier4.validated) {
        console.log(`      ✅ PASSED (Tier 4: Content verified)`);
        return { valid: true, method: 'tier4-content-verified', reason: tier4.reason };
      } else {
        console.log(`      ❌ REJECTED (Tier 4: Content verification failed)`);
        return { valid: false, method: 'tier4-content-verification', reason: tier4.reason };
      }
    }
  }
  
  // Failed all validation
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

// ---------- GPT-4o Polish ----------
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
    return await callOpenAI(
      "You are a science writer who creates accurate, precise summaries of scientific discoveries and breakthroughs.",
      prompt,
      0.7,
      300
    );
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
  
  const queries = [
    `"${event.title}" "${md}"`,
    `"${event.title}" ${event.year}`,
    `${event.title} (discovery OR breakthrough OR published OR announced)`
  ];
  
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
        
        // APOD Filter - reject featured images that are not discoveries
        const apodKeywords = [
          'apod', 'astronomy picture of the day', 'picture of the day',
          'featured on apod', 'image of the day', 'astronomical image of'
        ];
        
        if (apodKeywords.some(keyword => titleLower.includes(keyword) || contextLower.includes(keyword))) {
          // Check if it's a legitimate "first image" discovery
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
        
        const errorPhrases = [
          'no globally significant', 'no major', 'search results do not',
          'no significant', 'not provide', 'no events found', 'unable to find',
          'hypothetical', 'fictional', 'imaginary'
        ];
        
        if (errorPhrases.some(phrase => titleLower.includes(phrase) || contextLower.includes(phrase))) {
          return false;
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
async function seedBirthdaysDeaths(category, needed, monthName, day) {
  console.log(`\n   🎂 Fallback: Birthdays/Deaths for ${category.name}`);
  
  const prompt = `Find ${needed} significant births or deaths of scientists who made important contributions on ${monthName} ${parseInt(day)} (any year).

FOCUS: Scientists who contributed to ${category.description}

For each person provide:
{
  "title": "Name born/died (max 60 chars)",
  "date": "YYYY-MM-DD",
  "year": YYYY,
  "category": "science",
  "type": "birthday | death",
  "qid": "Wikidata QID or null",
  "context": "Brief biography focusing on scientific contributions (80-100 words)",
  "sources": ["URL1", "URL2"],
  "keywords": ["keyword1", "keyword2"]
}

Return ONLY a valid JSON array.`;

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
      console.log(`   ✅ Found ${validEvents.length} birthday(s)/death(s)`);
      
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
  
  // MULTI-TIER VALIDATION
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
  
  // Enrichment
  const perplexitySources = (event.sources || []).filter(s => s && allowed(s));
  const needsEnrichment = perplexitySources.length < 2 || 
    (perplexitySources.length < 3 && !hasEuropeanSource(perplexitySources));
  
  let finalSources = perplexitySources;
  
  if (needsEnrichment) {
    console.log(`      🔍 Needs enrichment`);
    const exaSources = await enrichWithEXA(event);
    finalSources = uniq([...perplexitySources, ...exaSources]);
    METRICS.events.enriched++;
  }
  
  if (finalSources.length === 0) {
    console.log(`      ✗ No valid sources`);
    METRICS.events.dropped++;
    METRICS.dropReasons["no-sources"] = (METRICS.dropReasons["no-sources"] || 0) + 1;
    return null;
  }
  
  // Context enrichment
  let additionalContext = "";
  const contextWordCount = (event.context || "").split(/\s+/).length;
  if (contextWordCount < 80) {
    console.log(`      📚 Context short (${contextWordCount} words)`);
    additionalContext = extractContextFromSources(event, finalSources);
  }
  
  // Polish with GPT
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
  
  // Fallback
  if (processed.length < category.count) {
    const needed = category.count - processed.length;
    console.log(`   ⚠️ Need ${needed} more event(s), trying birthdays/deaths...`);
    
    const fallbackEvents = await seedBirthdaysDeaths(category, needed, monthName, day);
    
    for (const event of fallbackEvents) {
      if (processed.length >= category.count) break;
      const result = await processEvent(event, monthName, day);
      if (result) {
        processed.push(result);
        METRICS.events.fallback++;
      }
      await sleep(500);
    }
    
    console.log(`   ✅ Final count: ${processed.length}/${category.count}`);
  }
  
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
    console.log(`\n🔬 SCIENCE EVENT TEST v4 (Year Auto-Correct + APOD Filter)\n${"=".repeat(70)}`);
    console.log(`📅 ${TEST_DATE} (${monthName} ${parseInt(day)})`);
    console.log(`🎯 ${SCIENCE_CATEGORIES.length} categories`);
    console.log(`🤖 GPT Sanity Check: ${USE_GPT_SANITY_CHECK ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🔧 Year Auto-Correction: ENABLED`);
    console.log(`🖼️  APOD Filtering: ENABLED`);
    console.log(`${"=".repeat(70)}`);

    const all = [];
    for (const cat of SCIENCE_CATEGORIES) {
      const events = await fetchCategory(cat, monthName, day);
      all.push(...events);
      await sleep(2000);
    }

    // Convert date format
    for (const event of all) {
      if (event.date && event.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = event.date.split('-');
        event.date = `${month}-${day}`;
      }
    }

    const timestamp = Date.now();
    const file = `science-events-${TEST_DATE}-v4-${timestamp}.json`;
    
    fs.writeFileSync(file, JSON.stringify(all, null, 2));

    console.log(`\n${"=".repeat(70)}`);
    console.log(`📊 QUALITY REPORT v4 (Year Auto-Correct + APOD Filter)`);
    console.log(`${"=".repeat(70)}`);
    console.log(`Events: ${METRICS.events.seeded} seeded → ${METRICS.events.validated} validated (${METRICS.events.dropped} dropped)`);
    console.log(`Success Rate: ${((METRICS.events.validated / METRICS.events.seeded) * 100).toFixed(1)}%`);
    
    console.log(`\nValidation Breakdown:`);
    console.log(`  Tier 0 (Wiki "On This Day"): ${METRICS.validation.tier0_success} ✅ / ${METRICS.validation.tier0_fail} ❌`);
    console.log(`  Tier 1 (Wiki Article): ${METRICS.validation.tier1_success} ✅ / ${METRICS.validation.tier1_fail} ❌ (${METRICS.validation.tier1_date_mismatch} mismatches)`);
    if (USE_GPT_SANITY_CHECK) {
      console.log(`  Tier 2 (GPT Sanity): ${METRICS.validation.tier2_implausible} IMPLAUSIBLE / ${METRICS.validation.tier2_plausible} PLAUSIBLE`);
    }
    console.log(`  Tier 3 (Perplexity): ${METRICS.validation.tier3_yes} YES / ${METRICS.validation.tier3_no} NO / ${METRICS.validation.tier3_unclear} UNCLEAR`);
    if (METRICS.validation.tier3_year_corrected > 0) {
      console.log(`     └─> Year Auto-Corrected: ${METRICS.validation.tier3_year_corrected} 🔧`);
    }
    console.log(`  Tier 4 (Differential+Titles): ${METRICS.validation.tier4_success} ✅ / ${METRICS.validation.tier4_fail} ❌`);
    console.log(`     └─> Title Matches Found: ${METRICS.validation.tier4_title_matches}`);
    if (METRICS.validation.tier4_falsification_failed > 0) {
      console.log(`     └─> Falsification Failed: ${METRICS.validation.tier4_falsification_failed} 🚨`);
    }
    console.log(`  Tier 5 (Content Verification): ${METRICS.validation.tier5_success} ✅ / ${METRICS.validation.tier5_fail} ❌`);
    
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
