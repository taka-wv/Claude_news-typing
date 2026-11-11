// 毎朝GitHubの自動実行で動かす、ニュース更新スクリプト
//
//  1. ジャンルごとにGoogleニュースのRSSから見出しを集める
//  2. Geminiの無料枠で、2〜3文の要約とひらがなの読みを作る
//  3. Geminiが使えないときは、見出しをそのまま使い、解析ツール（kuromoji）で読みを付ける
//  4. 直近7日分だけを残して site/data/news.json に保存する
//
// APIキーは環境変数 GEMINI_API_KEY から読むだけで、ファイルやログには一切書き出しません。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import kuromoji from 'kuromoji';
import { GENRES, KEEP_DAYS, FILL_TARGET } from './feeds.mjs';
import { normalizeText, cleanTitle, cleanReading, kataToHira } from './text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'site', 'data', 'news.json');
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 上から順に試し、使えたモデルで要約します（無料枠の対象は変わることがあるため複数用意）
const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];
// 1回の問い合わせでまとめて要約する記事の数と、問い合わせの間隔（無料枠の回数制限に引っかからないように）
const BATCH_SIZE = 12;
const BATCH_INTERVAL_MS = 13000;

const log = (...a) => console.log('[news]', ...a);
const warn = (msg) => console.log(`::warning::${msg}`);

// ---------- 日付 ----------
export function jstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}
function daysAgo(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------- RSS ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return String(v);
}

// Googleニュースの説明欄には、同じ話題の関連見出しがリンクの一覧として入っている
export function extractRelated(html) {
  const s = decodeEntities(String(html ?? ''));
  const out = [];
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>(?:\s|&nbsp;| )*(?:<font\b[^>]*>([\s\S]*?)<\/font>)?/gi;
  let m;
  while ((m = re.exec(s))) {
    const t = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
    const src = m[2] ? decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim() : '';
    if (t) out.push(src ? `${t}（${src}）` : t);
  }
  return out.slice(0, 6);
}

export function parseFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
  const doc = parser.parse(xml);
  let items = doc?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return items
    .map((it) => {
      const pub = it.pubDate ? new Date(textOf(it.pubDate)) : null;
      return {
        title: decodeEntities(textOf(it.title)),
        link: textOf(it.link).trim(),
        pubDate: pub && !isNaN(pub) ? pub : null,
        source: decodeEntities(textOf(it.source)),
        related: extractRelated(textOf(it.description)),
      };
    })
    .filter((i) => i.title && /^https?:\/\//.test(i.link));
}

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (news-typing; hobby project)', Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------- 読み（予備方式） ----------
let tokenizerPromise = null;
function getTokenizer() {
  if (!tokenizerPromise) {
    const dicPath = path.join(ROOT, 'node_modules', 'kuromoji', 'dict');
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t)));
    });
  }
  return tokenizerPromise;
}
export async function readingByTokenizer(text) {
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  // 数字のあとの「月」「日」は、がつ・にち と読む（例：9月→9がつ）
  const AFTER_NUMBER = { 月: 'ガツ', 日: 'ニチ' };
  const raw = tokens
    .map((tk, i) => {
      const prev = tokens[i - 1]?.surface_form ?? '';
      if (/[0-9]$/.test(prev) && AFTER_NUMBER[tk.surface_form]) return AFTER_NUMBER[tk.surface_form];
      return tk.reading && tk.reading !== '*' ? tk.reading : tk.surface_form;
    })
    .join('');
  return cleanReading(raw);
}

