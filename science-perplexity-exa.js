// science-perplexity-exa-optimized-final.js — Option B: Perplexity + Exa Fallback
// Multi-Tier Validation: Wiki → Perplexity → Exa Differential
// Node.js 20+ compatible

const fs = require("fs");
const https = require("https");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXA_API_KEY = process.env.EXA_API_KEY;
const DEBUG = process.env.DEBUG === "true";

if (!PERPLEXITY_API_KEY || !OPENAI_API_KEY || !EXA_API_KEY) {
  console.error("❌ Missing API keys in .env file");
  process.exit(1);
}

// ========== SCIENCE CONFIGURATION ==========

const SCIENCE_CATEGORIES = [
  "Physics", "Chemistry", "Biology", "Astronomy", "Medicine",
  "Technology", "Mathematics", "Earth Science", "Engineering", "Space"
];

const ALLOWED_DOMAINS = [
  "nature.com", "science.org", "cell.com", "nih.gov", "nasa.gov",
  "newscientist.com", "sciencedaily.com", "phys.org", "esa.int",
  "scientificamerican.com", "space.com", "technologyreview.com",
  "ieee.org", "aaas.org", "aps.org", "royalsociety.org", "pnas.org",
  "sciencenews.org", "livescience.com", "nationalgeographic.com"
];

const EU_DOMAINS = [
  "europa.eu", "esa.int", "cern.ch", "embl.org", "ebi.ac.uk",
  "eso.org", "mpg.de", "cnrs.fr", "csic.es"
];

// ========== CACHING ==========
const CACHE = new Map();
const CONTENTS_CACHE = new Map();
const WIKI_CACHE = new Map();
const APOD_EVENTS = []; // Store APOD events separately

// ========== API HELPERS ==========

function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function callPerplexity(messages, system = null) {
  const cacheKey = JSON.stringify({ messages, system });
  if (CACHE.has(cacheKey)) {
    if (DEBUG) console.log("      💾 Using cached Perplexity response");
    return CACHE.get(cacheKey);
  }

  const body = {
    model: "sonar",
    messages: system 
      ? [{ role: "system", content: system }, ...messages]
      : messages
  };

  const options = {
    hostname: "api.perplexity.ai",
    path: "/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json"
    }
  };

  const response = await httpsRequest(options, JSON.stringify(body));
  const content = response.choices[0].message.content;
  CACHE.set(cacheKey, content);
  return content;
}

async function callOpenAI(systemPrompt, userPrompt, model = "gpt-4o-mini") {
  const cacheKey = JSON.stringify({ systemPrompt, userPrompt, model });
  if (CACHE.has(cacheKey)) {
    if (DEBUG) console.log("      💾 Using cached OpenAI response");
    return CACHE.get(cacheKey);
  }

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0
  };

  const options = {
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    }
  };

  const response = await httpsRequest(options, JSON.stringify(body));
  const content = response.choices[0].message.content.trim();
  CACHE.set(cacheKey, content);
  return content;
}

async function exaSearch(query, numResults = 10) {
  const cacheKey = `exa:${query}:${numResults}`;
  if (CACHE.has(cacheKey)) {
    if (DEBUG) console.log("      💾 Using cached Exa search");
    return CACHE.get(cacheKey);
  }

  const body = {
    query,
    numResults,
    useAutoprompt: false,
    type: "keyword",
    category: "science and technology"
  };

  const options = {
    hostname: "api.exa.ai",
    path: "/search",
    method: "POST",
    headers: {
      "x-api-key": EXA_API_KEY,
      "Content-Type": "application/json"
    }
  };

  const response = await httpsRequest(options, JSON.stringify(body));
  CACHE.set(cacheKey, response.results || []);
  return response.results || [];
}

