// Vercel Serverless Function — Apps Script プロキシ（売上管理）
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxQRESnVJ9NW_VTCs07g9iK7lsIURJBD4nIdA_4yQi8_5sS2dSEVi0vzOkCEaJcz_U/exec';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {}
  }

  try {
    const step1 = await fetch(APPS_SCRIPT_URL, {
      method:   'POST',
      headers:  { 'Content-Type': 'text/plain' },
      body:     JSON.stringify(body),
      redirect: 'manual'
    });

    let text;
    if (step1.status === 302 || step1.status === 301) {
      const location = step1.headers.get('location');
      if (!location) throw new Error('No redirect location');
      const step2 = await fetch(location, { method: 'GET' });
      text = await step2.text();
    } else {
      text = await step1.text();
    }

    return res.json(JSON.parse(text));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.toString() });
  }
};
