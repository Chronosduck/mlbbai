// scraper.js — Fetches live data from mlbb.gg
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const BASE = 'https://mlbb.gg';

// Launch a shared browser instance
let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });
  }
  return browser;
}

async function fetchPage(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// ─── Hero List + Win/Ban/Pick Rates ───────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[SCRAPER] Fetching hero stats from mlbb.gg/heroes...');
  try {
    const html = await fetchPage(`${BASE}/heroes`);
    const $ = cheerio.load(html);
    const heroes = [];

    // mlbb.gg hero card selectors (adjust if site updates)
    $('[class*="hero-card"], [class*="HeroCard"], [class*="hero_card"]').each((i, el) => {
      const name = $(el).find('[class*="name"], h3, h2').first().text().trim();
      const role = $(el).find('[class*="role"], [class*="class"]').first().text().trim();
      const wr   = $(el).find('[class*="winrate"], [class*="win-rate"]').first().text().trim();
      const br   = $(el).find('[class*="banrate"], [class*="ban-rate"]').first().text().trim();
      const pr   = $(el).find('[class*="pickrate"], [class*="pick-rate"]').first().text().trim();
      const tier = $(el).find('[class*="tier"]').first().text().trim();
      const img  = $(el).find('img').first().attr('src') || '';
      const href = $(el).find('a').first().attr('href') || '';

      if (name) {
        heroes.push({ name, role, winRate: wr, banRate: br, pickRate: pr, tier, img, href });
      }
    });

    // Fallback: scrape table rows if card layout not found
    if (heroes.length === 0) {
      $('table tbody tr, [class*="table"] [class*="row"]').each((i, el) => {
        const cells = $(el).find('td, [class*="cell"]');
        const name = cells.eq(0).text().trim() || cells.eq(1).text().trim();
        const role = cells.eq(1).text().trim();
        const wr   = cells.eq(2).text().trim();
        const br   = cells.eq(3).text().trim();
        const pr   = cells.eq(4).text().trim();
        if (name && name.length > 1) {
          heroes.push({ name, role, winRate: wr, banRate: br, pickRate: pr });
        }
      });
    }

    console.log(`[SCRAPER] Found ${heroes.length} heroes`);
    return heroes;
  } catch (err) {
    console.error('[SCRAPER] Error scraping hero stats:', err.message);
    return [];
  }
}

// ─── Single Hero Detail Page ──────────────────────────────────────────────────
async function scrapeHeroDetail(heroSlug) {
  console.log(`[SCRAPER] Fetching hero detail: ${heroSlug}`);
  try {
    const html = await fetchPage(`${BASE}/heroes/${heroSlug}`);
    const $ = cheerio.load(html);

    // Stats
    const stats = {};
    $('[class*="stat-item"], [class*="StatItem"], [class*="attribute"]').each((i, el) => {
      const label = $(el).find('[class*="label"], [class*="name"]').text().trim().toLowerCase();
      const value = $(el).find('[class*="value"], [class*="val"]').text().trim();
      if (label) stats[label] = value;
    });

    // Recommended Build
    const build = [];
    $('[class*="build"] [class*="item"], [class*="recommended"] img').each((i, el) => {
      const itemName = $(el).attr('alt') || $(el).closest('[class*="item"]').find('[class*="name"]').text().trim();
      if (itemName) build.push(itemName);
    });

    // Skills
    const skills = [];
    $('[class*="skill"], [class*="ability"]').each((i, el) => {
      const skillName = $(el).find('[class*="name"]').text().trim();
      const skillDesc = $(el).find('[class*="desc"], p').first().text().trim();
      if (skillName) skills.push({ name: skillName, desc: skillDesc });
    });

    // Counters
    const counters = [];
    $('[class*="counter"] [class*="hero"], [class*="weak-against"]').each((i, el) => {
      const name = $(el).find('[class*="name"]').text().trim() || $(el).attr('alt');
      if (name) counters.push(name);
    });

    return { stats, build, skills, counters };
  } catch (err) {
    console.error(`[SCRAPER] Error fetching ${heroSlug}:`, err.message);
    return {};
  }
}

// ─── Tier List ────────────────────────────────────────────────────────────────
async function scrapeTierList() {
  console.log('[SCRAPER] Fetching tier list...');
  try {
    const html = await fetchPage(`${BASE}/tier-list`);
    const $ = cheerio.load(html);
    const tiers = {};

    $('[class*="tier-row"], [class*="TierRow"], [class*="tier-group"]').each((i, el) => {
      const tierLabel = $(el).find('[class*="tier-label"], [class*="rank"]').first().text().trim();
      const heroes = [];
      $(el).find('[class*="hero"], [class*="champion"]').each((j, h) => {
        const name = $(h).find('[class*="name"]').text().trim() || $(h).attr('alt');
        if (name) heroes.push(name);
      });
      if (tierLabel && heroes.length > 0) {
        tiers[tierLabel] = heroes;
      }
    });

    return tiers;
  } catch (err) {
    console.error('[SCRAPER] Error scraping tier list:', err.message);
    return {};
  }
}

// ─── Leaderboard / Top Players ────────────────────────────────────────────────
async function scrapeLeaderboard() {
  console.log('[SCRAPER] Fetching leaderboard...');
  try {
    const html = await fetchPage(`${BASE}/leaderboard`);
    const $ = cheerio.load(html);
    const players = [];

    $('table tbody tr, [class*="leaderboard"] [class*="row"]').each((i, el) => {
      const rank    = $(el).find('td:nth-child(1), [class*="rank"]').first().text().trim();
      const name    = $(el).find('td:nth-child(2), [class*="name"], [class*="player"]').first().text().trim();
      const server  = $(el).find('td:nth-child(3), [class*="server"]').first().text().trim();
      const points  = $(el).find('td:nth-child(4), [class*="points"], [class*="rating"]').first().text().trim();
      const hero    = $(el).find('[class*="hero"]').first().text().trim();
      if (name) players.push({ rank, name, server, points, hero });
    });

    return players.slice(0, 100); // top 100
  } catch (err) {
    console.error('[SCRAPER] Error scraping leaderboard:', err.message);
    return [];
  }
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