async function exaContents(ids) {
  const cacheKey = `exa:contents:${ids.join(",")}`;
  if (CACHE.has(cacheKey)) {
    if (DEBUG) console.log("      💾 Using cached Exa contents");
    return CACHE.get(cacheKey);
  }

  const body = { ids };
  const options = {
    hostname: "api.exa.ai",
    path: "/contents",
    method: "POST",
    headers: {
      "x-api-key": EXA_API_KEY,
      "Content-Type": "application/json"
    }
  };

  const response = await httpsRequest(options, JSON.stringify(body));
  CACHE.set(cacheKey, response.results || []);
  return response.results || [];
}

async function fetchWikipediaPage(title) {
  if (WIKI_CACHE.has(title)) {
    if (DEBUG) console.log(`      💾 Using cached Wikipedia: ${title}`);
    return WIKI_CACHE.get(title);
  }

  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}`;
  
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const pages = json.query?.pages || {};
          const page = Object.values(pages)[0];
          const text = page?.extract || "";
          WIKI_CACHE.set(title, text);
          resolve(text);
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

// ========== PERPLEXITY PROMPTS ==========

function buildPerplexityPrompt(category) {
  return `You are a science historian specializing in ${category}.

Find 3-5 significant scientific events, discoveries, or breakthroughs in ${category} that happened on this date (any year).

Focus on:
- Major discoveries, breakthroughs, or innovations
- Historic experiments or observations  
- Important scientific publications
- Significant technology demonstrations
- Space missions or astronomical events

For each event provide:
1. **Title**: Clear, specific title with proper nouns
2. **Context**: 2-3 sentences with precise details (names, places, technical terms)
3. **Date**: Exact format MM-DD (e.g., 10-08)
4. **Year**: YYYY format
5. **QID**: Wikidata ID if available (e.g., Q12345)
6. **Sources**: 2-3 URLs from reputable science sources

Return as JSON array:
[{
  "title": "First Artificial Pacemaker Successfully Implanted",
  "context": "Surgeon Åke Senning at Karolinska Hospital in Stockholm implanted the first fully implantable pacemaker into patient Arne Larsson. The device, developed by engineer Rune Elmqvist, marked a breakthrough in cardiac medicine.",
  "date": "10-08",
  "year": "1958",
  "qid": "Q177777",
  "sources": ["https://www.nature.com/...", "https://www.science.org/..."]
}]

Be precise with dates and facts. Only include events you can verify.`;
}

async function seedCategory(category, month, day) {
  console.log(`\n📚 Seeding ${category}...`);
  
  const prompt = buildPerplexityPrompt(category);
  const userMessage = `Find significant ${category} events that happened on ${month} ${day} (any year in history).`;
  
  try {
    const response = await callPerplexity([
      { role: "user", content: userMessage }
    ], prompt);
    
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`  ⚠️ No valid JSON found for ${category}`);
      return [];
    }
    
    const events = JSON.parse(jsonMatch[0]);
    console.log(`  ✅ Found ${events.length} events`);
    
    return events.map(e => ({
      ...e,
      category,
      eventType: "event"
    }));
  } catch (err) {
    console.log(`  ❌ Error seeding ${category}: ${err.message}`);
    return [];
  }
}

async function seedBirthdaysDeaths(month, day) {
  console.log(`\n👤 Seeding Births/Deaths for ${month} ${day}...`);
  
  const prompt = `You are a science historian.

Find 2-3 notable scientists, inventors, or engineers who were either BORN or DIED on this date (any year).

For each person provide:
1. **Title**: "[Full Name] born/died"
2. **Context**: 2-3 sentences about their major contributions to science
3. **Date**: MM-DD format
4. **Year**: Year of birth/death
5. **QID**: Wikidata ID if available
6. **Type**: "birth" or "death"
7. **Sources**: 2-3 reputable URLs

