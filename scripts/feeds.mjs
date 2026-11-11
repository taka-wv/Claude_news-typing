// ニュースの配信元（Googleニュース日本版のRSS）
// ジャンルごとに、1日に追加する記事数（perDay）と、使うRSSのURLを指定します。
// RSSを足したい・入れ替えたいときは、このファイルだけを書き換えれば大丈夫です。

const GN = 'https://news.google.com/rss';
const JP = 'hl=ja&gl=JP&ceid=JP:ja';

export const GENRES = [
  {
    id: 'world',
    name: '国際・政治',
    perDay: 2,
    feeds: [
      `${GN}/headlines/section/topic/WORLD?${JP}`,
      `${GN}/search?q=${encodeURIComponent('政治 when:1d')}&${JP}`,
    ],
  },
  {
    id: 'economy',
    name: '経済',
    perDay: 2,
    feeds: [`${GN}/headlines/section/topic/BUSINESS?${JP}`],
  },
  {
    id: 'tech',
    name: 'テクノロジー',
    perDay: 2,
    feeds: [`${GN}/headlines/section/topic/TECHNOLOGY?${JP}`],
  },
  {
    id: 'science',
    name: '科学・環境',
    perDay: 2,
    feeds: [`${GN}/headlines/section/topic/SCIENCE?${JP}`],
  },
  {
    id: 'culture',
    name: '文化・エンタメ',
    perDay: 2,
    feeds: [`${GN}/headlines/section/topic/ENTERTAINMENT?${JP}`],
  },
];

// 何日分の記事を残すか
export const KEEP_DAYS = 7;
