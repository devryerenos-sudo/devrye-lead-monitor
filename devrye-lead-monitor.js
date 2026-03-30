#!/usr/bin/env node

/**
 * DeVrye Renovations â Lead Monitor
 * Deployment: GitHub Actions (runs 3x/day, free)
 * State:      seen.json (committed back to repo after each run)
 * Alerts:     Twilio SMS
 *
 * Required env vars (set in GitHub repo Settings > Secrets > Actions):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM       â your Twilio phone number  e.g. +15191234567
 *   ALERT_NUMBER       â your cell phone           e.g. +15191234567
 */

const axios   = require("axios");
const cheerio = require("cheerio");
const twilio  = require("twilio");
const fs      = require("fs");
const path    = require("path");

const SEEN_FILE = path.join(__dirname, "seen.json");

/* ------------------------------------------------------------------ */
/*  Negative-keyword filter (reduces false positives)                 */
/* ------------------------------------------------------------------ */
const NEGATIVE_KEYWORDS = [
  "hiring", "job", "employment", "position", "salary", "wage", "resume", "apply",
  "esthetician", "attendant", "salon", "spa", "cleaning", "maid", "nanny",
  "moving", "storage", "junk removal", "landscaping", "lawn", "snow removal",
  "selling", "for sale", "brand new",
];

/**
 * Returns true if the text contains any negative keyword.
 * Call this before adding a lead â if it returns true, skip the lead.
 */
function hasNegativeKeyword(text) {
  const lower = text.toLowerCase();
  return NEGATIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

const CONFIG = {
  twilio: {
    accountSid:      process.env.TWILIO_ACCOUNT_SID,
    authToken:       process.env.TWILIO_AUTH_TOKEN,
    fromNumber:      process.env.TWILIO_FROM,
    alertNumbers:    [process.env.ALERT_NUMBER],
    minLeadsToAlert: 1,
  },
  reddit: {
    subreddits: {
      local:    ["KitchenerWaterloo","Kitchener","Waterloo","WaterlooRegion","CambridgeOntario","Guelph","WoodstockOntario","StratfordOntario"],
      national: ["ontario","HomeImprovement","DIY","CanadaHousing","PersonalFinanceCanada"],
    },
    keywords: ["renovation","renovating","contractor","kitchen reno","bathroom reno","basement finishing","basement reno","quote","estimate","general contractor","kitchen remodel","recommend a contractor","looking for a contractor"],
    geoTerms: ["waterloo","kitchener","cambridge","guelph","kw","tri-city","region of waterloo"],
    minScore: 1,
    maxAgeDays: 7,
  },
  kijiji: {
    urls: ["https://www.kijiji.ca/b-services-renovations-general-contracting/kitchener-waterloo/k0c791l1700212","https://www.kijiji.ca/b-buy-sell/kitchener-waterloo/renovation/k0c10l1700212?ad=wanting"],
    keywords: ["looking for","need a contractor","wanted","reno","renovation","kitchen","bathroom","basement","quote"],
  },
  homestars: {
    urls: ["https://homestars.com/search/canada/on/kitchener?utf8=true&search%5Bkeywords%5D=renovation","https://homestars.com/search/canada/on/waterloo?utf8=true&search%5Bkeywords%5D=renovation","https://homestars.com/search/canada/on/cambridge?utf8=true&search%5Bkeywords%5D=renovation","https://homestars.com/search/canada/on/guelph?utf8=true&search%5Bkeywords%5D=renovation"],
    keywords: ["renovation","kitchen","bathroom","basement","contractor","remodel","finishing"],
  },
  craigslist: {
    urls: [],
    searchUrls: ["https://kitchener.craigslist.org/search/sss?query=renovation+contractor","https://kitchener.craigslist.org/search/sss?query=kitchen+reno","https://kitchener.craigslist.org/search/sss?query=basement+finishing"],
    keywords: ["renovation","contractor","kitchen","bathroom","basement","reno","remodel","quote","looking for"],
  },
};

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); }
  catch { return {}; }
}

