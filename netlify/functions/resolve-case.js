exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  const { caseId } = JSON.parse(event.body || '{}');
  if (!caseId) return { statusCode: 400, body: 'Missing caseId' };

  const fetch = require('node-fetch');
  const headers = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` };

  const r = await fetch(`${SB_URL}/rest/v1/mystery_cases?id=eq.${caseId}`, { headers });
  const cases = await r.json();
  if (!cases || !cases.length) return { statusCode: 404, body: 'Case not found' };

  const cas = cases[0];
  const data = cas.case_data;
  const culprit = data.suspects.find(s => s.isGuilty);

  const resolution = {
    culprit: culprit ? culprit.name : 'Desconocido',
    explanation: `${culprit?.name} cometió el crimen. ${data.culprit_motive} ${data.culprit_method}`,
    vini_correct: cas.accusation_vini === culprit?.name,
    lucy_correct: cas.accusation_lucy === culprit?.name
  };

  await fetch(`${SB_URL}/rest/v1/mystery_cases?id=eq.${caseId}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status: 'solved', resolution })
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution })
  };
};
