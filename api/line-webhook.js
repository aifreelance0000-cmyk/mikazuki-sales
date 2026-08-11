// Vercel Serverless Function — 売上管理 LINE Webhook

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxJ3FJcnCyKn7oL7JcSfBQG1g9C9BZ3Zy7Fo2mMRFCBJqijS7kUL7d-O6fdfVMOzzSA/exec';

async function readBody(req) {
  try {
    const b = req.body;
    if (b !== undefined && b !== null) {
      if (Buffer.isBuffer(b))         return JSON.parse(b.toString('utf8'));
      if (typeof b === 'object')      return b;
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
      const text   = event.message.text.trim();
      const msgId  = event.message.id;
      const userId = event.source && event.source.userId;

      // 45秒以上前のイベントは LINE の retry → 無視（LINEの初回リトライは60秒後）
      if (Date.now() - event.timestamp > 45 * 1000) {
        console.log('stale event skipped:', event.message.id, Math.round((Date.now() - event.timestamp) / 1000) + 's old');
        continue;
      }

      try {
        if (/案件名/.test(text) && /取引先|案件単価|担当D/.test(text)) {
          // ── 受託売上 ──────────────────────────────────
          const entry = parseJutakuMessage(text);
          if (!entry) {
            await linePush(token, userId, '⚠️ パースできませんでした。\n■ 案件名：〇〇 の形式で送信してください。');
            continue;
          }

          let isDuplicate = false;
          try {
            const r   = await callAppsScript({ action: 'addJutakuSale', ...entry, _msgId: msgId });
            const txt = await r.text();
            console.log('GAS jutaku response:', txt.slice(0, 200));
            const res = JSON.parse(txt);
            isDuplicate = res.duplicate === true;
          } catch (e) {
            console.error('GAS parse error:', e.message);
          }

          if (isDuplicate) continue;

          const lines = [
            `📋 ${entry.案件名}`,
            `💼 ${entry.取引先 || '—'}`,
            `💰 ${yen(entry.案件単価)}`,
            `📅 ${entry.完了日 || '—'}`,
            `👤 担当D: ${entry.担当D || '—'}${entry.担当D取分 ? '  ' + yen(entry.担当D取分) : ''}`,
          ];
          if (entry.編集者) lines.push(`✏️ 編集者: ${entry.編集者}${entry.編集者取分 ? '  ' + yen(entry.編集者取分) : ''}`);

          await linePush(token, userId, `🌙 受託案件を登録しました\n\n` + lines.join('\n'));

        } else if (/[■◾]/.test(text) && /紹介者/.test(text)) {
          const entries = parseSalesMessage(text);
          if (!entries.length) {
            await linePush(token, userId, '⚠️ パースできませんでした。\n■紹介者：〇〇 の形式で送信してください。');
            continue;
          }

          const lines = [];
          let saved = 0;
          for (let i = 0; i < entries.length; i++) {
            const entry    = entries[i];
            const uniqueId = entries.length > 1 ? `${msgId}_${i}` : msgId;

            let isDuplicate = false;
            try {
              const r   = await callAppsScript({ action: 'addShokaiSale', ...entry, _msgId: uniqueId });
              const txt = await r.text();
              console.log('GAS response:', txt.slice(0, 200));
              const res = JSON.parse(txt);
              isDuplicate = res.duplicate === true;
            } catch (e) {
              console.error('GAS parse error:', e.message);
            }

            if (isDuplicate) continue; // 重複 → この件は返信しない

            saved++;
            const icon  = entry.タイプ === 'クーリングオフ' ? '🔴' : '✅';
            const label = entry.タイプ === 'クーリングオフ' ? ' (CO)' : '';
            lines.push(`${icon} ${entry.登録者名}  ${yen(entry.金額)}${label}`);
          }

          if (saved === 0) {
            await linePush(token, userId, '⚠️ すでに登録済みのデータです。\nスプレッドシートを確認してください。');
            continue;
          }

          const normalCount = entries.filter(e => e.タイプ === '通常').length;
          const coCount     = entries.filter(e => e.タイプ === 'クーリングオフ').length;
          let header;
          if (normalCount > 0 && coCount > 0) header = `📋 売上${normalCount}件・CO${coCount}件を登録しました`;
          else if (coCount > 0)               header = `⚠️ COを ${coCount} 件登録しました`;
          else                                header = `✅ 売上を ${normalCount} 件登録しました`;

          await linePush(token, userId, header + '\n\n' + lines.join('\n'));

        } else {
          // 名前だけ送ると受託売上の個人集計を返す
          const name = text.trim();
          let replied = false;
          if (name && name.length <= 20) {
            try {
              const r   = await callAppsScript({ action: 'getJutakuStats', name });
              const txt = await r.text();
              const res = JSON.parse(txt);
              if (res.success && res.count > 0) {
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                const ym = `${now.getFullYear()}年${now.getMonth() + 1}月`;
                const lm = now.getMonth() === 0
                  ? `${now.getFullYear() - 1}年12月`
                  : `${now.getFullYear()}年${now.getMonth()}月`;
                const msg = [
                  `🌙 ${name} さんの受託売上`,
                  ``,
                  `📅 今月（${ym}）`,
                  `　売上：${yen(res.thisMonth)}　${res.thisMonthCount}件`,
                  `📅 前月（${lm}）`,
                  `　売上：${yen(res.lastMonth)}　${res.lastMonthCount}件`,
                  `💰 累計売上：${yen(res.total)}`,
                  `📦 納品件数：${res.count}件`,
                ].join('\n');
                await linePush(token, userId, msg);
                replied = true;
              }
            } catch (e) {
              console.error('stats error:', e.message);
            }
          }
          if (!replied) {
            await linePush(token, userId, '名前を送ると受託売上を確認できます。\n売上登録は ■紹介者：〇〇 の形式で送信してください。');
          }
        }
      } catch (err) {
        console.error('event error:', err);
        await linePush(token, userId, '❌ エラー: ' + err.message);
      }
    }
  } catch (err) {
    console.error('handler error:', err);
  }

  return res.status(200).end();
};

