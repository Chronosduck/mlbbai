// scraper.js — Lightweight scraper using axios + cheerio (no Chrome/Puppeteer)
const axios   = require('axios');
const cheerio = require('cheerio');

const BASE    = 'https://mlbb.gg';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function fetchHTML(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

// ─── Hero List + Win/Ban/Pick Rates ──────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[SCRAPER] Fetching hero stats...');
  try {
    const html = await fetchHTML(`${BASE}/heroes`);
    const $    = cheerio.load(html);
    const heroes = [];

    // Try card layout
    $('[class*="hero-card"], [class*="HeroCard"], [class*="hero_card"]').each((i, el) => {
      const name = $(el).find('[class*="name"], h3, h2').first().text().trim();
      const role = $(el).find('[class*="role"], [class*="class"]').first().text().trim();
      const wr   = $(el).find('[class*="winrate"], [class*="win-rate"]').first().text().trim();
      const br   = $(el).find('[class*="banrate"], [class*="ban-rate"]').first().text().trim();
      const pr   = $(el).find('[class*="pickrate"], [class*="pick-rate"]').first().text().trim();
      const tier = $(el).find('[class*="tier"]').first().text().trim();
      const img  = $(el).find('img').first().attr('src') || '';
      if (name) heroes.push({ name, role, winRate: wr, banRate: br, pickRate: pr, tier, img });
    });

    // Fallback: table rows
    if (heroes.length === 0) {
      $('table tbody tr').each((i, el) => {
        const cells = $(el).find('td');
        const name  = cells.eq(0).text().trim() || cells.eq(1).text().trim();
        const role  = cells.eq(1).text().trim();
        const wr    = cells.eq(2).text().trim();
        const br    = cells.eq(3).text().trim();
        const pr    = cells.eq(4).text().trim();
        if (name && name.length > 1) heroes.push({ name, role, winRate: wr, banRate: br, pickRate: pr });
      });
    }

    // Fallback: JSON in script tags (many modern sites embed data as JSON)
    if (heroes.length === 0) {
      $('script').each((i, el) => {
        const src = $(el).html() || '';
        const match = src.match(/"heroes"\s*:\s*(\[.*?\])/s) ||
                      src.match(/window\.__NUXT__\s*=\s*(\{.*\})/s);
        if (match) {
          try {
            const raw = JSON.parse(match[1]);
            (Array.isArray(raw) ? raw : []).forEach(h => {
              if (h.name) heroes.push({
                name: h.name, role: h.role || h.type,
                winRate: h.win_rate || h.winRate,
                banRate: h.ban_rate || h.banRate,
                pickRate: h.pick_rate || h.pickRate,
                tier: h.tier, img: h.image || h.img
              });
            });
          } catch {}
        }
      });
    }

    console.log(`[SCRAPER] Found ${heroes.length} heroes`);
    return heroes;
  } catch (err) {
    console.error('[SCRAPER] Hero stats error:', err.message);
    return [];
  }
}

// ─── Single Hero Detail ───────────────────────────────────────────────────────
async function scrapeHeroDetail(slug) {
  console.log(`[SCRAPER] Hero detail: ${slug}`);
  try {
    const html = await fetchHTML(`${BASE}/heroes/${slug}`);
    const $    = cheerio.load(html);
    const stats = {}, build = [], skills = [], counters = [];

    $('[class*="stat-item"], [class*="attribute"]').each((i, el) => {
      const label = $(el).find('[class*="label"], [class*="name"]').text().trim().toLowerCase();
      const value = $(el).find('[class*="value"], [class*="val"]').text().trim();
      if (label) stats[label] = value;
    });

    $('[class*="build"] [class*="item"], [class*="recommended"] [class*="item"]').each((i, el) => {
      const name = $(el).find('[class*="name"]').text().trim() || $(el).attr('alt');
      if (name) build.push(name);
    });

    $('[class*="skill"], [class*="ability"]').each((i, el) => {
      const name = $(el).find('[class*="name"]').text().trim();
      const desc = $(el).find('[class*="desc"], p').first().text().trim();
      if (name) skills.push({ name, desc });
    });

    $('[class*="counter"] [class*="hero"]').each((i, el) => {
      const name = $(el).find('[class*="name"]').text().trim();
      if (name) counters.push(name);
    });

    return { stats, build, skills, counters };
  } catch (err) {
    console.error(`[SCRAPER] Detail error (${slug}):`, err.message);
    return {};
  }
}

// ─── Tier List ────────────────────────────────────────────────────────────────
async function scrapeTierList() {
  console.log('[SCRAPER] Fetching tier list...');
  try {
    const html = await fetchHTML(`${BASE}/tier-list`);
    const $    = cheerio.load(html);
    const tiers = {};

    $('[class*="tier-row"], [class*="TierRow"], [class*="tier-group"]').each((i, el) => {
      const label  = $(el).find('[class*="tier-label"], [class*="rank"]').first().text().trim();
      const heroes = [];
      $(el).find('[class*="hero"], [class*="champion"]').each((j, h) => {
        const name = $(h).find('[class*="name"]').text().trim() || $(h).attr('alt');
        if (name) heroes.push(name);
      });
      if (label && heroes.length) tiers[label] = heroes;
    });

    return tiers;
  } catch (err) {
    console.error('[SCRAPER] Tier list error:', err.message);
    return {};
  }
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
async function scrapeLeaderboard() {
  console.log('[SCRAPER] Fetching leaderboard...');
  try {
    const html    = await fetchHTML(`${BASE}/leaderboard`);
    const $       = cheerio.load(html);
    const players = [];

    $('table tbody tr, [class*="leaderboard"] [class*="row"]').each((i, el) => {
      const rank   = $(el).find('td:nth-child(1)').text().trim();
      const name   = $(el).find('td:nth-child(2), [class*="name"]').first().text().trim();
      const server = $(el).find('td:nth-child(3), [class*="server"]').first().text().trim();
      const points = $(el).find('td:nth-child(4), [class*="points"]').first().text().trim();
      const hero   = $(el).find('[class*="hero"]').first().text().trim();
      if (name) players.push({ rank, name, server, points, hero });
    });

    return players.slice(0, 100);
  } catch (err) {
    console.error('[SCRAPER] Leaderboard error:', err.message);
    return [];
  }
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
