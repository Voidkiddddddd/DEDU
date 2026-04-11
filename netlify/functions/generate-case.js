const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  const genres = ['Noir de los años 40', 'Misterio victoriano', 'Thriller psicológico moderno', 'Horror gótico', 'Crimen de alta sociedad'];
  const genre = genres[Math.floor(Math.random() * genres.length)];

  const prompt = `Eres el narrador de un juego de misterio interactivo en español. Genera un caso de asesinato completo y original en el género: "${genre}".

Responde ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "title": "Título evocador del caso (máx 8 palabras)",
  "tagline": "Frase de gancho, tono oscuro (máx 20 palabras)",
  "genre": "${genre}",
  "description": "Descripción del crimen, 3-4 oraciones. Incluye víctima, lugar y circunstancias misteriosas.",
  "culprit": "Nombre exacto del culpable (debe ser uno de los sospechosos)",
  "culprit_motive": "El motivo real del culpable, detallado",
  "culprit_method": "Cómo cometió el crimen exactamente",
  "clues": [
    {"title": "Nombre de la pista", "description": "Descripción detallada, 1-2 oraciones", "isNew": true},
    {"title": "Nombre de la pista", "description": "Descripción detallada", "isNew": false},
    {"title": "Nombre de la pista", "description": "Descripción detallada", "isNew": true},
    {"title": "Nombre de la pista", "description": "Descripción detallada", "isNew": false}
  ],
  "suspects": [
    {
      "name": "Nombre completo",
      "role": "Relación con la víctima o ocupación",
      "emoji": "👤",
      "description": "Descripción breve, algo sospechoso sobre esta persona",
      "personality": "Cómo habla y se comporta durante interrogatorios",
      "secret": "Su secreto (que puede o no estar relacionado con el crimen)",
      "alibi": "Su coartada, verdadera o falsa",
      "isGuilty": false
    }
  ]
}

REGLAS:
- 4 sospechosos exactamente
- Solo uno es culpable (isGuilty: true), coincide con el campo "culprit"
- Los sospechosos inocentes tienen secretos que los hacen parecer sospechosos
- Las pistas deben ser ambiguas pero coherentes con la solución
- Usa nombres y lugares acordes al género
- El emoji de cada sospechoso debe reflejar su personalidad
- Responde SOLO con el JSON, sin texto adicional ni bloques de código`;

  try {
    // Call Gemini
    const geminiResponse = await callGemini(GEMINI_KEY, prompt);
    let caseData;
    try {
      const clean = geminiResponse.replace(/```json|```/g, '').trim();
      caseData = JSON.parse(clean);
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Invalid JSON from Gemini', raw: geminiResponse }) };
    }

    // Save to Supabase
    const caseRecord = {
      case_data: caseData,
      status: 'open',
      current_turn: 'vini',
      actions_vini: 0,
      actions_lucy: 0,
      interrogation_logs: {},
      accusation_vini: null,
      accusation_lucy: null,
      resolution: null
    };

    const saved = await sbInsert(SB_URL, SB_KEY, 'mystery_cases', caseRecord);
    if (!saved) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save case' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case: saved })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

async function callGemini(apiKey, prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.candidates[0].content.parts[0].text);
        } catch (e) { reject(new Error('Gemini parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sbInsert(url, key, table, data) {
  const fetch = require('node-fetch');
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key, 'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  if (r.ok) return (await r.json())[0];
  return null;
}
