#!/usr/bin/env python3
"""Generate static /de/ /ja/ /zh/ homepages from the English master public/index.html.

Usage: python3 build_i18n.py   (run inside website/; site lives in public/)
Rows are (en, zh, de, ja); en must match public/index.html exactly.
Unmatched strings are reported loudly."""
import os, sys

BASE = "https://notemd.net"

STRINGS = [('<title>note.md — The markdown editor for humans and agents</title>',
  '<title>note.md — 人与 agent 共用的 markdown 编辑器</title>',
  '<title>note.md — Der Markdown-Editor für Menschen und Agents</title>',
  '<title>note.md — 人間とエージェントのための markdown エディタ</title>'),
 ('content="note.md is a markdown reader and editor for the AI-native era. Agents write, you read and annotate. Your '
  'knowledge lives in plain files you own forever."',
  'content="note.md 是为 AI-native 时代打造的 markdown 阅读器与编辑器。agent 写，你读并批注。你的知识存在永远属于你的纯文本文件里。"',
  'content="note.md ist ein Markdown-Reader und -Editor für das KI-Zeitalter. Agents schreiben, du liest und '
  'annotierst. Dein Wissen lebt in einfachen Dateien, die dir für immer gehören."',
  'content="note.md は AI ネイティブ時代のための markdown リーダー＆エディタ。エージェントが書き、あなたが読んで書き込む。知識は、永遠にあなたのものであるプレーンなファイルに宿る。"'),
 ('<a href="#features">features</a>',
  '<a href="#features">功能</a>',
  '<a href="#features">funktionen</a>',
  '<a href="#features">機能</a>'),
 ('<a href="#sidecar">sidecar notes</a>',
  '<a href="#sidecar">伴生笔记</a>',
  '<a href="#sidecar">sidecar-notizen</a>',
  '<a href="#sidecar">サイドカーノート</a>'),
 ('<a href="#agents">for agents</a>',
  '<a href="#agents">给 agent</a>',
  '<a href="#agents">für agents</a>',
  '<a href="#agents">エージェント向け</a>'),
 ('"/download">Download</a>',
  '"/download">下载</a>',
  '"/download">Laden</a>',
  '"/download">ダウンロード</a>'),
 ('<span class="kicker">Built for the age of infinite text</span>',
  '<span class="kicker">为无限文本的时代而造</span>',
  '<span class="kicker">Gebaut für das Zeitalter des unendlichen Texts</span>',
  '<span class="kicker">無限のテキストの時代のために</span>'),
 ('<h1>Read what AI writes.<br>Keep what <em>you</em> think.<span class="cursor"></span></h1>',
  '<h1>读 AI 写的。<br>留下<em>你</em>想的。<span class="cursor"></span></h1>',
  '<h1>Lies, was die KI schreibt.<br>Behalte, was <em>du</em> denkst.<span class="cursor"></span></h1>',
  '<h1>読むのは AI の文章。<br>残すのは<em>あなた</em>の考え。<span class="cursor"></span></h1>'),
 ("Your agents now write more than you ever will. The bottleneck isn't writing anymore — <i>it's reading, judging, "
  'keeping.</i> note.md is where that happens. Plain files. No lock-in. Yours.',
  '你的 agent 写得比你一辈子都多。瓶颈不再是写作——<i>而是阅读、判断、留存。</i>note.md 就是干这个的。纯文件，无锁定，属于你。',
  'Deine Agents schreiben längst mehr, als du je wirst. Der Engpass ist nicht mehr das Schreiben — <i>sondern Lesen, '
  'Urteilen, Behalten.</i> Genau dafür ist note.md. Einfache Dateien. Kein Lock-in. Deins.',
  'エージェントはもう、あなたが一生で書く量より多くを書いている。ボトルネックは「書くこと」ではない——<i>読むこと、判断すること、残すこと。</i>そのための note.md。プレーンなファイル。ロックインなし。あなたのもの。'),
 ('<span class="bl">Download for macOS</span>',
  '<span class="bl">下载 macOS 版</span>',
  '<span class="bl">Für macOS laden</span>',
  '<span class="bl">macOS 版をダウンロード</span>'),
 ('<span class="bl">Star on GitHub</span>',
  '<span class="bl">GitHub 加星</span>',
  '<span class="bl">Auf GitHub sternen</span>',
  '<span class="bl">GitHub でスター</span>'),
 ('macOS 13+ · free &amp; open · your files stay on your disk · <a href="/download?arch=x86_64">Intel Mac?</a>',
  'macOS 13+ · 免费开源 · 文件只在你的磁盘上 · <a href="/download?arch=x86_64">Intel 芯片 Mac？</a>',
  'macOS 13+ · frei &amp; offen · deine Dateien bleiben auf deiner Platte · <a href="/download?arch=x86_64">Intel-Mac?</a>',
  'macOS 13+ · 無料＆オープン · ファイルはあなたのディスクに · <a href="/download?arch=x86_64">Intel Mac は？</a>'),
 ('<div class="sec-k">The pitch</div>',
  '<div class="sec-k">主张</div>',
  '<div class="sec-k">Der Pitch</div>',
  '<div class="sec-k">ピッチ</div>'),
 ('<h2>One folder for everything<br>you and your agents write</h2>',
  '<h2>你和 agent 写下的一切<br>都在一个文件夹里</h2>',
  '<h2>Ein Ordner für alles, was du<br>und deine Agents schreiben</h2>',
  '<h2>あなたとエージェントが書くすべてを<br>ひとつのフォルダに</h2>'),
 ('A reader, an outliner, and a place for your marginalia — sitting on top of plain files, staying out of your way.',
  '一个阅读器、一个大纲本、一处放批注的地方——架在纯文件之上，绝不碍事。',
  'Ein Reader, ein Outliner und ein Platz für deine Randnotizen — auf einfachen Dateien, ohne dir im Weg zu stehen.',
  'リーダー、アウトライナー、そして書き込みの置き場所——プレーンなファイルの上で、邪魔にならない。'),
 ('<h3>Read like it matters</h3>', '<h3>认真地读</h3>', '<h3>Lesen, als ob es zählt</h3>', '<h3>読むに値する読み方</h3>'),
 ("Your agent wrote 4,000 words overnight. Open them clean, mark what's true, question the rest.",
  '你睡觉时 agent 写了四千字。干净地打开，标出真的，质疑其余。',
  'Dein Agent hat über Nacht 4.000 Wörter geschrieben. Öffne sie sauber, markiere, was stimmt, hinterfrage den Rest.',
  '眠っている間にエージェントが四千語を書いた。クリーンに開き、正しいものに印を、残りに問いを。'),
 ('<h3>Marginalia is data</h3>', '<h3>批注即数据</h3>', '<h3>Randnotizen sind Daten</h3>', '<h3>余白のメモはデータだ</h3>'),
 ('Your marks live in a partner file — <span class="mono-s">file.note.md</span>. The AI\'s text stays clean; your '
  'judgment stays yours.',
  '你的标记存放在伴生文件（sidecar）中——<span class="mono-s">file.note.md</span>。AI 的文本保持干净，你的判断归你所有。',
  'Deine Markierungen leben in einer Partnerdatei — <span class="mono-s">file.note.md</span>. Der KI-Text bleibt '
  'sauber; dein Urteil bleibt deins.',
  '印は相棒のサイドカーファイル <span class="mono-s">file.note.md</span> に入る。AI のテキストはクリーンなまま、あなたの判断はあなたのもの。'),
 ('<h3>Think in outlines</h3>', '<h3>用大纲思考</h3>', '<h3>In Outlines denken</h3>', '<h3>アウトラインで考える</h3>'),
 ('Daily notes, <span class="mono-s">[[links]]</span> between pages, search that answers as you type. Ideas connect '
  'themselves.',
  '每日笔记随手记，<span class="mono-s">[[链接]]</span> 连接页面，搜索边打边答。想法自己会串起来。',
  'Tagesnotizen, <span class="mono-s">[[Links]]</span> zwischen Seiten, Suche, die schon beim Tippen antwortet. Ideen '
  'verbinden sich von selbst.',
  'デイリーノート、ページをつなぐ <span class="mono-s">[[リンク]]</span>、打ちながら答える検索。アイデアは勝手につながる。'),
 ("<h3>It's just files</h3>", '<h3>就是文件而已</h3>', '<h3>Es sind nur Dateien</h3>', '<h3>ただのファイル</h3>'),
 ('No database. No cloud. A folder of markdown that outlives every app on your dock — including this one.',
  '没有数据库，没有云端。一个 markdown 文件夹，比你 Dock 上的每个应用都活得久——包括这一个。',
  'Keine Datenbank. Keine Cloud. Ein Ordner voller Markdown, der jede App in deinem Dock überlebt — diese hier '
  'eingeschlossen.',
  'データベースなし。クラウドなし。Dock のどのアプリより長生きする markdown のフォルダ——このアプリも含めて。'),
 ('<div class="sec-k">The trick</div>',
  '<div class="sec-k">戏法</div>',
  '<div class="sec-k">Der Trick</div>',
  '<div class="sec-k">からくり</div>'),
 ("<h2>AI text is infinite.<br>Your attention isn't.</h2>",
  '<h2>AI 的文字无限。<br>你的注意力有限。</h2>',
  '<h2>KI-Text ist unendlich.<br>Deine Aufmerksamkeit nicht.</h2>',
  '<h2>AI のテキストは無限。<br>あなたの注意力は違う。</h2>'),
 ('Every document gets a shadow: a note file of its own. What the agent wrote and what you think, side by side — never '
  'tangled.',
  '每篇文档都有一个影子：属于它自己的笔记文件。agent 写的和你想的并排存放——永不纠缠。',
  'Jedes Dokument bekommt einen Schatten: eine eigene Notizdatei. Was der Agent schrieb und was du denkst, Seite an '
  'Seite — nie vermischt.',
  'すべてのドキュメントに影がひとつ：専用のノートファイル。エージェントが書いたものと、あなたが考えたこと。並んで、決して混ざらない。'),
 ('<span class="ft">The document. An agent wrote it, and can write it again tomorrow. Cheap, clean, '
  'replaceable.</span>',
  '<span class="ft">文档。agent 写的，明天还能再写一遍。便宜、干净、可替换。</span>',
  '<span class="ft">Das Dokument. Ein Agent hat es geschrieben und kann es morgen wieder schreiben. Billig, sauber, '
  'ersetzbar.</span>',
  '<span class="ft">ドキュメント。エージェントが書いた。明日また書ける。安く、クリーンで、置き換え可能。</span>'),
 ('<span class="ft">Your highlights, doubts, and questions — the one thing no model can generate.</span>',
  '<span class="ft">你的高亮、怀疑和问题——唯一没有模型能生成的东西。</span>',
  '<span class="ft">Deine Markierungen, Zweifel und Fragen — das Einzige, was kein Modell generieren kann.</span>',
  '<span class="ft">あなたのハイライト、疑問、問い——どのモデルにも生成できない唯一のもの。</span>'),
 ('Anyone can generate ten thousand words. No one can generate your opinion of them — <b>the rarest dataset in the '
  "world, and it's sitting on your disk.</b>",
  '现在谁都能生成一万字，但没人能生成你对这一万字的看法——<b>世界上最稀有的数据集，就躺在你的磁盘上。</b>',
  'Zehntausend Wörter kann jeder generieren. Deine Meinung dazu kann niemand generieren — <b>der seltenste Datensatz '
  'der Welt, und er liegt auf deiner Platte.</b>',
  '一万語なら誰でも生成できる。だが、それについてのあなたの意見は誰にも生成できない——<b>世界で最も希少なデータセットが、あなたのディスクに眠っている。</b>'),
 ('<div class="sec-k">For agents</div>',
  '<div class="sec-k">给 agent</div>',
  '<div class="sec-k">Für Agents</div>',
  '<div class="sec-k">エージェントたちへ</div>'),
 ('<h2>Agents are welcome here</h2>',
  '<h2>欢迎 agent 光临</h2>',
  '<h2>Agents sind hier willkommen</h2>',
  '<h2>エージェント、歓迎。</h2>'),
 ('Plain files, simple rules. Claude Code, Codex, OpenClaw, Hermes — or whatever ships next week. They all speak '
  'markdown.',
  '纯文件，简单规则。Claude Code、Codex、OpenClaw、Hermes——或者下周才发布的那个。它们都说 markdown。',
  'Einfache Dateien, einfache Regeln. Claude Code, Codex, OpenClaw, Hermes — oder was nächste Woche erscheint. Sie '
  'alle sprechen Markdown.',
  'プレーンなファイル、シンプルなルール。Claude Code、Codex、OpenClaw、Hermes——来週出る何かでも。みんな markdown を話す。'),
 ("The rules live in the folder, in a file any agent reads. Point Claude Code — or next year's agent — at it. No "
  'plugins, no adapters.',
  '规则就住在文件夹里，写成任何 agent 都能读的文件。把 Claude Code——或者明年的新 agent——指过来就行。不要插件，不要适配器。',
  'Die Regeln leben im Ordner, in einer Datei, die jeder Agent liest. Zeig Claude Code — oder den Agent von nächstem '
  'Jahr — darauf. Keine Plugins, keine Adapter.',
  'ルールはフォルダの中、どのエージェントでも読めるファイルにある。Claude Code——来年の新顔でも——を向けるだけ。プラグインもアダプタも不要。'),
 ('<h3>Memory that compounds</h3>', '<h3>会复利的记忆</h3>', '<h3>Gedächtnis mit Zinseszins</h3>', '<h3>複利で増える記憶</h3>'),
 ("Your daily notes are your agent's memory — years of your thinking, searchable, quoted back to you with receipts.",
  '你的每日笔记就是 agent 的记忆——多年的思考，可搜索，还带出处引用给你听。',
  'Deine Tagesnotizen sind das Gedächtnis deines Agents — Jahre deines Denkens, durchsuchbar, mit Beleg an dich '
  'zurückzitiert.',
  'デイリーノートはエージェントの記憶——何年分もの思考が検索でき、出典つきであなたに引用し返される。'),
 ('<h3>Write → read → learn</h3>',
  '<h3>写 → 读 → 学</h3>',
  '<h3>Schreiben → Lesen → Lernen</h3>',
  '<h3>書く → 読む → 学ぶ</h3>'),
 ('Agents write. You mark what matters. They read your marks and write better — the whole loop runs on your disk.',
  'agent 写，你标出重要的，它读你的标记然后写得更好——整个循环都跑在你的磁盘上。',
  'Agents schreiben. Du markierst, was zählt. Sie lesen deine Markierungen und schreiben besser — die ganze Schleife '
  'läuft auf deiner Platte.',
  'エージェントが書く。あなたが大事な箇所に印をつける。エージェントが印を読み、もっとうまく書く——ループ全体があなたのディスクの上で回る。'),
 ('<span class="star">✦</span> what AI writes',
  '<span class="star">✦</span> AI 写的',
  '<span class="star">✦</span> was die KI schreibt',
  '<span class="star">✦</span> AI が書いたもの'),
 ('<span class="pt"></span> what you think',
  '<span class="pt"></span> 你想的',
  '<span class="pt"></span> was du denkst',
  '<span class="pt"></span> あなたの考え'),
 ('<h2>Own your thinking.</h2>', '<h2>拥有你的思考。</h2>', '<h2>Besitze dein Denken.</h2>', '<h2>思考を所有せよ。</h2>'),
 ("Free. Open. A folder of markdown on your Mac. That's the whole architecture.",
  '免费。开源。你 Mac 上的一个 markdown 文件夹。这就是全部架构。',
  'Frei. Offen. Ein Ordner voller Markdown auf deinem Mac. Das ist die ganze Architektur.',
  '無料。オープン。あなたの Mac にある markdown フォルダ。アーキテクチャはそれだけ。'),
 ('macOS 13 or later · Apple Silicon &amp; <a href="/download?arch=x86_64">Intel</a> · from GitHub Releases',
  'macOS 13 或更高 · Apple Silicon 与 <a href="/download?arch=x86_64">Intel</a> · 从 GitHub Releases 获取',
  'macOS 13 oder neuer · Apple Silicon &amp; <a href="/download?arch=x86_64">Intel</a> · von GitHub Releases',
  'macOS 13 以降 · Apple Silicon &amp; <a href="/download?arch=x86_64">Intel</a> · GitHub Releases から'),
 ('Text is forever. So is what you thought about it.',
  '文字永存。你对它的看法也是。',
  'Text ist für immer. Was du darüber dachtest, auch.',
  'テキストは永遠に残る。あなたがそれについて考えたことも。'),
 ('<b>Compare</b>', '<b>对比</b>', '<b>Vergleich</b>', '<b>比較</b>'),
 ('<b>Integrations</b>', '<b>集成</b>', '<b>Integrationen</b>', '<b>連携</b>'),
 ('<b>Guides</b>', '<b>指南</b>', '<b>Anleitungen</b>', '<b>ガイド</b>'),
 ('>Free sharing on Cloudflare</a>',
  '>Cloudflare 免费分享</a>',
  '>Kostenlos teilen über Cloudflare</a>',
  '>Cloudflare で無料共有</a>'),
 ('>Vault on GitHub</a>', '>GitHub 托管 vault</a>', '>Vault auf GitHub</a>', '>GitHub で Vault をホスト</a>')]

