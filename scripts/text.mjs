// 文字の整形まわり（ニュース更新スクリプト用）

// 全角英数字を半角に、記号のゆれをそろえる
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[“”"]/g, '')
    .replace(/[‘’']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([、。]) ?/g, '$1')
    .trim();
}

export function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// Googleニュースの見出しを打てる形に整える
//  「見出し - 媒体名」の媒体名や、【速報】のような角かっこを外す
export function cleanTitle(title, source) {
  let t = normalizeText(title);
  if (source) {
    const suffix = ` - ${normalizeText(source)}`;
    if (t.endsWith(suffix)) t = t.slice(0, -suffix.length);
  }
  t = t.replace(/\s+-\s+[^-]{1,30}$/, ''); // 念のため、末尾の「 - 媒体名」を外す
  t = t.replace(/【[^】]*】/g, '').replace(/\[[^\]]*\]/g, '').replace(/[（(][^）)]*[)）]$/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

// 読みとして打てる文字だけを残す
//  ひらがな、ー、、。、半角英小文字、数字、. , - だけを残し、それ以外の記号は消す
//  漢字やカタカナ以外の文字が残っていたら ok=false
const ALLOWED = /[ぁ-ゖーa-z0-9、。.,-]/;
export function cleanReading(r) {
  let s = kataToHira(String(r ?? '').normalize('NFKC'))
    .toLowerCase()
    .replace(/%/g, 'ぱーせんと')
    .replace(/[~〜～]/g, 'から')
    .replace(/[‐‑‒–—―−]/g, '-');
  let out = '';
  let ok = true;
  for (const ch of s) {
    if (ALLOWED.test(ch)) out += ch;
    else if (/[\p{Script=Han}\p{Script=Katakana}\p{L}]/u.test(ch)) ok = false; // 読めない文字が残っている
    // それ以外の記号や空白は、打たなくてよいので消す
  }
  out = out.replace(/、{2,}/g, '、').replace(/^[、。]+/, '');
  if (out.length < 4) ok = false;
  return { reading: out, ok };
}