Return as JSON array:
[{
  "title": "Marie Curie born",
  "context": "Marie Skłodowska Curie was a Polish-French physicist and chemist who conducted pioneering research on radioactivity. She was the first woman to win a Nobel Prize and remains the only person to win Nobel Prizes in two scientific fields.",
  "date": "11-07",
  "year": "1867",
  "qid": "Q7186",
  "type": "birth",
  "sources": ["https://...", "https://..."]
}]`;
  
  try {
    const response = await callPerplexity([
      { role: "user", content: `Find notable scientists born or died on ${month} ${day}.` }
    ], prompt);
    
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`  ⚠️ No valid JSON found`);
      return [];
    }
    
    const people = JSON.parse(jsonMatch[0]);
    console.log(`  ✅ Found ${people.length} births/deaths`);
    
    return people.map(p => ({
      ...p,
      category: "Scientists",
      eventType: p.type
    }));
  } catch (err) {
    console.log(`  ❌ Error seeding births/deaths: ${err.message}`);
    return [];
  }
}

async function seedAPODEvents(month, day) {
  console.log(`\n🌌 Checking APOD for ${month} ${day}...`);
  
  const prompt = `You are an astronomy historian.

Check if NASA's Astronomy Picture of the Day (APOD) has featured any significant astronomical events, discoveries, or observations for this date (any year).

Return ONLY events that are:
- Major astronomical discoveries
- Historic space missions
- Significant telescope observations
- Notable celestial events

Format as JSON:
[{
  "title": "Hubble Discovers Dark Energy Acceleration",
  "context": "The Hubble Space Telescope provided crucial evidence that the universe's expansion is accelerating, revolutionizing cosmology and leading to the discovery of dark energy.",
  "date": "03-15",
  "year": "1998",
  "qid": null,
  "sources": ["https://apod.nasa.gov/...", "https://hubblesite.org/..."]
}]

If no significant APOD events exist for this date, return empty array [].`;
  
  try {
    const response = await callPerplexity([
      { role: "user", content: `Check APOD archives for ${month} ${day}` }
    ], prompt);
    
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`  ⚠️ No APOD events found`);
      return [];
    }
    
    const events = JSON.parse(jsonMatch[0]);
    if (events.length === 0) {
      console.log(`  ℹ️ No APOD events for this date`);
      return [];
    }
    
    console.log(`  ✅ Found ${events.length} APOD events`);
    
    return events.map(e => ({
      ...e,
      category: "Astronomy",
      eventType: "apod"
    }));
  } catch (err) {
    console.log(`  ❌ Error checking APOD: ${err.message}`);
    return [];
  }
}

// ========== VALIDATION TIERS ==========

// TIER 0: Wikipedia "On This Day" Page
async function validateWithWikipediaOTD(event, month, day) {
  console.log(`\n      📖 TIER 0: Wikipedia "On This Day" Check`);
  console.log(`         Event: ${event.title}`);
  
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const monthName = monthNames[parseInt(month) - 1];
  const pageTitle = `${monthName}_${parseInt(day)}`;
  
  try {
    const pageText = await fetchWikipediaPage(pageTitle);
    
    if (!pageText || pageText.length < 100) {
      console.log(`         ⚠️ Could not fetch Wikipedia page`);
      return { pass: false, reason: "wiki-fetch-failed" };
    }
    
    // Search for event title or key terms
    const searchTerms = [
      event.title.toLowerCase(),
      ...event.title.split(' ').filter(w => w.length > 4).map(w => w.toLowerCase())
    ];
    
    const found = searchTerms.some(term => pageText.toLowerCase().includes(term));
    
    if (found) {
      console.log(`         ✅ FOUND on Wikipedia "On This Day" page`);
      return { pass: true, reason: "wiki-otd-confirmed" };
    } else {
      console.log(`         ❌ NOT found on Wikipedia "On This Day" page`);
      return { pass: false, reason: "wiki-otd-not-found" };
    }
  } catch (err) {
    console.log(`         ⚠️ Error: ${err.message}`);
    return { pass: false, reason: "wiki-otd-error" };
  }
}

// TIER 1: Wikipedia Article Validation
async function validateWithWikipediaArticle(event, month, day) {
  if (!event.qid) {
    console.log(`\n      ⏭️ TIER 1: Skipped (no QID)`);
    return { pass: false, reason: "no-qid" };
  }
  
  console.log(`\n      📖 TIER 1: Wikipedia Article Check`);
  console.log(`         Event: ${event.title}`);
  console.log(`         QID: ${event.qid}`);
  
  try {
    // Get article title from Wikidata QID
    const wikidataUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${event.qid}&format=json&props=sitelinks`;
    
    const wikidataData = await new Promise((resolve, reject) => {
      https.get(wikidataUrl, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }).on("error", reject);
    });
    
    const entity = wikidataData.entities?.[event.qid];
    const articleTitle = entity?.sitelinks?.enwiki?.title;
    
    if (!articleTitle) {
      console.log(`         ⚠️ No English Wikipedia article found for QID`);
      return { pass: false, reason: "no-enwiki-article" };
    }
    
    console.log(`         📄 Article: ${articleTitle}`);
    
    const articleText = await fetchWikipediaPage(articleTitle);
    
    if (!articleText || articleText.length < 100) {
      console.log(`         ⚠️ Could not fetch article text`);
      return { pass: false, reason: "article-fetch-failed" };
    }
    
    // Search for date pattern (month name + day number)
    const monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    const monthName = monthNames[parseInt(month) - 1];
    const dayNum = parseInt(day);
    
    // Patterns: "October 8", "8 October", "October 8th", "8th of October"
    const patterns = [
      `${monthName} ${dayNum}`,
      `${monthName} ${dayNum}th`,
      `${monthName} ${dayNum}st`,
      `${monthName} ${dayNum}nd`,
      `${monthName} ${dayNum}rd`,
      `${dayNum} ${monthName}`,
      `${dayNum}th of ${monthName}`,
      `${dayNum}st of ${monthName}`,
      `${dayNum}nd of ${monthName}`,
      `${dayNum}rd of ${monthName}`
    ];
    
    const found = patterns.some(pattern => articleText.includes(pattern));
    
    if (found) {
      console.log(`         ✅ Date CONFIRMED in Wikipedia article`);
      return { pass: true, reason: "wiki-article-confirmed" };
    } else {
      console.log(`         ❌ Date NOT found in article`);
      return { pass: false, reason: "wiki-article-date-not-found" };
    }
  } catch (err) {
    console.log(`         ⚠️ Error: ${err.message}`);
    return { pass: false, reason: "wiki-article-error" };
  }
}