// ─── 受託売上パーサー ─────────────────────────────────────────

function parseJutakuMessage(text) {
  let 案件名 = '', 取引先 = '', 完了日 = '';
  let 案件単価 = 0, 担当D = '', 担当D取分 = 0, 編集者 = '', 編集者取分 = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const ci = line.search(/[：:]/);
    if (ci === -1) continue;
    const key = line.slice(0, ci).replace(/^[■◾️◾🌙✨・\s]+/, '').trim();
    const val = line.slice(ci + 1).trim();
    if (!val) continue;

    if      (/案件名/.test(key))             案件名    = val;
    else if (/取引先/.test(key))             取引先    = val;
    else if (/完了日/.test(key))             完了日    = parseDt(val);
    else if (/案件単価|単価/.test(key))      案件単価  = parseAmt(val);
    else if (/担当D取分|担当d取分/.test(key)) 担当D取分 = parseAmt(val);
    else if (/担当D|担当d/.test(key))        担当D     = val;
    else if (/編集者取分/.test(key))         編集者取分 = parseAmt(val);
    else if (/編集者/.test(key))             編集者    = val;
  }

  if (!案件名) return null;
  return { 案件名, 取引先, 完了日, 案件単価, 担当D, 担当D取分, 編集者, 編集者取分 };
}

// ─── パーサー ────────────────────────────────────────────────

// 1メッセージに通常・CO混在に対応。「クーリングオフ」という文字が出た後の
// ◾紹介者ブロックを CO として扱う。
function parseSalesMessage(text) {
  const allLines = text.split('\n');
  const blocks   = []; // { lines: string[], type: string }

  let currentCO    = false;
  let blockLines   = null;
  let blockType    = '通常';

  for (const line of allLines) {
    if (/クーリングオフ/.test(line)) currentCO = true;

    if (/[■◾]/.test(line) && /紹介者/.test(line)) {
      if (blockLines !== null) blocks.push({ lines: blockLines, type: blockType });
      blockType  = currentCO ? 'クーリングオフ' : '通常';
      blockLines = [line];
    } else if (blockLines !== null) {
      blockLines.push(line);
    }
  }
  if (blockLines !== null) blocks.push({ lines: blockLines, type: blockType });

  return blocks
    .map(b => parseEntry(b.lines.join('\n'), b.type))
    .filter(e => e && e.登録者名);
}

// インライン形式 (◾key：value) と複数行形式 (◾key\n value) の両方に対応。
function parseEntry(text, type) {
  let 紹介者 = '', 登録者名 = '', 登録者ふりがな = '';
  let 金額 = 0, 入金日 = '', rawDecision = '';
  let クレカ金額 = 0, 振込金額 = 0;
  const methods = [];

  let pendingKey = null;

  function applyField(key, val) {
    if (!val) return;
    if      (/紹介者/.test(key))               紹介者 = val.replace(/さん$/, '').trim();
    else if (/登録者|氏名|フルネーム/.test(key)) {
      const m = val.match(/^(.+?)[（(](.+?)[）)]/);
      if (m) { 登録者名 = m[1].trim(); 登録者ふりがな = m[2].trim(); }
      else     登録者名 = val.trim();
    }
    else if (/ふりがな|フリガナ/.test(key))     登録者ふりがな = val.trim();
    else if (/金額/.test(key))                  金額 = parseAmt(val);
    else if (/入金日/.test(key))                入金日 = parseDt(val);
    else if (/決済/.test(key)) {
      rawDecision = val.trim();
      const p = parsePayment(val);
      if (p.method) {
        methods.push(p.method);
        if (p.isCredit) クレカ金額 += p.amount;
        else            振込金額   += p.amount;
      }
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { pendingKey = null; continue; }

    if (/^[■◾]/.test(line)) {
      const ci = line.search(/[：:]/);
      if (ci !== -1) {
        // インライン形式
        const key = line.slice(0, ci).replace(/^[■◾️◾・\s]+/, '').trim();
        const val = line.slice(ci + 1).trim();
        if (val) { applyField(key, val); pendingKey = null; }
        else       pendingKey = key;
      } else {
        // 複数行形式（次行が値）
        pendingKey = line.replace(/^[■◾️◾・\s]+/, '').trim();
      }
    } else if (pendingKey) {
      applyField(pendingKey, line);
      // 決済方法は複数行になることがあるため pendingKey を維持（空行で解除）
      if (!/決済/.test(pendingKey)) pendingKey = null;
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
    body: JSON.stringify(body), redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  if (r1.status === 302 || r1.status === 301) {
    const loc = r1.headers.get('location');
    if (loc) return fetch(loc, { method: 'GET', signal: AbortSignal.timeout(20000) });
  }
  return r1;
}

// ─── LINE Push ───────────────────────────────────────────────

async function linePush(token, userId, text) {
  if (!token || !userId) {
    console.log('linePush skip: token=' + !!token + ' userId=' + userId);
    return;
  }
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] })
    });
    const body = await r.text();
    console.log('push status:', r.status, body);
  } catch (e) {
    console.error('push error:', e.message);
  }
}
