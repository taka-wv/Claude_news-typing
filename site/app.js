/* ニュースタイピング 本体 */
(function () {
  'use strict';

  const PLAY_SECONDS = 60;
  const STORE_KEY = 'newsTyping:v1';
  const HISTORY_MAX = 200;
  const RECENT_MAX = 300; // 最近打った記事として覚えておく数

  // 称号（スコアの区切りはここで調整できます）
  const RANKS = [
    { min: 380, letter: 'S', title: '特ダネ王', color: 'var(--g-economy)' },
    { min: 290, letter: 'A', title: '編集長', color: 'var(--g-culture)' },
    { min: 200, letter: 'B', title: 'デスク', color: 'var(--g-science)' },
    { min: 120, letter: 'C', title: '記者', color: 'var(--g-world)' },
    { min: 0, letter: 'D', title: '見習い記者', color: 'var(--g-tech)' },
  ];

  // コンボ数で文字の色が変わる
  const COMBO_LEVELS = [
    { min: 100, color: 'var(--g-economy)' },
    { min: 50, color: 'var(--g-culture)' },
    { min: 30, color: 'var(--g-science)' },
    { min: 10, color: 'var(--g-world)' },
    { min: 0, color: 'var(--g-tech)' },
  ];

  const GENRE_COLOR = {
    world: 'var(--g-world)', economy: 'var(--g-economy)', tech: 'var(--g-tech)',
    science: 'var(--g-science)', culture: 'var(--g-culture)',
  };

  const KEY_ROWS = ['1234567890-^', 'qwertyuiop@[', 'asdfghjkl;:]', 'zxcvbnm,./'];

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'style') n.style.cssText = props[k];
      else n.setAttribute(k, props[k]);
    }
    for (const c of [].concat(children)) if (c != null) n.append(c);
    return n;
  };

  // ---------- 保存（このブラウザの中だけ） ----------
  const defaultStore = () => ({ settings: { sound: true, volume: 60, genres: null }, history: [], keyMiss: {}, recent: [] });
  let store = defaultStore();
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        store = { ...defaultStore(), ...s, settings: { ...defaultStore().settings, ...(s.settings || {}) } };
      }
    } catch (e) { store = defaultStore(); }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 保存できない環境では何もしない */ }
  }

  // ---------- 効果音（ブラウザの中で合成） ----------
  const Sound = {
    ctx: null, master: null, noise: null,
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.setVolume(store.settings.volume);
      const len = Math.floor(this.ctx.sampleRate * 0.05);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    },
    setVolume(v) { if (this.master) this.master.gain.value = (v / 100) * 0.9; },
    on() { return store.settings.sound && this.ctx; },
    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    // カチッとした打鍵音：短いノイズ＋低い「コトッ」
    click() {
      if (!this.on()) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.9 + Math.random() * 0.25;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 1.2;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.55, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      src.connect(bp).connect(g).connect(this.master);
      src.start(t);
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(190, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.03);
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.35, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
      o.connect(g2).connect(this.master);
      o.start(t); o.stop(t + 0.04);
    },
    tone(freq, start, dur, type = 'sine', vol = 0.25) {
      const t = this.ctx.currentTime + start;
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
    },
    miss() {
      if (!this.on()) return;
      this.tone(130, 0, 0.11, 'square', 0.12);
    },
    complete() {
      if (!this.on()) return;
      this.tone(988, 0, 0.12, 'sine', 0.18);
      this.tone(1319, 0.07, 0.2, 'sine', 0.16);
    },
    count() { if (this.on()) this.tone(660, 0, 0.12, 'sine', 0.15); },
    go() { if (this.on()) this.tone(990, 0, 0.18, 'sine', 0.18); },
    finish() {
      if (!this.on()) return;
      [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.09, 0.28, 'triangle', 0.16));
    },
  };

  // ---------- データ ----------
  let data = { genres: [], articles: [] };

  async function loadData() {
    try {
      const res = await fetch(`data/news.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      const d = data.updatedDate ? new Date(`${data.updatedDate}T00:00:00+09:00`) : null;
      const sample = data.articles.every((a) => a.method === 'sample');
      $('dataStatus').textContent = sample
        ? 'いまはサンプルの文章です（最初のニュース更新を待っています）'
        : `${d ? `${d.getMonth() + 1}月${d.getDate()}日` : ''}更新／${data.articles.length}本のニュース`;
    } catch (e) {
      $('dataStatus').textContent = 'ニュースを読み込めませんでした。ページを再読み込みしてください。';
      data = { genres: [], articles: [] };
    }
    renderStart();
  }

  // ---------- 画面切り替え ----------
  let screen = 'start';
  function show(name) {
    screen = name;
    for (const s of ['start', 'play', 'result', 'records']) $(`screen-${s}`).hidden = s !== name;
    if (name === 'start') renderStart();
    if (name === 'records') renderRecords();
    window.scrollTo(0, 0);
  }

  // ---------- スタート画面 ----------
  function selectedGenres() {
    const all = data.genres.map((g) => g.id);
    const saved = store.settings.genres;
    return saved ? all.filter((g) => saved.includes(g)) : all;
  }

  function renderStart() {
    const list = $('genreList');
    list.textContent = '';
    const sel = selectedGenres();
    for (const g of data.genres) {
      const n = data.articles.filter((a) => a.genre === g.id).length;
      const input = el('input', { type: 'checkbox', value: g.id });
      input.checked = sel.includes(g.id);
      input.addEventListener('change', onGenreChange);
      list.append(el('label', { class: 'genre-chip', style: `--c:${GENRE_COLOR[g.id] || 'var(--ink-faint)'}` }, [
        input, el('span', { class: 'dot', 'aria-hidden': 'true' }), g.name, el('span', { class: 'count', text: `${n}本` }),
      ]));
    }
    updateStartButton();

    const best = bestRecord();
    $('bestBox').textContent = '';
    if (best) {
      $('bestBox').append('自己ベスト ', el('strong', { text: String(best.score) }), el('span', { class: 'best-title', text: rankOf(best.score).title }));
    } else {
      $('bestBox').textContent = 'まだ記録がありません。最初の1回をどうぞ。';
    }

    renderLadder($('startLadder'), [{ score: best ? best.score : null, tag: '自己ベスト' }]);

    $('soundToggle').checked = store.settings.sound;
    $('volume').value = store.settings.volume;

    const pv = $('previewList');
    pv.textContent = '';
    const genreName = Object.fromEntries(data.genres.map((g) => [g.id, g.name]));
    const seen = new Set();
    for (const a of data.articles) {
      if (seen.has(a.genre)) continue;
      seen.add(a.genre);
      pv.append(el('li', { style: `--c:${GENRE_COLOR[a.genre] || 'var(--ink-faint)'}` }, [
        el('span', { class: 'pv-genre', text: genreName[a.genre] || '' }), a.headline || a.text,
      ]));
      if (seen.size >= 3) break;
    }
  }

  function onGenreChange() {
    const checked = [...document.querySelectorAll('#genreList input:checked')].map((i) => i.value);
    store.settings.genres = checked;
    saveStore();
    updateStartButton();
  }

  function playableArticles() {
    const sel = selectedGenres();
    return data.articles.filter((a) => sel.includes(a.genre) && a.reading);
  }

  function updateStartButton() {
    const n = playableArticles().length;
    const btn = $('startBtn');
    btn.disabled = n === 0;
    btn.firstChild.textContent = n === 0 ? 'ジャンルを1つ以上選んでください' : 'スタート';
  }

  // ---------- プレイ ----------
  const game = {
    state: 'idle', // idle | countdown | playing
    queue: [], current: null, typer: null,
    correct: 0, miss: 0, combo: 0, maxCombo: 0,
    keyMiss: {}, typed: [], startAt: 0, raf: 0, timers: [],
  };

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // まだ打っていない記事を先に、最近打った記事ほど後ろに並べる
  function buildQueue() {
    const pool = playableArticles();
    const recent = store.recent || [];
    const pos = new Map(recent.map((id, i) => [id, i]));
    const fresh = shuffle(pool.filter((a) => !pos.has(a.id)));
    const played = pool.filter((a) => pos.has(a.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    return fresh.concat(played);
  }

  function markPlayed(a) {
    if (!a || !a.id) return;
    store.recent = (store.recent || []).filter((id) => id !== a.id);
    store.recent.push(a.id);
    if (store.recent.length > RECENT_MAX) store.recent = store.recent.slice(-RECENT_MAX);
  }

  function startGame() {
    const pool = playableArticles();
    if (!pool.length) return;
    Sound.init();
    Sound.resume();
    Object.assign(game, {
      state: 'countdown', queue: buildQueue(), current: null, typer: null,
      correct: 0, miss: 0, combo: 0, maxCombo: 0, keyMiss: {}, typed: [],
    });
    show('play');
    $('timeLeft').textContent = String(PLAY_SECONDS);
    $('timerFill').style.transform = 'scaleX(1)';
    $('timeLeft').parentElement.classList.remove('is-low');
    updateHud();
    nextArticle();

    const cd = $('countdown');
    const num = $('countNum');
    cd.hidden = false;
    let n = 3;
    const tick = () => {
      if (game.state !== 'countdown') return;
      if (n === 0) {
        cd.hidden = true;
        Sound.go();
        game.state = 'playing';
        game.startAt = performance.now();
        loop();
        return;
      }
      num.textContent = String(n);
      num.style.animation = 'none';
      void num.offsetWidth;
      num.style.animation = '';
      Sound.count();
      n--;
      game.timers.push(setTimeout(tick, 800));
    };
    tick();
  }

  function stopTimers() {
    cancelAnimationFrame(game.raf);
    game.timers.forEach(clearTimeout);
    game.timers = [];
  }

  function abortGame() {
    stopTimers();
    game.state = 'idle';
    $('countdown').hidden = true;
    show('start');
  }

  function loop() {
    const elapsed = (performance.now() - game.startAt) / 1000;
    const left = Math.max(0, PLAY_SECONDS - elapsed);
    $('timeLeft').textContent = String(Math.ceil(left));
    $('timerFill').style.transform = `scaleX(${left / PLAY_SECONDS})`;
    $('timeLeft').parentElement.classList.toggle('is-low', left <= 10);
    if (elapsed >= 1) $('liveKpm').textContent = String(Math.round((game.correct / elapsed) * 60));
    if (left <= 0) return finishGame();
    game.raf = requestAnimationFrame(loop);
  }

  function nextArticle() {
    if (!game.queue.length) game.queue = buildQueue();
    const a = game.queue.shift();
    game.current = a;
    game.typer = new window.RomajiTyper(a.reading);
    const genreName = (data.genres.find((g) => g.id === a.genre) || {}).name || '';
    $('telop').style.setProperty('--c', GENRE_COLOR[a.genre] || 'var(--ink)');
    $('telopGenre').textContent = genreName;
    $('telopSource').textContent = a.source || '';
    $('lineText').textContent = a.text;
    const nx = game.queue[0];
    $('nextUp').textContent = nx ? `次の記事：${nx.headline || nx.text}` : '';
    renderLine();
  }

  function comboColor() {
    return COMBO_LEVELS.find((l) => game.combo >= l.min).color;
  }

  // ひらがなとローマ字の表示を更新
  function renderLine(flag) {
    const t = game.typer;
    const kanaAll = Array.from(game.current.reading);
    const kDone = t.kanaDone();
    const kana = $('lineKana');
    kana.textContent = '';
    kana.append(el('span', { class: 'done', text: kanaAll.slice(0, kDone).join('') }), kanaAll.slice(kDone).join(''));

    // ローマ字は、句読点で区切った今のかたまりだけを出す
    const units = t.units;
    let s = 0;
    for (let i = 0; i < t.idx; i++) if (/[、。]$/.test(units[i].kana)) s = i + 1;
    let e = units.length;
    for (let i = Math.max(t.idx, s); i < units.length; i++) if (/[、。]$/.test(units[i].kana)) { e = i + 1; break; }
    let done = '';
    for (let i = s; i < t.idx; i++) done += t.done[i];
    let cur = '';
    let rest = '';
    if (!t.finished) {
      const g = t._unitGuide(t.idx, t.buf);
      done += t.buf;
      let r = g.slice(t.buf.length);
      for (let i = t.idx + 1; i < e; i++) r += t._unitGuide(i, '');
      // 「ん」を n 1回で済ませられる場面では、次の文字が「今打つ文字」になる
      if (!r && e < units.length) r = t._unitGuide(e, '');
      cur = r[0] || '';
      rest = r.slice(1);
    }
    const rom = $('lineRomaji');
    rom.textContent = '';
    const curEl = el('span', { class: `cur${flag ? ` ${flag}` : ''}`, text: cur });
    rom.append(el('span', { class: 'done', text: done }), curEl, rest);
    document.documentElement.style.setProperty('--combo', comboColor());
  }

  function updateHud() {
    $('liveMiss').textContent = String(game.miss);
    $('liveCombo').textContent = String(game.combo);
  }

  function onPlayKey(key) {
    const t = game.typer;
    const expected = t.expectedKey();
    const r = t.input(key);
    if (r.ok) {
      game.correct++;
      game.combo++;
      if (game.combo > game.maxCombo) game.maxCombo = game.combo;
      Sound.click();
      if ([10, 30, 50, 100].includes(game.combo)) {
        const box = $('comboBox');
        box.classList.remove('bump');
        void box.offsetWidth;
        box.classList.add('bump');
      }
      if (t.finished) {
        Sound.complete();
        game.typed.push({ article: game.current, complete: true });
        markPlayed(game.current);
        nextArticle();
      } else {
        renderLine('pop');
      }
    } else {
      game.miss++;
      game.combo = 0;
      if (expected) game.keyMiss[expected] = (game.keyMiss[expected] || 0) + 1;
      Sound.miss();
      renderLine('miss');
    }
    updateHud();
  }

  // ---------- 結果 ----------
  function rankOf(score) {
    return RANKS.find((r) => score >= r.min);
  }

  function bestRecord() {
    return store.history.reduce((b, h) => (!b || h.score > b.score ? h : b), null);
  }

  function finishGame() {
    stopTimers();
    game.state = 'idle';
    Sound.finish();
    if (game.typer && game.typer.idx > 0 && !game.typer.finished) {
      game.typed.push({ article: game.current, complete: false });
      markPlayed(game.current);
    }
    const total = game.correct + game.miss;
    const acc = total ? game.correct / total : 0;
    const kpm = Math.round(game.correct * (60 / PLAY_SECONDS));
    const score = Math.round(kpm * acc * acc);
    const rank = rankOf(score);
    const prevBest = bestRecord();
    const isBest = !prevBest || score > prevBest.score;

    store.history.push({ t: Date.now(), score, kpm, acc: Math.round(acc * 1000) / 10, miss: game.miss, maxCombo: game.maxCombo });
    if (store.history.length > HISTORY_MAX) store.history = store.history.slice(-HISTORY_MAX);
    for (const k in game.keyMiss) store.keyMiss[k] = (store.keyMiss[k] || 0) + game.keyMiss[k];
    saveStore();

    show('result');
    const box = $('rankBox');
    $('screen-result').querySelector('.result-hero').style.setProperty('--c', rank.color);
    $('rankLetter').textContent = rank.letter;
    box.classList.remove('reveal');
    void box.offsetWidth;
    box.classList.add('reveal');
    $('rankTitle').textContent = rank.title;
    $('scoreNum').textContent = String(score);
    $('newBest').hidden = !(isBest && total > 0);
    $('rKpm').textContent = String(kpm);
    $('rAcc').textContent = (acc * 100).toFixed(1);
    $('rMiss').textContent = String(game.miss);
    $('rCombo').textContent = String(game.maxCombo);

    const bestNow = bestRecord();
    const marks = [{ score, tag: '今回' }];
    if (bestNow && !(isBest && total > 0)) marks.push({ score: bestNow.score, tag: '自己ベスト' });
    renderLadder($('resultLadder'), marks);

    renderKeyboard($('resultKeyboard'), $('weakList'), game.keyMiss, 'ミスはありませんでした。');

    const list = $('typedList');
    list.textContent = '';
    if (!game.typed.length) list.append(el('li', { text: '今回は1本も打ち終えませんでした。' }));
    const genreName = Object.fromEntries(data.genres.map((g) => [g.id, g.name]));
    for (const { article: a, complete } of game.typed) {
      const head = a.url
        ? el('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', text: a.headline || a.text })
        : el('span', { text: a.headline || a.text });
      list.append(el('li', {}, [
        head,
        complete ? null : el('span', { class: 'partial', text: '途中まで' }),
        el('span', { class: 't-meta', text: [genreName[a.genre], a.source].filter(Boolean).join('／') }),
      ]));
    }
  }

  // キーボード図に、ミスの多いキーを色で示す
  function renderKeyboard(container, listEl, counts, emptyText) {
    container.textContent = '';
    const max = Math.max(0, ...Object.values(counts));
    for (const row of KEY_ROWS) {
      const r = el('div', { class: 'kb-row' });
      for (const k of row) {
        const n = counts[k] || 0;
        const heat = max ? n / max : 0;
        const key = el('div', {
          class: `kb-key${n ? ' hot' : ''}${heat > 0.6 ? ' hot-strong' : ''}`,
          style: `--heat:${n ? 0.18 + heat * 0.82 : 0}`,
          title: n ? `${k}：${n}回` : k,
          text: k,
        });
        r.append(key);
      }
      container.append(r);
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    listEl.textContent = '';
    if (!top.length) {
      listEl.textContent = emptyText;
      return;
    }
    top.forEach(([k, n], i) => {
      if (i) listEl.append('、');
      listEl.append(el('b', { text: k === ' ' ? 'space' : k }), `${n}回`);
    });
  }

  // 称号の一覧（下から順に5段）。marks の1つ目を「いまの位置」として強調する
  function renderLadder(box, marks) {
    box.textContent = '';
    const main = marks[0] && marks[0].score != null ? marks[0] : null;
    const cur = main ? rankOf(main.score) : null;
    box.append(el('h2', { class: 'ladder-head', text: '称号の一覧' }));
    const list = el('ol', { class: 'ladder-list' });
    for (const r of RANKS.slice().reverse()) {
      const i = RANKS.indexOf(r);
      const range = i > 0 ? `${r.min}〜${RANKS[i - 1].min - 1}点` : `${r.min}点以上`;
      const tags = marks.filter((m) => m.score != null && rankOf(m.score) === r);
      const li = el('li', { class: `rung${r === cur ? ' is-current' : ''}`, style: `--c:${r.color}` }, [
        el('span', { class: 'rung-letter', text: r.letter }),
        el('span', { class: 'rung-title', text: r.title }),
        el('span', { class: 'rung-range', text: range }),
      ]);
      if (r === cur) li.setAttribute('aria-current', 'true');
      if (tags.length) {
        const t = el('span', { class: 'rung-tags' });
        for (const m of tags) t.append(el('span', { class: `rung-tag${m === main ? '' : ' is-sub'}`, text: m.tag }));
        li.prepend(t);
      }
      list.append(li);
    }
    box.append(list);

    // 次の称号までの距離
    const note = el('p', { class: 'ladder-note' });
    if (!cur) {
      note.textContent = 'スコアに応じて、5段階の称号が決まります。';
    } else {
      const next = RANKS[RANKS.indexOf(cur) - 1];
      if (!next) {
        note.textContent = `${main.tag}は最高の称号「${cur.title}」です。`;
      } else {
        const span = next.min - cur.min;
        const pct = Math.max(0, Math.min(100, ((main.score - cur.min) / span) * 100));
        note.append(
          `${main.tag}から次の「${next.title}」まで、あと `,
          el('strong', { text: String(next.min - main.score) }),
          ' 点',
          el('span', { class: 'ladder-bar', 'aria-hidden': 'true' }, [el('span', { style: `width:${pct}%;--c:${next.color}` })]),
        );
      }
    }
    box.append(note);
  }

  // ---------- 記録画面 ----------
  function renderRecords() {
    const best = bestRecord();
    const rb = $('recordsBest');
    rb.textContent = '';
    if (!best) {
      rb.append(el('p', { class: 'empty-text', text: 'まだ記録がありません。1回遊ぶと、ここに自己ベストが表示されます。' }));
    } else {
      const bestKpm = Math.max(...store.history.map((h) => h.kpm));
      const bestAcc = Math.max(...store.history.map((h) => h.acc));
      rb.append(
        el('div', {}, [el('span', { text: '自己ベスト' }), el('strong', { text: String(best.score) })]),
        el('div', {}, [el('span', { text: '称号' }), el('strong', { class: 'rb-title', text: rankOf(best.score).title })]),
        el('div', {}, [el('span', { text: '最高の打鍵速度' }), el('strong', { text: `${bestKpm}` }), ' 打/分']),
        el('div', {}, [el('span', { text: '最高の正確さ' }), el('strong', { text: `${bestAcc}` }), ' %']),
        el('div', {}, [el('span', { text: '遊んだ回数' }), el('strong', { text: String(store.history.length) }), ' 回']),
      );
    }

    renderChart();
    renderKeyboard($('allKeyboard'), $('allWeakList'), store.keyMiss, 'まだミスの記録はありません。');

    const tb = $('historyBody');
    tb.textContent = '';
    const recent = store.history.slice(-50).reverse();
    if (!recent.length) {
      tb.append(el('tr', {}, [el('td', { colspan: '5', class: 'empty-text', text: 'まだ記録がありません。' })]));
    }
    for (const h of recent) {
      const d = new Date(h.t);
      const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      tb.append(el('tr', {}, [
        el('td', { text: when }), el('td', { text: String(h.score) }), el('td', { text: rankOf(h.score).title }),
        el('td', { text: `${h.kpm} 打/分` }), el('td', { text: `${h.acc}%` }),
      ]));
    }
    $('resetConfirm').hidden = true;
    $('resetBtn').hidden = false;
  }

  function dayKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function renderChart() {
    const box = $('chart');
    box.textContent = '';
    const since = Date.now() - 30 * 864e5;
    const byDay = new Map();
    for (const h of store.history) {
      if (h.t < since) continue;
      const k = dayKey(h.t);
      byDay.set(k, Math.max(byDay.get(k) || 0, h.score));
    }
    const pts = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (pts.length < 2) {
      box.append(el('p', { class: 'empty', text: '2日以上遊ぶと、ここにスコアの推移が表示されます。' }));
      return;
    }
    const W = 820, H = 240, L = 48, R = 20, T = 20, B = 36;
    const maxS = Math.max(100, ...pts.map((p) => p[1]));
    const top = Math.ceil(maxS / 100) * 100;
    const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '日ごとの自己ベストの推移');
    const add = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text != null) n.textContent = text;
      svg.append(n);
      return n;
    };
    for (let v = 0; v <= top; v += top / 4) {
      add('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#e8dcc6', 'stroke-width': 1 });
      add('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#5d6680' }, String(v));
    }
    const step = Math.max(1, Math.ceil(pts.length / 8));
    pts.forEach((p, i) => {
      if (i % step === 0 || i === pts.length - 1) {
        const [, m, d] = p[0].split('-');
        add('text', { x: x(i), y: H - 12, 'text-anchor': 'middle', 'font-size': 12, fill: '#5d6680' }, `${Number(m)}/${Number(d)}`);
      }
    });
    add('polyline', { points: pts.map((p, i) => `${x(i)},${y(p[1])}`).join(' '), fill: 'none', stroke: '#4c8ddb', 'stroke-width': 3, 'stroke-linejoin': 'round' });
    pts.forEach((p, i) => {
      const c = add('circle', { cx: x(i), cy: y(p[1]), r: 5, fill: '#fffdf8', stroke: '#4c8ddb', 'stroke-width': 3 });
      const tt = document.createElementNS(ns, 'title');
      tt.textContent = `${p[0]}：${p[1]}`;
      c.append(tt);
    });
    box.append(svg);
  }

  // ---------- キー操作 ----------
  let imeTimer = 0;
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.key === 'Process') {
      if (screen === 'play') {
        $('imeToast').hidden = false;
        clearTimeout(imeTimer);
        imeTimer = setTimeout(() => { $('imeToast').hidden = true; }, 3500);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (screen === 'play') {
      if (e.key === 'Escape') { e.preventDefault(); abortGame(); return; }
      if (game.state !== 'playing') return;
      if (e.key.length !== 1) return;
      e.preventDefault();
      if (e.key === ' ') return;
      $('imeToast').hidden = true;
      onPlayKey(e.key);
      return;
    }
    if (screen === 'start' && e.key === ' ' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      if (!$('startBtn').disabled) startGame();
      return;
    }
    if (screen === 'result') {
      if ((e.key === ' ' || e.key === 'Enter') && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
        e.preventDefault();
        startGame();
      } else if (e.key === 'Escape') {
        show('start');
      }
    }
  });

  // ---------- ボタン ----------
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      e.preventDefault();
      if (screen === 'play') abortGame();
      show(go.dataset.go);
    }
  });
  $('startBtn').addEventListener('click', startGame);
  $('againBtn').addEventListener('click', startGame);
  $('soundToggle').addEventListener('change', (e) => {
    store.settings.sound = e.target.checked;
    saveStore();
    if (e.target.checked) { Sound.init(); Sound.resume(); Sound.click(); }
  });
  $('volume').addEventListener('input', (e) => {
    store.settings.volume = Number(e.target.value);
    Sound.setVolume(store.settings.volume);
  });
  $('volume').addEventListener('change', () => {
    saveStore();
    Sound.init(); Sound.resume(); Sound.click();
  });
  $('resetBtn').addEventListener('click', () => {
    $('resetBtn').hidden = true;
    $('resetConfirm').hidden = false;
    $('resetNo').focus();
  });
  $('resetNo').addEventListener('click', () => {
    $('resetConfirm').hidden = true;
    $('resetBtn').hidden = false;
  });
  $('resetYes').addEventListener('click', () => {
    const settings = store.settings;
    store = defaultStore();
    store.settings = settings;
    saveStore();
    renderRecords();
  });

  // スマホ・タブレットでは案内を出す
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches) {
    $('touchNote').hidden = false;
  }

  loadStore();
  loadData();
})();
