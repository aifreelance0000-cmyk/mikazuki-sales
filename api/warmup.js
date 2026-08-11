// GAS ウォームアップエンドポイント
// cron-job.org などの外部cronから5分ごとに呼び出す

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxJ3FJcnCyKn7oL7JcSfBQG1g9C9BZ3Zy7Fo2mMRFCBJqijS7kUL7d-O6fdfVMOzzSA/exec';

module.exports = async function handler(req, res) {
  const start = Date.now();
  try {
    const r = await fetch(`${APPS_SCRIPT_URL}?action=ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(20000),
    });
    const elapsed = Date.now() - start;
    const text = await r.text();
    console.log(`warmup ok: ${elapsed}ms`, text.slice(0, 100));
    res.status(200).json({ ok: true, elapsed });
  } catch (e) {
    const elapsed = Date.now() - start;
    console.error(`warmup error: ${elapsed}ms`, e.message);
    res.status(200).json({ ok: false, error: e.message, elapsed });
  }
};
