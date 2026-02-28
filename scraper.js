// scraper.js — Powered by mlbb-stats.ridwaanhall.com (data from Moonton's official MLBB servers)
// Docs: https://mlbb-stats-docs.ridwaanhall.com/
const axios = require('axios');

const BASE = 'https://mlbb-stats.ridwaanhall.com/api';
const HEADERS = { 'User-Agent': 'mlbbai-app/1.0' };

async function get(path) {
  const res = await axios.get(`${BASE}${path}`, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

function tierFromWinRate(wr) {
  if (wr == null) return 'Unranked';
  const pct = wr * 100;
  if (pct >= 56) return 'S+';
  if (pct >= 53) return 'S';
  if (pct >= 51) return 'A';
  if (pct >= 49) return 'B';
  return 'C';
}

// ─── Parse a single row from /hero-rank/ ─────────────────────────────────────
// Shape: { data: { main_hero: { data: { head, name } },
//                  main_hero_win_rate, main_hero_ban_rate,
//                  main_hero_appearance_rate, main_heroid } }
function parseHeroRow(row) {
  try {
    const d        = row.data || row;
    const heroData = d.main_hero?.data || {};
    const name     = heroData.name || heroData.hero_name;
    if (!name) return null;

    const winRate  = d.main_hero_win_rate;
    const banRate  = d.main_hero_ban_rate;
    const pickRate = d.main_hero_appearance_rate;

    return {
      name,
      role:     heroData.role || heroData.type || heroData.hero_type || '—',
      winRate:  winRate  != null ? `${(winRate  * 100).toFixed(1)}%` : '—',
      banRate:  banRate  != null ? `${(banRate  * 100).toFixed(1)}%` : '—',
      pickRate: pickRate != null ? `${(pickRate * 100).toFixed(1)}%` : '—',
      tier:     tierFromWinRate(winRate),
      img:      heroData.head || heroData.image || heroData.icon || '',
      heroId:   d.main_heroid || heroData.id || null,
      // Keep raw values for leaderboard sorting
      _winRate:  winRate  || 0,
      _banRate:  banRate  || 0,
      _pickRate: pickRate || 0,
    };
  } catch {
    return null;
  }
}

// ─── Fetch ALL heroes by paginating through /hero-rank/ ───────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching all heroes...');
  const allHeroes = [];
  const seenIds   = new Set();

  try {
    // Max page_size is 126 — fetch all in 2 passes
    for (let pageIndex = 1; pageIndex <= 2; pageIndex++) {
      const raw  = await get(`/hero-rank/?page_size=126&page_index=${pageIndex}`);
      const data = raw?.data || {};
      const rows = data.records || data.results || data.data || [];

      if (!Array.isArray(rows) || rows.length === 0) break;

      const total = data.total_count || data.count || data.total || null;
      let added = 0;

      for (const row of rows) {
        const hero = parseHeroRow(row);
        if (!hero) continue;
        const key = hero.heroId || hero.name;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        allHeroes.push(hero);
        added++;
      }

      console.log(`[API] Page ${pageIndex}: +${added} heroes (total: ${allHeroes.length}${total ? '/' + total : ''})`);
      if (total && allHeroes.length >= total) break;
    }
  } catch (err) {
    console.error('[API] Hero list error:', err.message);
  }

  console.log(`[API] Total heroes fetched: ${allHeroes.length}`);
  return allHeroes;
}

// ─── Single Hero Detail ───────────────────────────────────────────────────────
async function scrapeHeroDetail(heroIdOrSlug, allHeroes = []) {
  let heroId = heroIdOrSlug;
  if (isNaN(heroIdOrSlug)) {
    const match = allHeroes.find(
      h => h.name?.toLowerCase() === String(heroIdOrSlug).toLowerCase()
    );
    heroId = match?.heroId || null;
  }

  if (!heroId) {
    console.warn(`[API] No heroId found for: ${heroIdOrSlug}`);
    return {};
  }

  console.log(`[API] Fetching detail for heroId: ${heroId}`);
  try {
    const [detail, counters, compatibility] = await Promise.allSettled([
      get(`/hero-detail/${heroId}/`),
      get(`/hero-counter/${heroId}/`),
      get(`/hero-compatibility/${heroId}/`),
    ]);

    const d    = detail.value?.data        || detail.value        || {};
    const c    = counters.value?.data      || counters.value      || {};
    const comp = compatibility.value?.data || compatibility.value || {};
    const dInner = d.data || d;

    // Recursively find arrays for counters/teammates
    function findArr(obj, depth = 0) {
      if (depth > 4) return null;
      if (Array.isArray(obj) && obj.length) return obj;
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) {
          const f = findArr(v, depth + 1);
          if (f) return f;
        }
      }
      return null;
    }

    const counterArr  = findArr(c)    || [];
    const teammateArr = findArr(comp) || [];

    let build = [];
    try {
      const guide  = await get(`/academy/guide/${heroId}/builds/`);
      const builds = findArr(guide) || [];
      if (builds.length) {
        build = (builds[0].items || builds[0].equipment || [])
          .map(i => i.name || i.item_name).filter(Boolean);
      }
    } catch {}

    return {
      name:        dInner.name || String(heroId),
      role:        dInner.role || dInner.type || dInner.hero_type,
      description: dInner.story || dInner.lore || dInner.description || '',
      img:         dInner.head_image || dInner.image || dInner.head || dInner.avatar || '',
      stats: {
        durability: dInner.durability || 0,
        offense:    dInner.offense    || 0,
        control:    dInner.control    || 0,
        mobility:   dInner.mobility   || 0,
        support:    dInner.support    || 0,
      },
      build,
      counters:  counterArr.map(h  => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
      teammates: teammateArr.map(h => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
    };
  } catch (err) {
    console.error(`[API] Detail error (${heroId}):`, err.message);
    return {};
  }
}

// ─── Tier List ────────────────────────────────────────────────────────────────
async function scrapeTierList() {
  // Reuse hero stats to avoid duplicate API calls — called separately by server.js
  // but we'll do a fresh fetch here for simplicity
  console.log('[API] Fetching tier list...');
  try {
    const heroes = await scrapeHeroStats();
    const tiers  = {};

    heroes.forEach(hero => {
      if (!tiers[hero.tier]) tiers[hero.tier] = [];
      tiers[hero.tier].push(hero.name);
    });

    const order  = ['S+', 'S', 'A', 'B', 'C', 'Unranked'];
    const sorted = {};
    order.forEach(t => { if (tiers[t]) sorted[t] = tiers[t]; });
    Object.keys(tiers).forEach(t => { if (!sorted[t]) sorted[t] = tiers[t]; });

    console.log(`[API] Tier groups: ${Object.keys(sorted).length}`);
    return sorted;
  } catch (err) {
    console.error('[API] Tier list error:', err.message);
    return {};
  }
}

// ─── Leaderboard — Top heroes by win rate, ban rate, pick rate ────────────────
// /mplid/player-stats/ returns empty []. We build a meaningful leaderboard
// from the hero stats instead: top performers across all three metrics.
async function scrapeLeaderboard() {
  console.log('[API] Building leaderboard from hero stats...');
  try {
    const heroes = await scrapeHeroStats();
    if (!heroes.length) return [];

    // Top 10 by win rate
    const byWin = [...heroes]
      .sort((a, b) => b._winRate - a._winRate)
      .slice(0, 10)
      .map((h, i) => ({
        rank:     i + 1,
        name:     h.name,
        category: 'Top Win Rate',
        server:   h.role || '—',
        points:   h.winRate,
        hero:     h.name,
        img:      h.img,
      }));

    // Top 10 by ban rate
    const byBan = [...heroes]
      .sort((a, b) => b._banRate - a._banRate)
      .slice(0, 10)
      .map((h, i) => ({
        rank:     i + 1,
        name:     h.name,
        category: 'Most Banned',
        server:   h.role || '—',
        points:   h.banRate,
        hero:     h.name,
        img:      h.img,
      }));

    // Top 10 by pick rate
    const byPick = [...heroes]
      .sort((a, b) => b._pickRate - a._pickRate)
      .slice(0, 10)
      .map((h, i) => ({
        rank:     i + 1,
        name:     h.name,
        category: 'Most Picked',
        server:   h.role || '—',
        points:   h.pickRate,
        hero:     h.name,
        img:      h.img,
      }));

    const leaderboard = [...byWin, ...byBan, ...byPick];
    console.log(`[API] Leaderboard entries: ${leaderboard.length}`);
    return leaderboard;
  } catch (err) {
    console.error('[API] Leaderboard error:', err.message);
    return [];
  }
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