COL = {"zh": 1, "de": 2, "ja": 3}

SWITCH = {
    "de": [('<a href="/" class="on">EN</a>', '<a href="/">EN</a>'),
           ('<a href="/de/">DE</a>', '<a href="/de/" class="on">DE</a>')],
    "ja": [('<a href="/" class="on">EN</a>', '<a href="/">EN</a>'),
           ('<a href="/ja/">日本語</a>', '<a href="/ja/" class="on">日本語</a>')],
    "zh": [('<a href="/" class="on">EN</a>', '<a href="/">EN</a>'),
           ('<a href="/zh/">中文</a>', '<a href="/zh/" class="on">中文</a>')],
}

def build(lang):
    idx = COL[lang]
    src = open("public/index.html", encoding="utf-8").read()
    missing = []
    for row in STRINGS:
        en, target = row[0], row[idx]
        if en not in src:
            missing.append(en[:60]); continue
        src = src.replace(en, target)
    src = src.replace('<html lang="en">', f'<html lang="{lang}">')
    src = src.replace(f'<link rel="canonical" href="{BASE}/">', f'<link rel="canonical" href="{BASE}/{lang}/">')
    for old, new in SWITCH[lang]:
        if old not in src:
            missing.append(old[:60]); continue
        src = src.replace(old, new)
    for seg in ("compare", "integrations", "guides"):
        src = src.replace(f'href="/{seg}/', f'href="/{lang}/{seg}/')
    os.makedirs(f"public/{lang}", exist_ok=True)
    open(f"public/{lang}/index.html", "w", encoding="utf-8").write(src)
    print(f"public/{lang}/index.html written" + (f"  ⚠ {len(missing)} unmatched:" if missing else ""))
    for m in missing:
        print("   -", m)
    return not missing

ok = all([build("de"), build("ja"), build("zh")])
sys.exit(0 if ok else 1)