// TIER 2: Perplexity Validation with Year Auto-Correction
async function validateWithPerplexity(event, monthName, day) {
  console.log(`\n      🔍 TIER 2: Perplexity Validation`);
  console.log(`         Event: ${event.title}`);
  console.log(`         Date: ${monthName} ${day}, ${event.year}`);
  
  const prompt = `Did the following scientific event happen on ${monthName} ${parseInt(day)}?

Event: "${event.title}"
Claimed Year: ${event.year}

Analyze this carefully:

1. **Date Verification**: Did this event occur on ${monthName} ${parseInt(day)}?
2. **Year Check**: If the month and day are correct, is the year ${event.year} correct?

Respond in this exact format:

VERDICT: YES / NO / UNCLEAR
REASON: [One clear sentence explaining your verdict]
CORRECT_YEAR: [If month/day correct but year wrong, provide correct year. Otherwise write "N/A"]

Examples:
- If everything is correct: "VERDICT: YES\nREASON: The event occurred on October 8, 1958.\nCORRECT_YEAR: N/A"
- If year is wrong: "VERDICT: NO\nREASON: The event occurred on October 8, but in 1959, not 1958.\nCORRECT_YEAR: 1959"
- If date is completely wrong: "VERDICT: NO\nREASON: This event occurred on August 15, not October 8.\nCORRECT_YEAR: N/A"`;

  try {
    const response = await callPerplexity([
      { role: "user", content: prompt }
    ], "You are a meticulous science historian verifying historical dates.");
    
    console.log(`         📝 Response received`);
    
    // Parse response
    const verdictMatch = response.match(/VERDICT:\s*(YES|NO|UNCLEAR)/i);
    const reasonMatch = response.match(/REASON:\s*(.+?)(?=\nCORRECT_YEAR|$)/is);
    const yearMatch = response.match(/CORRECT_YEAR:\s*(\d{4}|N\/A)/i);
    
    if (!verdictMatch) {
      console.log(`         ⚠️ Could not parse Perplexity response`);
      return { pass: false, verdict: "UNCLEAR", reason: "parse-error" };
    }
    
    const verdict = verdictMatch[1].toUpperCase();
    const reason = reasonMatch ? reasonMatch[1].trim() : "No reason provided";
    const correctYear = yearMatch && yearMatch[1] !== "N/A" ? yearMatch[1] : null;
    
    console.log(`         Verdict: ${verdict}`);
    console.log(`         Reason: ${reason}`);
    if (correctYear) {
      console.log(`         Correct Year: ${correctYear}`);
    }
    
    if (verdict === "YES") {
      console.log(`         ✅ CONFIRMED by Perplexity`);
      return { pass: true, verdict: "YES", reason: "perplexity-confirmed" };
    } else if (verdict === "NO" && correctYear) {
      // Year Auto-Correction
      console.log(`         🔄 Year correction: ${event.year} → ${correctYear}`);
      event.year = correctYear;
      event.context += ` [Year corrected from ${event.year} to ${correctYear} based on verification.]`;
      return { pass: true, verdict: "CORRECTED", reason: "perplexity-year-corrected", correctedYear: correctYear };
    } else if (verdict === "NO") {
      console.log(`         ❌ REJECTED by Perplexity`);
      return { pass: false, verdict: "NO", reason: "perplexity-rejected" };
    } else {
      console.log(`         ⚠️ UNCERTAIN - proceeding to next tier`);
      return { pass: false, verdict: "UNCLEAR", reason: "perplexity-uncertain" };
    }
  } catch (err) {
    console.log(`         ⚠️ Error: ${err.message}`);
    return { pass: false, verdict: "ERROR", reason: "perplexity-error" };
  }
}

