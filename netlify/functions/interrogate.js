const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  const { caseId, suspectName, question, detective } = JSON.parse(event.body || '{}');
  if (!caseId || !suspectName || !question) return { statusCode: 400, body: 'Missing fields' };

  // Get case from Supabase
  const caseData = await sbGet(SB_URL, SB_KEY, 'mystery_cases', `id=eq.${caseId}`);
  if (!caseData || !caseData.length) return { statusCode: 404, body: 'Case not found' };

  const cas = caseData[0];
  const data = cas.case_data;
  const suspect = data.suspects.find(s => s.name === suspectName);
  if (!suspect) return { statusCode: 404, body: 'Suspect not found' };

  // Get existing log for this suspect
  const logs = cas.interrogation_logs || {};
  const suspectLog = logs[suspectName] || [];

  // Build conversation history for Gemini
  const history = suspectLog.map(m => ({
    role: m.role === 'detective' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  const systemPrompt = `Eres ${suspect.name}, ${suspect.role}. 
Personalidad: ${suspect.personality}
Tu secreto: ${suspect.secret}
Tu coartada: ${suspect.alibi}
${suspect.isGuilty ? `ERES EL CULPABLE. Estás nervioso pero intentas ocultarlo. Mientes sobre algunos detalles pero nunca confiesas directamente.` : `Eres inocente del crimen pero tienes tu secreto que proteges. Puedes mentir o evadir sobre tu secreto pero no sobre el crimen.`}

Contexto del crimen: ${data.description}

REGLAS DE INTERPRETACIÓN:
- Responde siempre en primera persona como ${suspect.name}
- Máximo 3 oraciones por respuesta
- Mantén coherencia con respuestas anteriores
- Puedes ser evasivo, nervioso, irritado, o demasiado cooperativo según tu personalidad
- NUNCA rompas el personaje ni menciones que eres una IA
- Habla de forma natural, no formal`;

  const prompt = `${systemPrompt}\n\nEl Detective ${detective === 'vini' ? 'Vini' : 'Lucy'} te pregunta: "${question}"`;

  try {
    const answer = await callGemini(GEMINI_KEY, prompt, history);

    // Update log
    const newLog = [
      ...suspectLog,
      { role: 'detective', content: question, sender: `Det. ${detective === 'vini' ? 'Vini' : 'Lucy'}` },
      { role: 'suspect', content: answer, sender: suspectName }
    ];
    const newLogs = { ...logs, [suspectName]: newLog };

    // Update actions count and logs
    const actField = detective === 'vini' ? 'actions_vini' : 'actions_lucy';
    const currentActions = cas[actField] || 0;
    const maxActions = 10;
    const newActions = currentActions + 1;

    const updateData = {
      interrogation_logs: newLogs,
      [actField]: newActions
    };

    // Auto pass turn if actions exhausted
    if (newActions >= maxActions) {
      updateData.current_turn = detective === 'vini' ? 'lucy' : 'vini';
      updateData[actField] = 0;
    }

    await sbUpdate(SB_URL, SB_KEY, 'mystery_cases', updateData, `id=eq.${caseId}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, actionsLeft: maxActions - newActions })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

async function callGemini(apiKey, prompt, history = []) {
  const fetch = require('node-fetch');
  const body = JSON.stringify({
    contents: [
      ...history,
      { role: 'user', parts: [{ text: prompt }] }
    ],
    generationConfig: { temperature: 0.85, maxOutputTokens: 256 }
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
  );
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

async function sbGet(url, key, table, filter) {
  const fetch = require('node-fetch');
  const r = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
  });
  return r.json();
}

async function sbUpdate(url, key, table, data, filter) {
  const fetch = require('node-fetch');
  const r = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
  return r.ok;
}
