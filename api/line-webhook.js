// Vercel Serverless Function — 売上管理 LINE Webhook
//
// 対応メッセージ:
//   ◾️紹介者 から始まる商材売上登録
//   ⚠️クーリングオフのご報告⚠️ から始まるCO登録
//   ※受託売上は別途フォーマット確定後に追加

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxQRESnVJ9NW_VTCs07g9iK7lsIURJBD4nIdA_4yQi8_5sS2dSEVi0vzOkCEaJcz_U/exec';

module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ status: 'ok' });

  const rawBody = await new Promise((resolve, reject) => {
    let d = '';
    req.on('data',  c => { d += c.toString('utf8'); });
    req.on('end',   () => resolve(d));
    req.on('error', reject);
  });

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    return res.status(200).end();
  }

  if (!parsed.events || parsed.events.length === 0) return res.status(200).end();

  // LINE に 200 を先に返す（タイムアウト回避）
  res.status(200).end();

  const token = process.env.SALES_LINE_ACCESS_TOKEN || '';

  for (const event of parsed.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text.trim();
    const replyToken = event.replyToken;

    // 商材売上 / クーリングオフ
    if (/◾[️]?紹介者/.test(text) || /クーリングオフ/.test(text)) {
      const entries = parseSalesMessage(text);
      if (!entries.length) {
        await lineReply(token, replyToken, '⚠️ フォーマットが認識できませんでした。\n◾️紹介者 から始まる形式で送信してください。');
        continue;
      }

      let saved = 0;
      const lines = [];
      for (const entry of entries) {
        try {
          await callAppsScript({ action: 'addShokaiSale', ...entry });
          saved++;
          const tag = entry.タイプ === 'クーリングオフ' ? '🔴CO' : '✅';
          lines.push(`${tag} ${entry.登録者名}  ${yen(entry.金額)}`);
        } catch (e) {
          console.error('save error:', e.message);
        }
      }

      const header = entries[0]?.タイプ === 'クーリングオフ'
        ? `⚠️ クーリングオフを ${saved} 件登録しました`
        : `✅ 売上を ${saved} 件登録しました`;
      await lineReply(token, replyToken, header + '\n\n' + lines.join('\n'));
      continue;
    }

    // 未対応フォーマット
    await lineReply(token, replyToken, '売上登録は ◾️紹介者 から始まる形式で送信してください。');
  }
};

// ────────────────────────────────────────────
//  LINE Message Parser
// ────────────────────────────────────────────
function parseSalesMessage(text) {
  const isCO = /クーリングオフ/.test(text);
  const type = isCO ? 'クーリングオフ' : '通常';

  // ◾️紹介者 が現れるたびに新エントリー開始
  const lineArr = text.split('\n');
  const parts = [];
  let buf = [];
  let started = false;

  for (const line of lineArr) {
    if (/◾[️]?紹介者/.test(line)) {
      if (started && buf.length) parts.push(buf.join('\n'));
      buf = [line];
      started = true;
    } else if (started) {
      buf.push(line);
    }
  }
  if (buf.length) parts.push(buf.join('\n'));

  return parts.map(p => parseEntry(p, type)).filter(e => e && e.登録者名);
}

function parseEntry(text, type) {
  const lines = text.split('\n');
  let 紹介者 = '', 登録者名 = '', 登録者ふりがな = '';
  let 金額 = 0, 入金日 = '';
  let クレカ金額 = 0, 振込金額 = 0;
  const methods = [];
  let state = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/◾[️]?紹介者/.test(line))                                 { state = '紹介者'; continue; }
    if (/登録者様のフルネーム|フルネーム/.test(line))              { state = '登録者'; continue; }
    if (/◾[️]?金額/.test(line))                                   { state = '金額';   continue; }
    if (/入金日/.test(line))                                       { state = '入金日'; continue; }
    if (/決済方法/.test(line))                                     { state = '決済';   continue; }

    switch (state) {
      case '紹介者':
        紹介者 = line.replace(/さん$/, '').trim();
        state = '';
        break;
      case '登録者': {
        const m = line.match(/^(.+?)[（(](.+?)[）)]/);
        if (m) { 登録者名 = m[1].trim(); 登録者ふりがな = m[2].trim(); }
        else     登録者名 = line.trim();
        state = '';
        break;
      }
      case '金額':
        金額 = parseAmt(line);
        state = '';
        break;
      case '入金日':
        入金日 = parseDt(line);
        state = '';
        break;
      case '決済': {
        const p = parsePayment(line);
        if (p.method) {
          methods.push(p.method);
          if (p.isCredit) クレカ金額 += p.amount;
          else            振込金額   += p.amount;
        }
        break;
      }
    }
  }

  const 決済方法 = [...new Set(methods)].join('・');
  return { 紹介者, 登録者名, 登録者ふりがな, 金額, 入金日, 決済方法, クレカ金額, 振込金額, タイプ: type };
}

function parseAmt(str) {
  str = String(str).replace(/[,\s円]/g, '');
  const man = str.match(/([\d.]+)万/);
  if (man) return Math.round(parseFloat(man[1]) * 10000);
  const num = str.match(/\d+/);
  return num ? parseInt(num[0]) : 0;
}

function parseDt(str) {
  const m = String(str).match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return String(str).trim();
  const y = new Date().getFullYear();
  return `${y}-${String(parseInt(m[1])).padStart(2,'0')}-${String(parseInt(m[2])).padStart(2,'0')}`;
}

function parsePayment(str) {
  str = String(str).trim();
  const isCredit = /クレジット|クレカ|カード/.test(str);
  const isBank   = /銀行|振込/.test(str);
  if (!isCredit && !isBank) return { method: '', amount: 0, isCredit: false };
  return { method: isCredit ? 'クレジットカード' : '銀行振込', amount: parseAmt(str), isCredit };
}

function yen(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }

// ────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────
async function callAppsScript(body) {
  const step1 = await fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body), redirect: 'manual'
  });
  if (step1.status === 302 || step1.status === 301) {
    const loc = step1.headers.get('location');
    if (loc) await fetch(loc, { method: 'GET' });
  }
}

async function lineReply(token, replyToken, text) {
  if (!token || !replyToken) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
    });
  } catch (e) {
    console.error('LINE reply error:', e.message);
  }
}