function saveSeen(seen) {
  const keys = Object.keys(seen);
  if (keys.length > 5000) {
    const trimmed = {};
    keys.slice(-5000).forEach((k) => (trimmed[k] = seen[k]));
    fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
  } else {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function matchedKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

function hasGeoSignal(text) {
  const lower = text.toLowerCase();
  return CONFIG.reddit.geoTerms.some((t) => lower.includes(t));
}

/* ------------------------------------------------------------------ */
/*  Reddit                                                             */
/* ------------------------------------------------------------------ */
async function searchReddit(seen) {
  const newLeads = [];
  const allSubs = [
    ...CONFIG.reddit.subreddits.local.map((s) => ({ sub: s, local: true })),
    ...CONFIG.reddit.subreddits.national.map((s) => ({ sub: s, local: false })),
  ];
  const cutoff = Date.now() / 1000 - CONFIG.reddit.maxAgeDays * 86400;

  for (const { sub, local } of allSubs) {
    for (const keyword of CONFIG.reddit.keywords) {
      try {
        const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(keyword)}&restrict_sr=1&sort=new&limit=25&t=week`;
        const res = await axios.get(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
          timeout: 10000
        });
        for (const { data: post } of res.data?.data?.children || []) {
          if (seen[post.id]) continue;
          if (post.created_utc < cutoff) continue;
          if (post.score < CONFIG.reddit.minScore) continue;
          const fullText = `${post.title} ${post.selftext}`;
          if (!local && !hasGeoSignal(fullText)) continue;
          const keywords = matchedKeywords(fullText, CONFIG.reddit.keywords);
          if (keywords.length === 0) continue;
          if (hasNegativeKeyword(fullText)) continue;
          seen[post.id] = Date.now();
          newLeads.push({
            source: `r/${sub}`,
            title: post.title.slice(0,120),
            url: `https://reddit.com${post.permalink}`,
            author: `u/${post.author}`,
            keywords: keywords.slice(0,3).join(", ")
          });
        }
        await sleep(1200);
      } catch (err) {
        console.error(`[Reddit] r/${sub} "${keyword}": ${err.message}`);
      }
    }
  }
  return newLeads;
}

/* ------------------------------------------------------------------ */
/*  Kijiji                                                             */
/* ------------------------------------------------------------------ */
async function searchKijiji(seen) {
  const newLeads = [];
  for (const pageUrl of CONFIG.kijiji.urls) {
    try {
      const res = await axios.get(pageUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
        timeout: 15000
      });
      const $ = cheerio.load(res.data);
      $("[data-testid='listing-card'], .search-item").each((_, el) => {
        const title = $(el).find("h3, .title").first().text().trim();
        const desc  = $(el).find(".description, [class*='description']").first().text().trim();
        const href  = $(el).find("a").first().attr("href") || "";
        const adId  = href.match(/\/(\d+)$/)?.[1] || href;
        if (!title || seen[adId]) return;
        const fullText = `${title} ${desc}`;
        const keywords = matchedKeywords(fullText, CONFIG.kijiji.keywords);
        if (keywords.length === 0) return;
        if (hasNegativeKeyword(fullText)) return;
        const phone = fullText.match(/(\+?1?\s*[\(\-\.]?\d{3}[\)\-\.\s]\s*\d{3}[\-\.\s]\d{4})/)?.[1];
        seen[adId] = Date.now();
        newLeads.push({
          source: "Kijiji KW",
          title: title.slice(0,120),
          url: href.startsWith("http") ? href : `https://www.kijiji.ca${href}`,
          author: phone || "see listing",
          keywords: keywords.slice(0,3).join(", ")
        });
      });
      await sleep(2000);
    } catch (err) {
      console.error(`[Kijiji] ${pageUrl}: ${err.message}`);
    }
  }
  return newLeads;
}

