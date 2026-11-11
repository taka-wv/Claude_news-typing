/*
 * ローマ字入力の判定
 *  ひらがなの読みを「打つ単位」に区切り、単位ごとに受け付ける打ち方の候補を持つ。
 *  例：「し」→ shi / si / ci、「ちゃ」→ cha / tya / cya、「っ」は次の子音を重ねる、など。
 */
(function (global) {
  'use strict';

  const BASE = {
    'あ': ['a'], 'い': ['i', 'yi'], 'う': ['u', 'wu', 'whu'], 'え': ['e'], 'お': ['o'],
    'か': ['ka', 'ca'], 'き': ['ki'], 'く': ['ku', 'cu', 'qu'], 'け': ['ke'], 'こ': ['ko', 'co'],
    'さ': ['sa'], 'し': ['shi', 'si', 'ci'], 'す': ['su'], 'せ': ['se', 'ce'], 'そ': ['so'],
    'た': ['ta'], 'ち': ['chi', 'ti'], 'つ': ['tsu', 'tu'], 'て': ['te'], 'と': ['to'],
    'な': ['na'], 'に': ['ni'], 'ぬ': ['nu'], 'ね': ['ne'], 'の': ['no'],
    'は': ['ha'], 'ひ': ['hi'], 'ふ': ['fu', 'hu'], 'へ': ['he'], 'ほ': ['ho'],
    'ま': ['ma'], 'み': ['mi'], 'む': ['mu'], 'め': ['me'], 'も': ['mo'],
    'や': ['ya'], 'ゆ': ['yu'], 'よ': ['yo'],
    'ら': ['ra'], 'り': ['ri'], 'る': ['ru'], 'れ': ['re'], 'ろ': ['ro'],
    'わ': ['wa'], 'を': ['wo'], 'ん': ['nn', "n'", 'xn'],
    'が': ['ga'], 'ぎ': ['gi'], 'ぐ': ['gu'], 'げ': ['ge'], 'ご': ['go'],
    'ざ': ['za'], 'じ': ['ji', 'zi'], 'ず': ['zu'], 'ぜ': ['ze'], 'ぞ': ['zo'],
    'だ': ['da'], 'ぢ': ['di'], 'づ': ['du'], 'で': ['de'], 'ど': ['do'],
    'ば': ['ba'], 'び': ['bi'], 'ぶ': ['bu'], 'べ': ['be'], 'ぼ': ['bo'],
    'ぱ': ['pa'], 'ぴ': ['pi'], 'ぷ': ['pu'], 'ぺ': ['pe'], 'ぽ': ['po'],
    'ゔ': ['vu'],
    'ぁ': ['la', 'xa'], 'ぃ': ['li', 'xi'], 'ぅ': ['lu', 'xu'], 'ぇ': ['le', 'xe'], 'ぉ': ['lo', 'xo'],
    'ゃ': ['lya', 'xya'], 'ゅ': ['lyu', 'xyu'], 'ょ': ['lyo', 'xyo'], 'ゎ': ['lwa', 'xwa'],
    'っ': ['ltu', 'xtu', 'ltsu', 'xtsu'], 'ゕ': ['lka', 'xka'], 'ゖ': ['lke', 'xke'],
    'ー': ['-'], '、': [','], '。': ['.'],
  };

  // 2文字で1つの音になるもの（きゃ、しゅ、ふぁ など）
  const COMBO = {};
  const yRow = (kana, heads) => {
    const smalls = { 'ゃ': 'a', 'ぃ': 'i', 'ゅ': 'u', 'ぇ': 'e', 'ょ': 'o' };
    for (const s in smalls) COMBO[kana + s] = heads.map((h) => h + smalls[s]);
  };
  yRow('き', ['ky']); yRow('ぎ', ['gy']); yRow('に', ['ny']); yRow('ひ', ['hy']); yRow('び', ['by']);
  yRow('ぴ', ['py']); yRow('み', ['my']); yRow('り', ['ry']); yRow('ぢ', ['dy']);
  yRow('し', ['sy']); yRow('ち', ['ty', 'cy']); yRow('じ', ['zy', 'jy']);
  Object.assign(COMBO, {
    'しゃ': ['sha', 'sya'], 'しゅ': ['shu', 'syu'], 'しょ': ['sho', 'syo'], 'しぇ': ['she', 'sye'],
    'ちゃ': ['cha', 'tya', 'cya'], 'ちゅ': ['chu', 'tyu', 'cyu'], 'ちょ': ['cho', 'tyo', 'cyo'], 'ちぇ': ['che', 'tye', 'cye'],
    'じゃ': ['ja', 'zya', 'jya'], 'じゅ': ['ju', 'zyu', 'jyu'], 'じょ': ['jo', 'zyo', 'jyo'], 'じぇ': ['je', 'zye', 'jye'],
    'ふぁ': ['fa'], 'ふぃ': ['fi'], 'ふぇ': ['fe'], 'ふぉ': ['fo'], 'ふゅ': ['fyu'],
    'てぃ': ['thi'], 'てゅ': ['thu'], 'でぃ': ['dhi'], 'でゅ': ['dhu'], 'とぅ': ['twu'], 'どぅ': ['dwu'],
    'うぃ': ['wi', 'whi'], 'うぇ': ['we', 'whe'], 'うぉ': ['who'], 'いぇ': ['ye'],
    'ゔぁ': ['va'], 'ゔぃ': ['vi'], 'ゔぇ': ['ve'], 'ゔぉ': ['vo'], 'つぁ': ['tsa'],
  });
  // しゃ→shya は不要なので、y段の自動生成で入った 'sy' 系は残しつつ重複を消す
  for (const k in COMBO) COMBO[k] = [...new Set(COMBO[k])];

  const SMALL = 'ぁぃぅぇぉゃゅょゎ';
  const VOWELS = 'aiueo';

  function single(ch) {
    if (BASE[ch]) return BASE[ch].slice();
    return [ch]; // 半角英数字や . , - はそのまま
  }

  // 読みを「打つ単位」に区切る
  function tokenize(reading) {
    const chars = Array.from(reading);
    const units = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const next = chars[i + 1];
      if (next && SMALL.includes(next) && !SMALL.includes(c) && c !== 'っ' && c !== 'ん') {
        const pair = c + next;
        const split = [];
        for (const a of single(c)) for (const b of single(next)) split.push(a + b);
        units.push({ kana: pair, cands: [...new Set([...(COMBO[pair] || []), ...split])] });
        i++;
      } else {
        units.push({ kana: c, cands: single(c) });
      }
    }
    // 「っ」は次の単位と合わせ、子音を重ねる打ち方も受け付ける
    const merged = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const nx = units[i + 1];
      if (u.kana === 'っ' && nx && nx.kana !== 'っ' && nx.kana !== 'ん') {
        const cands = [];
        for (const c of nx.cands) {
          const h = c[0];
          if (/[a-z]/.test(h) && !VOWELS.includes(h) && h !== 'n') cands.push(h + c);
          if (c.startsWith('ch')) cands.push('t' + c); // まっちゃ → matcha も可
        }
        for (const t of BASE['っ']) for (const c of nx.cands) cands.push(t + c);
        merged.push({ kana: u.kana + nx.kana, cands: [...new Set(cands)] });
        i++;
      } else {
        merged.push(u);
      }
    }
    return merged;
  }

  class Typer {
    constructor(reading) {
      this.reading = reading;
      this.units = tokenize(reading);
      this.idx = 0;
      this.buf = '';
      this.done = []; // 打ち終えた単位ごとの、実際の打ち方
    }

    get finished() {
      return this.idx >= this.units.length;
    }

    // 「ん」を n 1回で済ませてよいか（次の文字が母音・y・n で始まらないとき）
    _singleNOk(nextUnit, key) {
      if (!nextUnit) return false;
      if ('aiueoyn\''.includes(key)) return false;
      return nextUnit.cands.some((c) => c.startsWith(key));
    }

    _unitGuide(i, buf) {
      const u = this.units[i];
      if (!u) return '';
      if (u.kana === 'ん' && (buf === '' || buf === 'n')) {
        const nx = this.units[i + 1];
        const d = nx ? this._defaultCand(i + 1) : '';
        if (nx && d && !'aiueoyn\''.includes(d[0])) return 'n';
        return 'nn';
      }
      const hit = u.cands.find((c) => c.startsWith(buf));
      return hit || u.cands[0];
    }

    _defaultCand(i) {
      const u = this.units[i];
      return u ? u.cands[0] : '';
    }

    // キーを1つ受け取る。正しければ true、間違いなら false
    input(rawKey) {
      if (this.finished) return { ok: false, finished: true };
      const key = rawKey.toLowerCase();
      const u = this.units[this.idx];
      const nextBuf = this.buf + key;

      // 「ん」を n 1回で打ち、次の文字へ進むケース
      if (u.kana === 'ん' && this.buf === 'n' && this._singleNOk(this.units[this.idx + 1], key)) {
        this.done.push('n');
        this.idx++;
        this.buf = '';
        const r = this.input(key);
        return { ok: r.ok, completed: true, finished: this.finished };
      }

      const possible = u.cands.filter((c) => c.startsWith(nextBuf));
      if (!possible.length) return { ok: false };
      this.buf = nextBuf;
      if (possible.includes(nextBuf) && !(u.kana === 'ん' && nextBuf === 'n')) {
        this.done.push(nextBuf);
        this.idx++;
        this.buf = '';
        return { ok: true, completed: true, finished: this.finished };
      }
      return { ok: true, completed: false, finished: false };
    }

    // 画面に出すローマ字のガイド
    guide() {
      const typed = this.done.join('') + this.buf;
      let rest = '';
      if (!this.finished) {
        const cur = this._unitGuide(this.idx, this.buf);
        rest = cur.slice(this.buf.length);
        for (let i = this.idx + 1; i < this.units.length; i++) rest += this._unitGuide(i, '');
      }
      return { typed, rest };
    }

    // 次に打つべきキー（苦手なキーの集計用）
    expectedKey() {
      const g = this.guide();
      return g.rest[0] || '';
    }

    // 打ち終えたひらがなの文字数
    kanaDone() {
      let n = 0;
      for (let i = 0; i < this.idx; i++) n += Array.from(this.units[i].kana).length;
      return n;
    }
  }

  global.RomajiTyper = Typer;
  global.romajiTokenize = tokenize;
  if (typeof module !== 'undefined') module.exports = { Typer, tokenize };
})(typeof window !== 'undefined' ? window : globalThis);