// ---------- AIの読みの確かめ ----------
// AIの読みには、ときどき書き間違い（例：に対する→になんする）や、関係のない言葉の混入が起きる。
// そこで、解析ツール（kuromoji）の読みと1文字ずつ突き合わせて、次のように組み立て直す。
//  - ひらがな・カタカナ・英数字は、文章に書いてあるとおりに読む（AIの書き間違いはここで消える）
//  - 漢字の単語は、ふだんは解析ツールの読みを使う
//  - ただし人名・地名などの固有名詞、辞書にない単語、1文字だけの漢字（間・君・雄など）は、
//    前後でAIの読みが正確なときに限って、AIの読みを使う（解析ツールが苦手なところ）
function literalOf(ch) {
  if (/[ぁ-ゖー、。]/.test(ch)) return ch;
  if (/[ァ-ヴ]/.test(ch)) return kataToHira(ch);
  if (/[a-z0-9.,-]/i.test(ch)) return ch.toLowerCase();
  if (ch === '%') return 'ぱーせんと';
  if (/[~〜～]/.test(ch)) return 'から';
  return null;
}
const isKanji = (ch) => /[\p{Script=Han}々〆ヵヶ]/u.test(ch);
const isHira = (s) => /^[ぁ-ゖー]+$/.test(s);

// 文章を「そのまま読む部分」と「漢字の単語」に分け、解析ツールの読みを付ける
async function splitPieces(text) {
  const t = await getTokenizer();
  const tokens = t.tokenize(text);
  const pieces = [];
  const pushLit = (s) => {
    if (!s) return;
    const last = pieces[pieces.length - 1];
    if (last && last.type === 'lit') last.s += s;
    else pieces.push({ type: 'lit', s });
  };
  tokens.forEach((tk, idx) => {
    const chars = Array.from(tk.surface_form);
    // 漢字でも「そのまま読む文字」でもない記号や空白は、読みに入らないので空にする
    const lits = chars.map((c) => literalOf(c) ?? (isKanji(c) ? null : ''));
    let a = 0;
    while (a < chars.length && lits[a] != null) a++;
    let b = chars.length;
    while (b > a && lits[b - 1] != null) b--;
    const head = lits.slice(0, a).join('');
    const tail = lits.slice(b).join('');
    pushLit(head);
    if (b > a) {
      const mid = chars.slice(a, b);
      let k = null;
      const prev = tokens[idx - 1]?.surface_form ?? '';
      const AFTER_NUMBER = { 月: 'がつ', 日: 'にち' };
      if (/[0-9]$/.test(prev) && AFTER_NUMBER[tk.surface_form]) k = AFTER_NUMBER[tk.surface_form];
      else if (tk.reading && tk.reading !== '*') {
        const r = kataToHira(tk.reading);
        if (r.startsWith(head) && r.endsWith(tail) && r.length > head.length + tail.length) {
          k = r.slice(head.length, r.length - tail.length);
        }
      }
      const kanjiCount = mid.filter(isKanji).length;
      pieces.push({
        type: 'run',
        surface: mid.join(''),
        k: k && isHira(k) ? k : null,
        len: mid.length,
        eligible: tk.pos_detail_1 === '固有名詞' || tk.word_type === 'UNKNOWN' || !k ||
          (chars.length === 1 && kanjiCount === 1),
      });
    }
    pushLit(tail);
  });
  return pieces;
}

// 2つの読みを1文字ずつ対応づける（編集距離）
function align(A, K) {
  const n = A.length, m = K.length;
  const d = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === K[j - 1] ? 0 : 1));
  }
  // aOf[j] = K[j] に対応するAの文字（挿入分も含む）、err[j] = そこでの食い違いの数
  const aOf = Array.from({ length: m }, () => '');
  const err = new Uint16Array(m + 1);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (A[i - 1] === K[j - 1] ? 0 : 1)) {
      aOf[j - 1] = A[i - 1] + aOf[j - 1];
      if (A[i - 1] !== K[j - 1]) err[j - 1]++;
      i--; j--;
    } else if (j > 0 && d[i][j] === d[i][j - 1] + 1) {
      err[j - 1]++; j--;
    } else {
      const at = Math.min(j, m - 1);
      if (at >= 0) { aOf[at] = A[i - 1] + aOf[at]; err[at]++; }
      i--;
    }
  }
  return { aOf, err };
}

const isSubseq = (short, long) => {
  let p = 0;
  for (const c of long) if (c === short[p]) p++;
  return p === short.length;
};

