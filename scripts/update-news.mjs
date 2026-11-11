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
import { GENRES, KEEP_DAYS } from './feeds.mjs';
import { normalizeText, cleanTitle, cleanReading } from './text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'site', 'data', 'news.json');
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 上から順に試し、使えたモデルで要約します（無料枠の対象は変わることがあるため複数用意）
const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];

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

async function summarizeWithGemini(cands, { apiKey, models, fetchImpl }) {
  if (!apiKey) {
    warn('GEMINI_API_KEY が設定されていないため、予備の見出し方式で更新します');
    return null;
  }
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
        return arr;
      } catch (e) {
        log(`Gemini ${model}: ${e.name === 'TimeoutError' ? 'タイムアウト' : '応答を読めませんでした'}`);
        break;
      }
    }
  }
  warn('Geminiが使えなかったため、予備の見出し方式で更新します');
  return null;
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
} = {}) {
  if (!models.length) models = DEFAULT_MODELS;
  const today = jstDate(now);
  const oldest = daysAgo(today, KEEP_DAYS - 1);

  const existing = await loadExisting();
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
    const picked = [];
    for (const it of merged) {
      if (picked.length >= g.perDay * 3) break;
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
      });
    }
    candidates.push(...picked);
  }
  if (feedOk === 0) throw new Error('どのRSSも読めませんでした。前日までのデータはそのまま残します。');
  log(`候補: ${candidates.length}件`);

  // 2. Geminiで要約
  const aiById = new Map();
  if (candidates.length) {
    const arr = await summarizeWithGemini(candidates, { apiKey, models, fetchImpl });
    for (const r of arr || []) if (r && r.id) aiById.set(String(r.id), r);
  }

  // 3. ジャンルごとに決まった数だけ採用（AIの結果が使えない記事は予備方式）
  const added = [];
  let aiCount = 0;
  let fallbackCount = 0;
  for (const g of GENRES) {
    const list = candidates.filter((c) => c.genre === g.id);
    let n = 0;
    for (const c of list) {
      if (n >= g.perDay) break;
      let text = '';
      let reading = '';
      let method = '';
      const ai = aiById.get(c.key);
      if (ai) {
        const t = normalizeText(ai.summary).replace(/[「」『』（）()・/]/g, '');
        const r = cleanReading(ai.reading);
        if (t.length >= 25 && t.length <= 170 && r.ok && r.reading.length >= t.length * 0.6 && sameNumbers(t, r.reading)) {
          text = t;
          reading = r.reading;
          method = 'ai';
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
      added.push({ id: c.key, genre: g.id, date: today, text, reading, headline: c.headline, source: c.source, url: c.url, method });
      n++;
    }
  }
  log(`追加: ${added.length}件（AI要約 ${aiCount}件・見出し方式 ${fallbackCount}件）`);

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
