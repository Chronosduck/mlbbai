// ai.js — Claude-powered hero analysis & synergy reports
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Retry wrapper ────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ─── Safe JSON parse — strips markdown fences if model adds them ──────────────
function safeParseJSON(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// ─── Single Hero Deep Analysis ────────────────────────────────────────────────
async function analyzeHero(hero) {
  const prompt = `You are an elite Mobile Legends: Bang Bang analyst with deep knowledge of the current meta.

Hero Data:
- Name: ${hero.name}
- Role: ${hero.role || 'Unknown'}
- Win Rate: ${hero.winRate || 'N/A'}
- Ban Rate: ${hero.banRate || 'N/A'}
- Pick Rate: ${hero.pickRate || 'N/A'}
- Tier: ${hero.tier || 'N/A'}
${hero.stats ? `- Ability Scores: Durability ${hero.stats.durability}, Offense ${hero.stats.offense}, Control ${hero.stats.control}, Mobility ${hero.stats.mobility}, Support ${hero.stats.support}` : ''}
${hero.build?.length ? `- Recommended Build: ${hero.build.join(', ')}` : ''}

Provide a comprehensive analysis. Return ONLY valid JSON, no markdown, no extra text:
{
  "overview": "2-3 sentences on this hero's identity and current meta role",
  "playstyle": "How to play effectively — key mechanics, skill order, and combos",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "weaknesses": ["weakness 1", "weakness 2", "weakness 3"],
  "earlyGame": "Early game strategy and laning priorities",
  "lateGame": "Late game impact and win conditions",
  "tips": ["actionable pro tip 1", "actionable pro tip 2", "actionable pro tip 3"],
  "metaRating": "One sentence verdict on their current meta standing",
  "difficulty": "Easy | Medium | Hard | Expert"
}`;

  try {
    return await withRetry(async () => {
      const msg = await client.messages.create({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages:   [{ role: 'user', content: prompt }]
      });
      return safeParseJSON(msg.content[0].text);
    });
  } catch (err) {
    console.error('[AI] analyzeHero error:', err.message);
    return {
      overview:    `${hero.name} is a ${hero.role || 'versatile'} hero in the current meta.`,
      playstyle:   'Focus on objectives and team coordination.',
      strengths:   ['Strong kit', 'Good scaling', 'Team utility'],
      weaknesses:  ['Situational', 'Requires practice', 'Item dependent'],
      earlyGame:   'Farm efficiently and secure early objectives.',
      lateGame:    'Capitalize on power spikes and teamfights.',
      tips:        ['Master your skill combos', 'Communicate with team', 'Watch the minimap'],
      metaRating:  'Solid pick in the current meta.',
      difficulty:  'Medium'
    };
  }
}

// ─── Two-Hero Synergy Report ──────────────────────────────────────────────────
async function analyzeSynergy(hero1, hero2) {
  const prompt = `You are an expert Mobile Legends: Bang Bang strategist.

Analyze the team synergy between:
Hero 1: ${hero1.name} (${hero1.role || 'Unknown'}) — Win Rate: ${hero1.winRate || 'N/A'}, Tier: ${hero1.tier || 'N/A'}
Hero 2: ${hero2.name} (${hero2.role || 'Unknown'}) — Win Rate: ${hero2.winRate || 'N/A'}, Tier: ${hero2.tier || 'N/A'}

Return ONLY valid JSON, no markdown, no extra text:
{
  "synergyScore": 78,
  "verdict": "One sentence verdict on this combo's viability",
  "comboPotential": "Specific ability interaction or combo sequence between these two heroes",
  "laneRecommendation": "Best lane/role assignments for this duo",
  "strengths": ["combined strength 1", "combined strength 2"],
  "weaknesses": ["combined weakness 1", "combined weakness 2"],
  "counterStrategy": "How opponents should play against this duo",
  "tip": "One key tip to maximize this combo's effectiveness"
}

synergyScore: 0-100 integer. Be specific to these heroes, not generic.`;

  try {
    return await withRetry(async () => {
      const msg = await client.messages.create({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages:   [{ role: 'user', content: prompt }]
      });
      return safeParseJSON(msg.content[0].text);
    });
  } catch (err) {
    console.error('[AI] analyzeSynergy error:', err.message);
    return {
      synergyScore:       65,
      verdict:            `${hero1.name} and ${hero2.name} can work well together with coordination.`,
      comboPotential:     'Combine abilities for maximum effect in team fights.',
      laneRecommendation: 'Flexible lane assignments based on enemy picks.',
      strengths:          ['Complementary kits', 'Good team fight presence'],
      weaknesses:         ['Requires coordination', 'Can be countered by CC'],
      counterStrategy:    'Split push to avoid their team fight strength.',
      tip:                'Communicate cooldowns before engaging.'
    };
  }
}

module.exports = { analyzeHero, analyzeSynergy };