export async function checkedReading(text, aiReading) {
  const pieces = await splitPieces(text);
  const ai = cleanReading(aiReading);
  // 解析ツールだけの読み（読めない漢字があれば null）
  const kuroOnly = pieces.every((p) => p.type === 'lit' || p.k) ? pieces.map((p) => (p.type === 'lit' ? p.s : p.k)).join('') : null;
  if (!ai.ok) return kuroOnly ? { ...cleanReading(kuroOnly), fixed: 1 } : { reading: '', ok: false, fixed: 0 };

  // 解析ツールが読めない単語は、仮に「？」で長さだけ合わせて突き合わせる
  const K = [];
  const span = [];
  for (const p of pieces) {
    const s = p.type === 'lit' ? p.s : p.k || '？'.repeat(Math.max(1, p.len * 2));
    span.push([K.length, K.length + s.length]);
    K.push(...s);
  }
  const { aOf, err } = align(Array.from(ai.reading), K);
  const segA = (pi) => aOf.slice(span[pi][0], span[pi][1]).join('');
  const errIn = (pi) => { let e = 0; for (let x = span[pi][0]; x < span[pi][1]; x++) e += err[x]; return e; };

  let out = '';
  let fixed = 0;
  for (let pi = 0; pi < pieces.length; pi++) {
    const p = pieces[pi];
    if (p.type === 'lit') { out += p.s; if (errIn(pi)) fixed++; continue; }
    const a = segA(pi);
    if (p.k && a === p.k) { out += p.k; continue; }
    // 同じ漢字のかたまりの中で、AIを採用しない単語や前後の目印にずれがないか
    let clean = true;
    for (let q = pi - 1; q >= 0; q--) {
      if (pieces[q].type === 'lit') { if (errIn(q)) clean = false; break; }
      if (!pieces[q].eligible && errIn(q)) clean = false;
    }
    for (let q = pi + 1; q < pieces.length; q++) {
      if (pieces[q].type === 'lit') { if (errIn(q)) clean = false; break; }
      if (!pieces[q].eligible && errIn(q)) clean = false;
    }
    const aiOk = isHira(a) && a.length <= p.len * 4 + 1 && !(p.k && a.length < p.k.length && isSubseq(a, p.k));
    if (p.eligible && clean && aiOk) out += a;
    else if (p.k) { out += p.k; fixed++; }
    else if (aiOk) out += a;
    else return { reading: '', ok: false, fixed: 0 };
  }
  return { ...cleanReading(out), fixed };
}

// ---------- 確かめ ----------
const digitsOf = (s) => (s.match(/[0-9]+/g) || []).join(',');
function sameNumbers(text, reading) {
  return digitsOf(text) === digitsOf(reading);
}

// ---------- Gemini ----------
function buildPrompt(cands) {
  const items = cands.map((c) => ({ id: c.key, headline: c.headline, related: c.related }));
  return [
    'あなたはニュースの要約担当です。以下はニュースの見出しと、同じ話題を扱う関連見出しの一覧です。',
    '各項目について、日本語のタイピング練習で打つための要約と、その読みを作ってください。',
    '',
    'ルール：',
    '- summary は2〜3文、合計60〜120文字。見出しから分かることが少ないときは1〜2文、30文字以上でよい。',
    '- 見出しと関連見出しに書かれている事実だけを使う。推測、意見、見出しにない数字や名前は加えない。',
    '- 見出しの文をそのまま写さず、自分の言葉で書き直す。文末は「〜した。」「〜する方針だ。」のようなニュースの書き方にする。',
    '- 使ってよい記号は「、」「。」だけ。かっこ、かぎかっこ、引用符、中黒、スラッシュなどは使わない。',
    '- 数字と英字は半角で書く。',
    '- reading は summary 全体の読みを、ひらがなで書く。漢字とカタカナはすべてひらがなにする。',
    '- reading では、数字は summary と同じ半角数字のまま、英字の語は小文字の英字のまま書く（例：AI→ai、Apple→apple）。%は「ぱーせんと」と書く。',
    '- reading の「、」「。」は summary と同じ位置に入れる。',
    '- reading は summary の文字を前から順に読んだものだけにする。言い直し、注釈、「じゃなくて」などの言葉は絶対に入れない。',
    '',
    '出力は次の形のJSON配列だけにしてください：[{"id":"...","summary":"...","reading":"..."}]',
    '',
    '項目：',
    JSON.stringify(items, null, 1),
  ].join('\n');
}

function parseGeminiJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('JSONの配列が見つからない');
  const arr = JSON.parse(t.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('配列ではない');
  return arr;
}

async function summarizeBatch(cands, { apiKey, models, fetchImpl }) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: buildPrompt(cands) }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // キーはURLに入れず、ヘッダーで渡す（エラー時にURLがログに出てもキーが漏れないように）
        const res = await fetchImpl(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
          log(`Gemini ${model}: HTTP ${res.status}`);
          if (res.status >= 500 && attempt === 1) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          break; // 次のモデルへ
        }
        const json = await res.json();
        const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        const arr = parseGeminiJson(text);
        log(`Gemini ${model}: ${arr.length}件の要約を受け取りました`);
        return { arr, model };
      } catch (e) {
        log(`Gemini ${model}: ${e.name === 'TimeoutError' ? 'タイムアウト' : '応答を読めませんでした'}`);
        break;
      }
    }
  }
  return null;
}

// 記事を数件ずつに分けて要約する。途中で使えなくなったら、残りは予備方式に回す
async function summarizeWithGemini(cands, { apiKey, models, fetchImpl, sleep }) {
  if (!apiKey) {
    warn('GEMINI_API_KEY が設定されていないため、予備の見出し方式で更新します');
    return [];
  }
  const out = [];
  let order = models.slice();
  for (let i = 0; i < cands.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_INTERVAL_MS);
    const r = await summarizeBatch(cands.slice(i, i + BATCH_SIZE), { apiKey, models: order, fetchImpl });
    if (!r) {
      warn(i === 0 ? 'Geminiが使えなかったため、予備の見出し方式で更新します' : 'Geminiが途中で使えなくなったため、残りは予備の見出し方式で更新します');
      break;
    }
    out.push(...r.arr);
    order = [r.model, ...models.filter((m) => m !== r.model)]; // 使えたモデルを次も先に試す
  }
  return out;
}

// ---------- メイン ----------
const keyOf = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const titleKey = (s) => normalizeText(s).replace(/[\s、。・「」『』!?！？]/g, '');

async function loadExisting() {
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    return { articles: [] };
  }
}