// TIER 3: Exa Differential Query (Fallback for UNCLEAR)
async function validateWithExaDifferential(event, monthName, day) {
  console.log(`\n      🔍 TIER 3: Exa Differential Query (Fallback)`);
  console.log(`         Event: ${event.title}`);
  
  const baseQuery = `${event.title} ${monthName} ${day}`;
  
  // Query B: Natural language with date requirement
  const queryB = `scientific event "${event.title}" that occurred on ${monthName} ${parseInt(day)}`;
  
  console.log(`         Query B: "${queryB}"`);
  
  try {
    const resultsB = await exaSearch(queryB, 10);
    console.log(`         Found ${resultsB.length} results`);
    
    if (resultsB.length === 0) {
      console.log(`         ❌ No results found - event likely invalid`);
      return { pass: false, retention: 0, reason: "no-results" };
    }
    
    // Check for date in titles
    const datePattern = new RegExp(`${monthName}\\s+${parseInt(day)}|${parseInt(day)}\\s+${monthName}`, "i");
    const resultsWithDate = resultsB.filter(r => datePattern.test(r.title));
    const retentionB = (resultsWithDate.length / resultsB.length) * 100;
    
    console.log(`         📊 Retention B: ${retentionB.toFixed(1)}% (${resultsWithDate.length}/${resultsB.length} results mention date)`);
    
    // High confidence threshold
    if (retentionB >= 70) {
      console.log(`         ✅ HIGH CONFIDENCE - Event validated`);
      return { pass: true, retention: retentionB, reason: "exa-high-confidence" };
    } else if (retentionB >= 40) {
      console.log(`         ⚠️ MEDIUM CONFIDENCE - Proceed with caution`);
      return { pass: true, retention: retentionB, reason: "exa-medium-confidence" };
    } else {
      console.log(`         ❌ LOW CONFIDENCE - Event likely invalid`);
      return { pass: false, retention: retentionB, reason: "exa-low-confidence" };
    }
  } catch (err) {
    console.log(`         ⚠️ Error: ${err.message}`);
    return { pass: false, retention: 0, reason: "exa-error" };
  }
}

