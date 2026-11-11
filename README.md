# ニュースタイピング

直近1週間のニュースの要約を打つ、60秒のタイピング練習サイトです。趣味で作っているもので、商用利用はしていません。

## しくみ

- 毎朝7時ごろ（日本時間）にGitHub Actionsが動き、Googleニュース（日本版）のRSSから見出しを集めます。
- Gemini APIの無料枠で、見出しをもとに2〜3文の要約とひらがなの読みを作ります。使えない日は、見出しをそのまま使い、kuromoji で読みを付けます。
- 直近7日分を `site/data/news.json` に保存し、`site/` フォルダをGitHub Pagesで公開します。
- 遊んだ記録は、遊んだ人のブラウザ（localStorage）にだけ保存されます。

## フォルダ

| 場所 | 中身 |
| --- | --- |
| `site/` | 公開するサイト本体（HTML・CSS・JavaScript・ニュースのデータ） |
| `scripts/` | ニュースを更新するスクリプト。配信元は `scripts/feeds.mjs` で変えられます |
| `.github/workflows/update-news.yml` | 毎朝の自動実行と、サイト公開の設定 |

## よく変える場所

- 称号とスコアの区切り：`site/app.js` の `RANKS`
- サイト名：`site/index.html` の `<title>` と、ヘッダーの `wordmark`
- 1日に追加する記事の数・配信元：`scripts/feeds.mjs`

APIキーはリポジトリの Secrets（`GEMINI_API_KEY`）にだけ保存し、ファイルには書きません。