export async function run({
  fetchImpl = fetch,
  apiKey = process.env.GEMINI_API_KEY,
  models = (process.env.GEMINI_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
  now = new Date(),
  write = true,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!models.length) models = DEFAULT_MODELS;
  const today = jstDate(now);
  const oldest = daysAgo(today, KEEP_DAYS - 1);

  const existing = await loadExisting();
  // 定時実行は予備も含めて1日2回あるので、その日すでに更新済みなら何もしない（手動の「Run workflow」は対象外）
  if (process.env.SKIP_IF_UPDATED_TODAY === '1' && existing.updatedDate === today) {
    log('今日はすでに更新済みなので、何もしません');
    return existing;
  }
  // サンプル記事（url が空）は、本物のニュースが入ったら消す
  let pool = (existing.articles || []).filter((a) => a.url && a.date >= oldest);
  const seenUrl = new Set(pool.map((a) => a.url));
  const seenTitle = new Set(pool.map((a) => titleKey(a.headline || a.text)));

  // 1. RSSを集める
  const candidates = [];
  let feedOk = 0;
  for (const g of GENRES) {
    const lists = [];
    for (const url of g.feeds) {
      try {
        const items = parseFeed(await fetchText(url, fetchImpl));
        lists.push(items);
        feedOk++;
      } catch (e) {
        log(`RSSを読めませんでした（${g.name}）: ${e.message}`);
      }
    }
    // 複数のRSSから交互に取り出し、新しい順に並べる
    const merged = [];
    const max = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) merged.push(l[i]);
    // 今回追加する本数：ふだんは perDay 本。記事が少ないときは FILL_TARGET 本まで補充する
    const have = pool.filter((a) => a.genre === g.id).length;
    g.need = Math.max(g.perDay, Math.min(FILL_TARGET, FILL_TARGET - have));
    const picked = [];
    for (const it of merged) {
      if (picked.length >= Math.ceil(g.need * 1.4) + 2) break;
      const headline = cleanTitle(it.title, it.source);
      const tk = titleKey(headline);
      if (headline.length < 8 || seenUrl.has(it.link) || seenTitle.has(tk)) continue;
      if (it.pubDate && jstDate(it.pubDate) < oldest) continue;
      seenUrl.add(it.link);
      seenTitle.add(tk);
      picked.push({
        key: keyOf(it.link),
        genre: g.id,
        headline,
        related: it.related.filter((r) => !r.startsWith(headline)).slice(0, 5),
        source: normalizeText(it.source),
        url: it.link,
        date: it.pubDate ? jstDate(it.pubDate) : today,
      });
    }
    candidates.push(...picked);
  }
  if (feedOk === 0) throw new Error('どのRSSも読めませんでした。前日までのデータはそのまま残します。');
  log(`候補: ${candidates.length}件`);

  // 2. Geminiで要約
  const aiById = new Map();
  if (candidates.length) {
    const arr = await summarizeWithGemini(candidates, { apiKey, models, fetchImpl, sleep });
    for (const r of arr) if (r && r.id) aiById.set(String(r.id), r);
  }

  // 3. ジャンルごとに決まった数だけ採用（AIの結果が使えない記事は予備方式）
  const added = [];
  let fixedCount = 0;
  let aiCount = 0;
  let fallbackCount = 0;
  for (const g of GENRES) {
    const list = candidates.filter((c) => c.genre === g.id);
    let n = 0;
    for (const c of list) {
      if (n >= g.need) break;
      let text = '';
      let reading = '';
      let method = '';
      const ai = aiById.get(c.key);
      if (ai) {
        const t = normalizeText(ai.summary).replace(/[「」『』（）()・/]/g, '');
        if (t.length >= 25 && t.length <= 170) {
          const r = await checkedReading(t, ai.reading);
          fixedCount += r.fixed;
          if (r.ok && r.reading.length >= t.length * 0.6 && sameNumbers(t, r.reading)) {
            text = t;
            reading = r.reading;
            method = 'ai';
          }
        }
      }
      if (!method) {
        const r = await readingByTokenizer(c.headline);
        if (r.ok && sameNumbers(c.headline, r.reading)) {
          text = c.headline;
          reading = r.reading;
          method = 'headline';
        }
      }
      if (!method) continue;
      method === 'ai' ? aiCount++ : fallbackCount++;
      added.push({ id: c.key, genre: g.id, date: c.date, text, reading, headline: c.headline, source: c.source, url: c.url, method });
      n++;
    }
  }
  log(`追加: ${added.length}件（AI要約 ${aiCount}件・見出し方式 ${fallbackCount}件）`);
  if (fixedCount) log(`AIの読みを解析ツールで直した箇所: ${fixedCount}か所`);

  // すでに保存してある記事の読みも、同じ方法で確かめ直す
  let refixed = 0;
  for (const a of pool) {
    if (a.method !== 'ai') continue;
    const r = await checkedReading(a.text, a.reading);
    if (r.ok && r.reading !== a.reading && sameNumbers(a.text, r.reading)) {
      a.reading = r.reading;
      refixed++;
    }
  }
  if (refixed) log(`保存済みの記事の読みを直しました: ${refixed}件`);

  // 4. 保存
  pool = [...added, ...pool].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const out = {
    updatedAt: now.toISOString(),
    updatedDate: today,
    keepDays: KEEP_DAYS,
    genres: GENRES.map((g) => ({ id: g.id, name: g.name })),
    articles: pool,
  };
  if (write) {
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(out, null, 1) + '\n', 'utf8');
    log(`保存しました: 全${pool.length}件`);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