/* ------------------------------------------------------------------ */
/*  HomeStars                                                          */
/* ------------------------------------------------------------------ */
async function searchHomeStars(seen) {
  const newLeads = [];
  for (const pageUrl of CONFIG.homestars.urls) {
    try {
      const res = await axios.get(pageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          "Accept-Language": "en-CA,en;q=0.9"
        },
        timeout: 15000
      });
      const $ = cheerio.load(res.data);
      $("[class*='CompanyCard'], [class*='company-card'], [class*='listing']").each((_, el) => {
        const title   = $(el).find("h2, h3, [class*='company-name'], [class*='name']").first().text().trim();
        const desc    = $(el).find("[class*='description'], [class*='summary'], p").first().text().trim();
        const href    = $(el).find("a").first().attr("href") || "";
        const reviews = $(el).find("[class*='review'], [class*='rating']").first().text().trim();
        const fullText = `${title} ${desc} ${reviews}`;
        if (!title) return;
        const id = href || title;
        if (seen[`hs:${id}`]) return;
        const keywords = matchedKeywords(fullText, CONFIG.homestars.keywords);
        if (keywords.length === 0) return;
        if (hasNegativeKeyword(fullText)) return;
        seen[`hs:${id}`] = Date.now();
        newLeads.push({
          source: "HomeStars",
          title: title.slice(0,120),
          url: href.startsWith("http") ? href : `https://homestars.com${href}`,
          author: "see listing",
          keywords: keywords.slice(0,3).join(", ")
        });
      });
      await sleep(2000);
    } catch (err) {
      console.error(`[HomeStars] ${pageUrl}: ${err.message}`);
    }
  }
  return newLeads;
}

/* ------------------------------------------------------------------ */
/*  Craigslist                                                         */
/* ------------------------------------------------------------------ */
async function searchCraigslist(seen) {
  const newLeads = [];
  const allUrls = [...CONFIG.craigslist.urls, ...CONFIG.craigslist.searchUrls];
  for (const pageUrl of allUrls) {
    try {
      const res = await axios.get(pageUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
        timeout: 15000
      });
      const $ = cheerio.load(res.data);
      $("li.cl-static-search-result, .result-row").each((_, el) => {
        const title = $(el).find(".title, a").first().text().trim();
        const href  = $(el).find("a").first().attr("href") || "";
        const pid   = href.match(/(\d{10,})/)?.[1] || href;
        if (!title || seen[`cl:${pid}`]) return;
        const keywords = matchedKeywords(title, CONFIG.craigslist.keywords);
        if (keywords.length === 0) return;
        if (hasNegativeKeyword(title)) return;
        seen[`cl:${pid}`] = Date.now();
        newLeads.push({
          source: "Craigslist KW",
          title: title.slice(0,120),
          url: href.startsWith("http") ? href : `https://kitchener.craigslist.org${href}`,
          author: "see listing",
          keywords: keywords.slice(0,3).join(", ")
        });
      });
      await sleep(1500);
    } catch (err) {
      console.error(`[Craigslist] ${pageUrl}: ${err.message}`);
    }
  }
  return newLeads;
}

/* ------------------------------------------------------------------ */
/*  SMS Alerts                                                         */
/* ------------------------------------------------------------------ */
async function sendSms(newLeads) {
  const { accountSid, authToken, fromNumber, alertNumbers, minLeadsToAlert } = CONFIG.twilio;
  if (newLeads.length < minLeadsToAlert) return;
  if (!accountSid || !authToken || !fromNumber) { console.log("[SMS] Twilio env vars not set."); return; }
  const client = twilio(accountSid, authToken);
  let body = `DeVrye Lead Alert: ${newLeads.length} new lead${newLeads.length > 1 ? "s" : ""}\n\n`;
  for (const lead of newLeads) { body += lead.url + `\n`; }
  for (const to of alertNumbers) {
    try {
      const msg = await client.messages.create({ body, from: fromNumber, to });
      console.log(`[SMS] Sent to ${to} - ${msg.sid}`);
    } catch (err) { console.error(`[SMS] Failed: ${err.message}`); }
  }
}
async function main() {
  console.log("[DeVrye Lead Monitor] Starting...");
  const seen = loadSeen();
  const before = Object.keys(seen).length;

  const reddit     = await searchReddit(seen);
  const kijiji     = await searchKijiji(seen);
  const homestars  = await searchHomeStars(seen);
  const craigslist = await searchCraigslist(seen);
  const newLeads   = [...reddit, ...kijiji, ...homestars, ...craigslist];

  saveSeen(seen);
  console.log(`[Done] ${newLeads.length} new leads (${before} previously seen)`);
  console.log(`  Reddit: ${reddit.length} | Kijiji: ${kijiji.length} | HomeStars: ${homestars.length} | Craigslist: ${craigslist.length}`);
  newLeads.forEach((l) => console.log(`  [${l.source}] ${l.title} - ${l.url}`));
  await sendSms(newLeads);
}

main().catch(console.error);