// TIER 4: Content Verification (Last Resort)
async function validateWithSourceContent(event, monthName, day) {
  console.log(`\n      🔍 TIER 4: Source Content Verification (Last Resort)`);
  console.log(`         Event: ${event.title}`);
  
  if (!event.sources || event.sources.length === 0) {
    console.log(`         ⚠️ No sources available`);
    return { pass: false, reason: "no-sources" };
  }
  
  const topSources = event.sources.slice(0, 2);
  console.log(`         📚 Checking ${topSources.length} sources`);
  
  let verifiedCount = 0;
  
  for (let i = 0; i < topSources.length; i++) {
    const url = topSources[i];
    console.log(`         📄 Source ${i + 1}: ${url.substring(0, 60)}...`);
    
    try {
      const response = await new Promise((resolve, reject) => {
        https.get(url, res => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => resolve(data));
        }).on("error", reject);
      });
      
      const excerpt = response.substring(0, 1000);
      
      // Check if date appears in content
      const datePattern = new RegExp(`${monthName}\\s+${parseInt(day)}|${parseInt(day)}\\s+${monthName}`, "i");
      
      if (datePattern.test(excerpt)) {
        console.log(`         ✅ Date confirmed in source ${i + 1}`);
        verifiedCount++;
      } else {
        console.log(`         ❌ Date not found in source ${i + 1}`);
      }
    } catch (err) {
      console.log(`         ⚠️ Could not fetch source ${i + 1}`);
    }
  }
  
  const verificationRate = (verifiedCount / topSources.length) * 100;
  console.log(`         📊 Verification Rate: ${verificationRate.toFixed(1)}% (${verifiedCount}/${topSources.length} sources)`);
  
  if (verifiedCount >= 1) {
    console.log(`         ✅ Event validated by source content`);
    return { pass: true, reason: "content-verified", verifiedCount };
  } else {
    console.log(`         ❌ Event could not be verified`);
    return { pass: false, reason: "content-not-verified" };
  }
}

// ========== MAIN VALIDATION ORCHESTRATOR ==========

async function validateEvent(event, month, day) {
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const monthName = monthNames[parseInt(month) - 1];
  
  console.log(`\n   🔍 Validating: ${event.title}`);
  console.log(`   📅 Date: ${monthName} ${day}, ${event.year}`);
  console.log(`   🏷️ Category: ${event.category}`);
  
  // TIER 0: Wikipedia "On This Day"
  const tier0 = await validateWithWikipediaOTD(event, month, day);
  if (tier0.pass) {
    console.log(`   ✅ PASSED (Tier 0: Wikipedia OTD)`);
    return { valid: true, reason: tier0.reason };
  }
  
  // TIER 1: Wikipedia Article
  const tier1 = await validateWithWikipediaArticle(event, month, day);
  if (tier1.pass) {
    console.log(`   ✅ PASSED (Tier 1: Wikipedia Article)`);
    return { valid: true, reason: tier1.reason };
  }
  
  // TIER 2: Perplexity Validation
  const tier2 = await validateWithPerplexity(event, monthName, day);
  if (tier2.pass) {
    console.log(`   ✅ PASSED (Tier 2: Perplexity${tier2.verdict === "CORRECTED" ? " - Year Corrected" : ""})`);
    return { valid: true, reason: tier2.reason, correctedYear: tier2.correctedYear };
  }
  
  // If Perplexity says NO (not UNCLEAR), reject immediately
  if (tier2.verdict === "NO") {
    console.log(`   ❌ REJECTED (Tier 2: Perplexity definitive NO)`);
    return { valid: false, reason: tier2.reason };
  }
  
  // Only proceed to Tier 3 if Perplexity is UNCLEAR
  if (tier2.verdict === "UNCLEAR") {
    // TIER 3: Exa Differential (Fallback)
    const tier3 = await validateWithExaDifferential(event, monthName, day);
    if (tier3.pass) {
      console.log(`   ✅ PASSED (Tier 3: Exa Differential - ${tier3.retention.toFixed(1)}% retention)`);
      return { valid: true, reason: tier3.reason, retention: tier3.retention };
    }
    
    // TIER 4: Content Verification (Last Resort)
    console.log(`   ⚠️ Tier 3 uncertain, proceeding to Tier 4...`);
    const tier4 = await validateWithSourceContent(event, monthName, day);
    if (tier4.pass) {
      console.log(`   ✅ PASSED (Tier 4: Content Verification)`);
      return { valid: true, reason: tier4.reason };
    }
  }
  
  // All tiers failed
  console.log(`   ❌ REJECTED (All validation tiers failed)`);
  return { valid: false, reason: "all-tiers-failed" };
}

