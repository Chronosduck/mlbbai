// ai.js — Claude-powered hero analysis & synergy reports
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
${hero.stats ? `- Stats: ${JSON.stringify(hero.stats)}` : ''}
${hero.build ? `- Recommended Build: ${hero.build.join(', ')}` : ''}

Write a comprehensive analysis in this exact JSON format:
{
  "overview": "2-3 sentence overview of this hero's identity and role in the meta",
  "playstyle": "How to play this hero effectively - key mechanics and combos",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "weaknesses": ["weakness 1", "weakness 2", "weakness 3"],
  "earlyGame": "Early game strategy and priorities",
  "lateGame": "Late game impact and win conditions",
  "tips": ["pro tip 1", "pro tip 2", "pro tip 3"],
  "metaRating": "A short verdict on their current meta standing",
  "difficulty": "Easy / Medium / Hard / Expert"
}

Respond ONLY with valid JSON, no markdown, no extra text.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0].text.trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('[AI] analyzeHero error:', err.message);
    return {
      overview: `${hero.name} is a ${hero.role || 'versatile'} hero in the current meta.`,
      playstyle: 'Focus on objectives and team coordination.',
      strengths: ['Strong kit', 'Good scaling', 'Team utility'],
      weaknesses: ['Situational', 'Requires practice'],
      earlyGame: 'Farm efficiently and secure early objectives.',
      lateGame: 'Capitalize on power spikes and team fights.',
      tips: ['Master your skill combos', 'Communicate with team', 'Watch the minimap'],
      metaRating: 'Solid pick in the current meta.',
      difficulty: 'Medium'
    };
  }
}

// ─── Two-Hero Synergy Report ──────────────────────────────────────────────────
async function analyzeSynergy(hero1, hero2) {
  const prompt = `You are an expert Mobile Legends: Bang Bang strategist.

Analyze the team synergy between:
Hero 1: ${hero1.name} (${hero1.role || 'Unknown role'}) - Win Rate: ${hero1.winRate || 'N/A'}
Hero 2: ${hero2.name} (${hero2.role || 'Unknown role'}) - Win Rate: ${hero2.winRate || 'N/A'}

Return ONLY valid JSON in this format:
{
  "synergyScore": 78,
  "verdict": "One sentence verdict on their combo",
  "comboPotential": "Specific combo or interaction between these two heroes",
  "laneRecommendation": "Which lane/role combination works best",
  "strengths": ["combined strength 1", "combined strength 2"],
  "weaknesses": ["combined weakness 1", "combined weakness 2"],
  "counterStrategy": "How to play against this duo",
  "tip": "One key tip for playing this combo"
}

synergyScore should be a number 0-100. No markdown, no extra text.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0].text.trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('[AI] analyzeSynergy error:', err.message);
    return {
      synergyScore: 65,
      verdict: `${hero1.name} and ${hero2.name} can work well together with coordination.`,
      comboPotential: 'Combine abilities for maximum effect in team fights.',
      laneRecommendation: 'Flexible lane assignments based on enemy picks.',
      strengths: ['Complementary kits', 'Good team fight presence'],
      weaknesses: ['Requires coordination', 'Can be countered'],
      counterStrategy: 'Split push to avoid their team fight strength.',
      tip: 'Communicate cooldowns before engaging.'
    };
  }
}

module.exports = { analyzeHero, analyzeSynergy };
