// Vercel Serverless Function — 売上管理 LINE Webhook

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz11I4zO4G9jbIX9JGJ18LxIr6Q-Kg5FbPwgnlQ2FeZ-2036PGRib_X82yLGQ1snJqo/exec';

// body を確実に JSON オブジェクトとして取得
async function readBody(req) {
  try {
    const b = req.body;
    if (b !== undefined && b !== null) {
      if (Buffer.isBuffer(b))      return JSON.parse(b.toString('utf8'));
      if (typeof b === 'object')   return b;
      if (typeof b === 'string' && b) return JSON.parse(b);
    }
    return await new Promise((resolve, reject) => {
      let d = '';
      req.on('data',  c => { d += c.toString('utf8'); });
      req.on('end',   () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      req.on('error', reject);
    });
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ status: 'ok' });

  const body = await readBody(req);
  if (!body || !body.events || body.events.length === 0) return res.status(200).end();

  const token = process.env.SALES_LINE_ACCESS_TOKEN || '';

  try {
    for (const event of body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text       = event.message.text.trim();
      const replyToken = event.replyToken;

      try {
        const msgId = event.message.id; // LINE メッセージID（重複防止用）

        if (/[■◾]/.test(text) && /紹介者/.test(text)) {
          // 商材売上登録
          const entries = parseSalesMessage(text, false);
          if (!entries.length) {
            await lineReply(token, replyToken, '⚠️ パースできませんでした。\n■紹介者：〇〇 の形式で送信してください。');
            continue;
          }
          let saved = 0;
          const lines = [];
          for (const entry of entries) {
            await callAppsScript({ action: 'addShokaiSale', ...entry, _msgId: msgId });
            saved++;
            lines.push(`✅ ${entry.登録者名}  ${yen(entry.金額)}`);
          }
          await lineReply(token, replyToken, `✅ 売上を ${saved} 件登録しました\n\n` + lines.join('\n'));

        } else if (/クーリングオフ/.test(text)) {
          // クーリングオフ登録
          const entries = parseSalesMessage(text, true);
          if (!entries.length) {
            await lineReply(token, replyToken, '⚠️ パースできませんでした。');
            continue;
          }
          let saved = 0;
          const lines = [];
          for (const entry of entries) {
            await callAppsScript({ action: 'addShokaiSale', ...entry });
            saved++;
            lines.push(`🔴 ${entry.登録者名}  ${yen(entry.金額)}`);
          }
          await lineReply(token, replyToken, `⚠️ COを ${saved} 件登録しました\n\n` + lines.join('\n'));

        } else {
          await lineReply(token, replyToken, '売上登録は ■紹介者：〇〇 から始まる形式で送信してください。');
        }
      } catch (err) {
        console.error('event process error:', err);
        await lineReply(token, replyToken, '❌ エラーが発生しました: ' + err.message);
      }
    }
  } catch (err) {
    console.error('handler error:', err);
  }

  return res.status(200).end();
};

// ─── パーサー ────────────────────────────────────────────────

function parseSalesMessage(text, isCO) {
  const type = isCO ? 'クーリングオフ' : '通常';
  const lineArr = text.split('\n');
  const parts = [];
  let buf = [], started = false;

  for (const line of lineArr) {
    if (/[■◾]/.test(line) && /紹介者/.test(line)) {
      if (started && buf.length) parts.push(buf.join('\n'));
      buf = [line]; started = true;
    } else if (started) {
      buf.push(line);
    }
  }
  if (buf.length) parts.push(buf.join('\n'));
  if (!parts.length) parts.push(text); // フォールバック

  return parts.map(p => parseEntry(p, type)).filter(e => e && e.登録者名);
}

function parseEntry(text, type) {
  let 紹介者 = '', 登録者名 = '', 登録者ふりがな = '';
  let 金額 = 0, 入金日 = '', rawDecision = '';
  let クレカ金額 = 0, 振込金額 = 0;
  const methods = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const ci = line.search(/[：:]/);
    if (ci === -1) continue;
    const key = line.slice(0, ci).replace(/^[■◾️◾・\s]+/, '').trim();
    const val = line.slice(ci + 1).trim();
    if (!val) continue;

    if      (/紹介者/.test(key))                      紹介者 = val.replace(/さん$/, '').trim();
    else if (/登録者名|氏名|フルネーム/.test(key)) {
      const m = val.match(/^(.+?)[（(](.+?)[）)]/);
      if (m) { 登録者名 = m[1].trim(); 登録者ふりがな = m[2].trim(); }
      else     登録者名 = val.trim();
    }
    else if (/ふりがな|フリガナ/.test(key))           登録者ふりがな = val.trim();
    else if (/金額/.test(key))                        金額 = parseAmt(val);
    else if (/入金日/.test(key))                      入金日 = parseDt(val);
    else if (/決済/.test(key)) {
      rawDecision = val.trim();
      const p = parsePayment(val);
      if (p.method) { methods.push(p.method); if (p.isCredit) クレカ金額 += p.amount; else 振込金額 += p.amount; }
    }
  }

  // 内訳なしの場合、決済方法から自動セット
  if (金額 > 0 && クレカ金額 === 0 && 振込金額 === 0) {
    const isC = /クレカ|クレジット|カード/.test(rawDecision);
    const isB = /振込|銀行/.test(rawDecision);
    if (isC) { クレカ金額 = 金額; if (!methods.length) methods.push('クレジットカード'); }
    if (isB) { 振込金額  = 金額; if (!methods.length) methods.push('銀行振込'); }
  }

  const 決済方法 = methods.length ? [...new Set(methods)].join('・') : rawDecision;
  return { 紹介者, 登録者名, 登録者ふりがな, 金額, 入金日, 決済方法, クレカ金額, 振込金額, タイプ: type };
}

function parseAmt(str) {
  str = String(str).replace(/[,\s円]/g, '');
  const m = str.match(/([\d.]+)万/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  const n = str.match(/\d+/);
  return n ? parseInt(n[0]) : 0;
}

function parseDt(str) {
  const m = String(str).match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return String(str).trim();
  const y = new Date().getFullYear();
  return `${y}-${String(parseInt(m[1])).padStart(2,'0')}-${String(parseInt(m[2])).padStart(2,'0')}`;
}

function parsePayment(str) {
  str = String(str).trim();
  const isC = /クレジット|クレカ|カード/.test(str);
  const isB = /銀行|振込/.test(str);
  if (!isC && !isB) return { method: '', amount: 0, isCredit: false };
  return { method: isC ? 'クレジットカード' : '銀行振込', amount: parseAmt(str), isCredit: isC };
}

function yen(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }

// ─── GAS 呼び出し ─────────────────────────────────────────────

async function callAppsScript(body) {
  const r1 = await fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body), redirect: 'manual'
  });
  if (r1.status === 302 || r1.status === 301) {
    const loc = r1.headers.get('location');
    if (loc) return fetch(loc, { method: 'GET' });
  }
  return r1;
}

// ─── LINE Reply ───────────────────────────────────────────────

async function lineReply(token, replyToken, text) {
  if (!token || !replyToken) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  }).catch(e => console.error('reply error:', e.message));
}