// ========== POLISH WITH GPT ==========

async function polishWithGPT(event) {
  if (!event.context || event.context.trim().length === 0) {
    return event;
  }
  
  const prompt = `You are a science writer. Polish this scientific event description to be clear, precise, and engaging.

Requirements:
- Keep it factual and accurate
- Use precise scientific terminology
- 2-3 sentences maximum
- Include key details (names, places, technical terms)
- Make it accessible but not oversimplified

Original: ${event.context}

Return ONLY the polished text, nothing else.`;
  
  try {
    const polished = await callOpenAI(
      "You are a science writer specializing in clear, accurate science communication.",
      prompt,
      "gpt-4o-mini"
    );
    
    return { ...event, context: polished };
  } catch (err) {
    console.log(`  ⚠️ Could not polish event: ${err.message}`);
    return event;
  }
}

// ========== MAIN FUNCTION ==========

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node science-perplexity-exa-optimized-final.js <month> <day>");
    console.error("Example: node science-perplexity-exa-optimized-final.js 10 08");
    process.exit(1);
  }
  
  const month = args[0].padStart(2, "0");
  const day = args[1].padStart(2, "0");
  
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const monthName = monthNames[parseInt(month) - 1];
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔬 SCIENCE EVENTS FOR ${monthName.toUpperCase()} ${parseInt(day)}`);
  console.log(`${"=".repeat(60)}\n`);
  
  console.log(`📊 Configuration:`);
  console.log(`   • Validation: Option B (Perplexity + Exa Fallback)`);
  console.log(`   • Categories: ${SCIENCE_CATEGORIES.length}`);
  console.log(`   • Allowed Domains: ${ALLOWED_DOMAINS.length}`);
  console.log(`\n${"=".repeat(60)}\n`);
  
  // Step 1: Seed all categories
  console.log(`🌱 PHASE 1: SEEDING EVENTS\n`);
  
  let allEvents = [];
  
  for (const category of SCIENCE_CATEGORIES) {
    const events = await seedCategory(category, monthName, day);
    allEvents.push(...events);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
  }
  
  // Step 2: Seed birthdays and deaths
  const birthsDeaths = await seedBirthdaysDeaths(monthName, day);
  allEvents.push(...birthsDeaths);
  
  // Step 3: Seed APOD events (stored separately for now)
  const apodEvents = await seedAPODEvents(monthName, day);
  APOD_EVENTS.push(...apodEvents);
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📋 SEEDING SUMMARY:`);
  console.log(`   • Regular Events: ${allEvents.filter(e => e.eventType === "event").length}`);
  console.log(`   • Births: ${allEvents.filter(e => e.eventType === "birth").length}`);
  console.log(`   • Deaths: ${allEvents.filter(e => e.eventType === "death").length}`);
  console.log(`   • APOD Events (stored): ${APOD_EVENTS.length}`);
  console.log(`   • Total to validate: ${allEvents.length}`);
  console.log(`${"=".repeat(60)}\n`);
  
  // Step 4: Validate all events
  console.log(`🔍 PHASE 2: VALIDATION (Perplexity + Exa Fallback)\n`);
  
  const validatedEvents = [];
  const rejectedEvents = [];
  
  for (let i = 0; i < allEvents.length; i++) {
    const event = allEvents[i];
    console.log(`\n[${i + 1}/${allEvents.length}] Processing...`);
    
    const result = await validateEvent(event, month, day);
    
    if (result.valid) {
      validatedEvents.push(event);
    } else {
      rejectedEvents.push({ ...event, rejectionReason: result.reason });
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limiting
  }
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ VALIDATION SUMMARY:`);
  console.log(`   • Validated: ${validatedEvents.length}`);
  console.log(`   • Rejected: ${rejectedEvents.length}`);
  console.log(`   • Success Rate: ${((validatedEvents.length / allEvents.length) * 100).toFixed(1)}%`);
  console.log(`${"=".repeat(60)}\n`);
  
  // Step 5: Check if we need APOD events as fallback
  const MIN_EVENTS = 8;
  let finalEvents = [...validatedEvents];
  
  if (finalEvents.length < MIN_EVENTS && APOD_EVENTS.length > 0) {
    console.log(`\n⚠️ Only ${finalEvents.length} validated events (minimum: ${MIN_EVENTS})`);
    console.log(`🌌 Adding APOD events as fallback...\n`);
    
    const needed = MIN_EVENTS - finalEvents.length;
    const apodToAdd = APOD_EVENTS.slice(0, needed);
    
    for (const apod of apodToAdd) {
      console.log(`   + Adding APOD: ${apod.title}`);
      finalEvents.push(apod);
    }
    
    console.log(`\n✅ Added ${apodToAdd.length} APOD events`);
  }
  
  // Step 6: Polish all events
  console.log(`\n✨ PHASE 3: POLISHING EVENTS\n`);
  
  const polishedEvents = [];
  for (let i = 0; i < finalEvents.length; i++) {
    const event = finalEvents[i];
    console.log(`[${i + 1}/${finalEvents.length}] Polishing: ${event.title}...`);
    const polished = await polishWithGPT(event);
    polishedEvents.push(polished);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`\n✅ Polished ${polishedEvents.length} events`);
  
  // Step 7: Export results
  console.log(`\n💾 PHASE 4: EXPORTING RESULTS\n`);
  
  const output = {
    date: `${month}-${day}`,
    generated: new Date().toISOString(),
    categories: SCIENCE_CATEGORIES,
    stats: {
      seeded: allEvents.length,
      validated: validatedEvents.length,
      rejected: rejectedEvents.length,
      apod_added: finalEvents.length - validatedEvents.length,
      final: polishedEvents.length,
      success_rate: ((validatedEvents.length / allEvents.length) * 100).toFixed(1) + "%"
    },
    events: polishedEvents,
    rejected: rejectedEvents
  };
  
  const filename = `science_${month}-${day}_${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  
  console.log(`✅ Exported to: ${filename}`);
  
  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 FINAL SUMMARY:`);
  console.log(`   • Date: ${monthName} ${parseInt(day)}`);
  console.log(`   • Events Seeded: ${allEvents.length}`);
  console.log(`   • Events Validated: ${validatedEvents.length}`);
  console.log(`   • Events Rejected: ${rejectedEvents.length}`);
  console.log(`   • APOD Events Added: ${finalEvents.length - validatedEvents.length}`);
  console.log(`   • Final Events: ${polishedEvents.length}`);
  console.log(`   • Success Rate: ${output.stats.success_rate}`);
  console.log(`${"=".repeat(60)}\n`);
  
  // Event breakdown
  console.log(`📋 Events Summary:\n`);
  polishedEvents.forEach((e, i) => {
    const type = e.eventType === "birth" ? "👤 Birth" : 
                 e.eventType === "death" ? "🕯️ Death" :
                 e.eventType === "apod" ? "🌌 APOD" : "📅 Event";
    console.log(`${i + 1}. ${type}: ${e.title} (${e.year})`);
    console.log(`   Category: ${e.category}`);
    console.log(`   Context: ${e.context.substring(0, 100)}...`);
    console.log(``);
  });
}

main().catch(err => {
  console.error(`\n❌ Fatal Error: ${err.message}`);
  process.exit(1);
});
