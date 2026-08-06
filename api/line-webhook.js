// Vercel Serverless Function — 売上管理 LINE Webhook
//
// 対応メッセージ:
//   ■紹介者：〇〇 から始まる商材売上登録
//   クーリングオフ を含むCO登録

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzRQs0ezf05NlxkeQc3FZq6h1bsF98v8PuqXdEZzSqIeKDa66xwGQEl7_pPYuC_JXBE/exec';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ status: 'ok' });

  // Vercel は JSON body を自動パース済み。req.body をそのまま使う
  const parsed = req.body;
  if (!parsed || !parsed.events || parsed.events.length === 0) return res.status(200).end();

  // LINE に 200 を先に返す（タイムアウト回避）
  res.status(200).end();

  const token = process.env.SALES_LINE_ACCESS_TOKEN || '';

  for (const event of parsed.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text.trim();
    const replyToken = event.replyToken;

    // 商材売上 / クーリングオフ
    if (isSalesMessage(text) || /クーリングオフ/.test(text)) {
      const entries = parseSalesMessage(text);
      if (!entries.length) {
        await lineReply(token, replyToken, '⚠️ フォーマットが認識できませんでした。\n■紹介者：〇〇 から始まる形式で送信してください。');
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
    await lineReply(token, replyToken, '売上登録は ■紹介者：〇〇 から始まる形式で送信してください。');
  }
};

// ────────────────────────────────────────────
//  Sales Message Detection
// ────────────────────────────────────────────
function isSalesMessage(text) {
  // ■紹介者 or ◾️紹介者（どちらの■でも対応）
  return /[■◾].*紹介者/.test(text) || /紹介者[：:]/.test(text);
}

// ────────────────────────────────────────────
//  LINE Message Parser
// ────────────────────────────────────────────
function parseSalesMessage(text) {
  const isCO = /クーリングオフ/.test(text);
  const type = isCO ? 'クーリングオフ' : '通常';

  // ■紹介者 または ◾️紹介者 が現れるたびに新エントリー開始
  const lineArr = text.split('\n');
  const parts = [];
  let buf = [];
  let started = false;

  for (const line of lineArr) {
    if (/[■◾].*紹介者/.test(line) || (/紹介者[：:]/.test(line) && !started)) {
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

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // コロン（：全角 or :半角）で key/value を分割
    const colonIdx = line.search(/[：:]/);
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).replace(/^[■◾️◾・\s]+/, '').trim();
    const val = line.slice(colonIdx + 1).trim();
    if (!val) continue;

    if      (/紹介者/.test(key))                       紹介者 = val.replace(/さん$/, '').trim();
    else if (/登録者名|氏名|フルネーム/.test(key))     {
      const m = val.match(/^(.+?)[（(](.+?)[）)]/);
      if (m) { 登録者名 = m[1].trim(); 登録者ふりがな = m[2].trim(); }
      else     登録者名 = val.trim();
    }
    else if (/ふりがな|フリガナ/.test(key))            登録者ふりがな = val.trim();
    else if (/金額/.test(key))                         金額 = parseAmt(val);
    else if (/入金日/.test(key))                       入金日 = parseDt(val);
    else if (/決済/.test(key)) {
      const p = parsePayment(val);
      if (p.method) {
        methods.push(p.method);
        if (p.isCredit) クレカ金額 += p.amount;
        else            振込金額   += p.amount;
      }
    }
  }

  // 金額だけ指定して内訳がない場合、決済方法に応じて自動セット
  if (金額 > 0 && クレカ金額 === 0 && 振込金額 === 0) {
    const hasCredit = methods.some(m => /クレジット|クレカ|カード/.test(m));
    const hasBank   = methods.some(m => /銀行|振込/.test(m));
    if (hasCredit && !hasBank) クレカ金額 = 金額;
    if (hasBank   && !hasCredit) 振込金額 = 金額;
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
