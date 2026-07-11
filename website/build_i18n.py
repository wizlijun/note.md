#!/usr/bin/env python3
"""Generate static /zh/ and /de/ pages from the English master index.html.

Usage: python3 build_i18n.py   (run inside website/; site lives in public/)

Pure string replacement against the English master — no dependencies.
If you edit English copy in index.html, update the matching source string
here, then re-run. Unmatched strings are reported so drift is loud, not
silent.
"""
import os, sys

BASE = "https://notemd.net"

# (english, chinese, german) — english must match index.html exactly.
STRINGS = [
    # <head>
    ("<title>note.md — The markdown editor for humans and agents</title>",
     "<title>note.md — 人与 agent 共用的 markdown 编辑器</title>",
     "<title>note.md — Der Markdown-Editor für Menschen und Agents</title>"),
    ('content="note.md is a markdown reader and editor for the AI-native era. Agents write, you read and annotate. Your knowledge lives in plain files you own forever."',
     'content="note.md 是为 AI-native 时代打造的 markdown 阅读器与编辑器。agent 写，你读并批注。你的知识存在永远属于你的纯文本文件里。"',
     'content="note.md ist ein Markdown-Reader und -Editor für das KI-Zeitalter. Agents schreiben, du liest und annotierst. Dein Wissen lebt in einfachen Dateien, die dir für immer gehören."'),
    # nav
    ('<a href="#features">features</a>', '<a href="#features">功能</a>', '<a href="#features">funktionen</a>'),
    ('<a href="#sidecar">sidecar notes</a>', '<a href="#sidecar">旁车笔记</a>', '<a href="#sidecar">sidecar-notizen</a>'),
    ('<a href="#agents">for agents</a>', '<a href="#agents">给 agent</a>', '<a href="#agents">für agents</a>'),
    ('note.md/releases">Download</a>', 'note.md/releases">下载</a>', 'note.md/releases">Laden</a>'),
    # hero
    ('<span class="kicker">Built for the age of infinite text</span>',
     '<span class="kicker">为无限文本的时代而造</span>',
     '<span class="kicker">Gebaut für das Zeitalter des unendlichen Texts</span>'),
    ('<h1>Read what AI writes.<br>Keep what <em>you</em> think.<span class="cursor"></span></h1>',
     '<h1>读 AI 写的。<br>留下<em>你</em>想的。<span class="cursor"></span></h1>',
     '<h1>Lies, was die KI schreibt.<br>Behalte, was <em>du</em> denkst.<span class="cursor"></span></h1>'),
    ("Your agents now write more than you ever will. The bottleneck isn't writing anymore — <i>it's reading, judging, keeping.</i> note.md is where that happens. Plain files. No lock-in. Yours.",
     "你的 agent 写得比你一辈子都多。瓶颈不再是写作——<i>而是阅读、判断、留存。</i>note.md 就是干这个的。纯文件，无锁定，属于你。",
     "Deine Agents schreiben längst mehr, als du je wirst. Der Engpass ist nicht mehr das Schreiben — <i>sondern Lesen, Urteilen, Behalten.</i> Genau dafür ist note.md. Einfache Dateien. Kein Lock-in. Deins."),
    ('<span class="bl">Download for macOS</span>', '<span class="bl">下载 macOS 版</span>', '<span class="bl">Für macOS laden</span>'),
    ('<span class="bl">Star on GitHub</span>', '<span class="bl">GitHub 加星</span>', '<span class="bl">Auf GitHub sternen</span>'),
    ('macOS 13+ · free &amp; open · your files stay on your disk',
     'macOS 13+ · 免费开源 · 文件只在你的磁盘上',
     'macOS 13+ · frei &amp; offen · deine Dateien bleiben auf deiner Platte'),
    # features
    ('<div class="sec-k">The pitch</div>', '<div class="sec-k">主张</div>', '<div class="sec-k">Der Pitch</div>'),
    ('<h2>One folder for everything<br>you and your machines write</h2>',
     '<h2>你和机器写下的一切<br>都在一个文件夹里</h2>',
     '<h2>Ein Ordner für alles, was du<br>und deine Maschinen schreiben</h2>'),
    ('A reader, an outliner, and a place for your marginalia — sitting on top of plain files, staying out of your way.',
     '一个阅读器、一个大纲本、一处放批注的地方——架在纯文件之上，绝不碍事。',
     'Ein Reader, ein Outliner und ein Platz für deine Randnotizen — auf einfachen Dateien, ohne dir im Weg zu stehen.'),
    ('<h3>Read like it matters</h3>', '<h3>认真地读</h3>', '<h3>Lesen, als ob es zählt</h3>'),
    ("Your agent wrote four thousand words while you slept. Open them in a clean view, mark what's true, question what isn't. Every mark is kept.",
     '你睡觉时 agent 写了四千字。用干净的视图打开，标出真的，质疑假的。每个标记都留下来。',
     'Dein Agent hat viertausend Wörter geschrieben, während du geschlafen hast. Öffne sie in einer klaren Ansicht, markiere, was stimmt, hinterfrage, was nicht. Jede Markierung bleibt.'),
    ('<h3>Marginalia is data</h3>', '<h3>批注即数据</h3>', '<h3>Randnotizen sind Daten</h3>'),
    ("Your marks live in a partner file: <span class=\"mono-s\">file.note.md</span>. The AI's text stays clean. Your judgment stays yours. Two files. No tangles.",
     '你的标记住在旁车文件里：<span class="mono-s">file.note.md</span>。AI 的文本保持干净，你的判断归你所有。两个文件，互不纠缠。',
     'Deine Markierungen leben in einer Partnerdatei: <span class="mono-s">file.note.md</span>. Der KI-Text bleibt sauber. Dein Urteil bleibt deins. Zwei Dateien. Kein Durcheinander.'),
    ('<h3>Think in outlines</h3>', '<h3>用大纲思考</h3>', '<h3>In Outlines denken</h3>'),
    ('Daily notes for whatever crosses your mind. <span class="mono-s">[[links]]</span> between pages. Search that answers before you finish typing. Ideas connect on their own.',
     '每日笔记随手记，<span class="mono-s">[[链接]]</span> 连接页面，搜索快过你打完字。想法自己会串起来。',
     'Tagesnotizen für alles, was dir durch den Kopf geht. <span class="mono-s">[[Links]]</span> zwischen Seiten. Suche, die antwortet, bevor du fertig getippt hast. Ideen verbinden sich von selbst.'),
    ("<h3>It's just files</h3>", '<h3>就是文件而已</h3>', '<h3>Es sind nur Dateien</h3>'),
    ('No database. No cloud. No exit interview. A folder of markdown that will outlive every app on your dock — including this one.',
     '没有数据库，没有云端，没有"注销流程"。一个 markdown 文件夹，比你 Dock 上的每个应用都活得久——包括这一个。',
     'Keine Datenbank. Keine Cloud. Kein Exit-Interview. Ein Ordner voller Markdown, der jede App in deinem Dock überlebt — diese hier eingeschlossen.'),
    # sidecar
    ('<div class="sec-k">The trick</div>', '<div class="sec-k">戏法</div>', '<div class="sec-k">Der Trick</div>'),
    ("<h2>AI text is infinite.<br>Your attention isn't.</h2>",
     '<h2>AI 的文字无限。<br>你的注意力有限。</h2>',
     '<h2>KI-Text ist unendlich.<br>Deine Aufmerksamkeit nicht.</h2>'),
    ('Every document gets a shadow: a note file of its own. What the machine wrote and what you think, side by side — never tangled.',
     '每篇文档都有一个影子：属于它自己的笔记文件。机器写的和你想的并排存放——永不纠缠。',
     'Jedes Dokument bekommt einen Schatten: eine eigene Notizdatei. Was die Maschine schrieb und was du denkst, Seite an Seite — nie vermischt.'),
    ('<span class="ft">The document. A machine wrote it, and can write it again tomorrow. Cheap, clean, replaceable.</span>',
     '<span class="ft">文档。机器写的，明天还能再写一遍。便宜、干净、可替换。</span>',
     '<span class="ft">Das Dokument. Eine Maschine hat es geschrieben und kann es morgen wieder schreiben. Billig, sauber, ersetzbar.</span>'),
    ('<span class="ft">Your highlights, doubts, and questions — the one thing no model can generate.</span>',
     '<span class="ft">你的高亮、怀疑和问题——唯一没有模型能生成的东西。</span>',
     '<span class="ft">Deine Markierungen, Zweifel und Fragen — das Einzige, was kein Modell generieren kann.</span>'),
    ('Anyone can generate ten thousand words now. No one can generate your opinion of them. The files you marked up are a map of what you actually cared about — <b>the rarest dataset in the world, and it\'s sitting on your disk.</b> note.md ranks it first in search, and your agents read your margins before they write another word.',
     '现在谁都能生成一万字，但没人能生成你对这一万字的看法。你标注过的文件，是你真正在乎什么的地图——<b>世界上最稀有的数据集，就躺在你的磁盘上。</b>note.md 让它在搜索里排最前；你的 agent 在写下一个字之前，先读你的批注。',
     'Zehntausend Wörter kann heute jeder generieren. Deine Meinung dazu kann niemand generieren. Die Dateien, die du markiert hast, sind eine Karte dessen, was dir wirklich wichtig war — <b>der seltenste Datensatz der Welt, und er liegt auf deiner Platte.</b> note.md rankt ihn in der Suche zuerst, und deine Agents lesen deine Randnotizen, bevor sie ein weiteres Wort schreiben.'),
    # agents
    ('<div class="sec-k">For the machines</div>', '<div class="sec-k">给机器们</div>', '<div class="sec-k">Für die Maschinen</div>'),
    ('<h2>Agents are welcome here</h2>', '<h2>欢迎 agent 光临</h2>', '<h2>Agents sind hier willkommen</h2>'),
    ('Plain files, simple rules. Claude Code, Codex, OpenClaw, Hermes — or whatever ships next week. They all speak markdown.',
     '纯文件，简单规则。Claude Code、Codex、OpenClaw、Hermes——或者下周才发布的那个。它们都说 markdown。',
     'Einfache Dateien, einfache Regeln. Claude Code, Codex, OpenClaw, Hermes — oder was nächste Woche erscheint. Sie alle sprechen Markdown.'),
    ("The rules live inside the folder, in a file any agent can read. Point Claude Code at it. Point next year's thing at it. It just works. No plugins, no adapters.",
     '规则就住在文件夹里，写成任何 agent 都能读的文件。把 Claude Code 指过来，把明年的新东西指过来，都能用。不要插件，不要适配器。',
     'Die Regeln leben im Ordner, in einer Datei, die jeder Agent lesen kann. Zeig Claude Code darauf. Zeig das Ding von nächstem Jahr darauf. Es funktioniert einfach. Keine Plugins, keine Adapter.'),
    ('<h3>Memory that compounds</h3>', '<h3>会复利的记忆</h3>', '<h3>Gedächtnis mit Zinseszins</h3>'),
    ("Your daily notes double as your agent's memory. It searches years of your thinking — and quotes you back to yourself, with receipts.",
     '你的每日笔记就是 agent 的记忆。它能搜遍你多年的思考——再把你的话引用给你听，带出处。',
     'Deine Tagesnotizen sind zugleich das Gedächtnis deines Agents. Er durchsucht Jahre deines Denkens — und zitiert dich dir selbst, mit Beleg.'),
    ('<h3>Write → read → learn</h3>', '<h3>写 → 读 → 学</h3>', '<h3>Schreiben → Lesen → Lernen</h3>'),
    ('Agents write. You mark what matters. Agents read your marks and write better. The whole loop is a few files long and runs on your disk.',
     'agent 写，你标出重要的，agent 读你的标记然后写得更好。整个循环就几个文件长，跑在你的磁盘上。',
     'Agents schreiben. Du markierst, was zählt. Agents lesen deine Markierungen und schreiben besser. Die ganze Schleife ist ein paar Dateien lang und läuft auf deiner Platte.'),
    ('<span class="star">✦</span> what AI writes', '<span class="star">✦</span> AI 写的', '<span class="star">✦</span> was die KI schreibt'),
    ('<span class="pt"></span> what you think', '<span class="pt"></span> 你想的', '<span class="pt"></span> was du denkst'),
    # download
    ('<h2>Own your thinking.</h2>', '<h2>拥有你的思考。</h2>', '<h2>Besitze dein Denken.</h2>'),
    ("Free. Open. A folder of markdown on your Mac. That's the whole architecture.",
     '免费。开源。你 Mac 上的一个 markdown 文件夹。这就是全部架构。',
     'Frei. Offen. Ein Ordner voller Markdown auf deinem Mac. Das ist die ganze Architektur.'),
    ('macOS 13 or later · Apple Silicon &amp; Intel · from GitHub Releases',
     'macOS 13 或更高 · Apple Silicon 与 Intel · 从 GitHub Releases 获取',
     'macOS 13 oder neuer · Apple Silicon &amp; Intel · von GitHub Releases'),
    # footer
    ('Text is forever. So is what you thought about it.',
     '文字永存。你对它的看法也是。',
     'Text ist für immer. Was du darüber dachtest, auch.'),
]

# per-language structural swaps: lang attr, canonical, active switcher
STRUCT = {
    "zh": [
        ('<html lang="en">', '<html lang="zh">'),
        (f'<link rel="canonical" href="{BASE}/">', f'<link rel="canonical" href="{BASE}/zh/">'),
        ('<a href="/" class="on">EN</a>\n      <a href="/zh/">中文</a>',
         '<a href="/">EN</a>\n      <a href="/zh/" class="on">中文</a>'),
    ],
    "de": [
        ('<html lang="en">', '<html lang="de">'),
        (f'<link rel="canonical" href="{BASE}/">', f'<link rel="canonical" href="{BASE}/de/">'),
        ('<a href="/" class="on">EN</a>', '<a href="/">EN</a>'),
        ('<a href="/de/">DE</a>', '<a href="/de/" class="on">DE</a>'),
    ],
}

def build(lang, idx):
    src = open("public/index.html", encoding="utf-8").read()
    missing = []
    for row in STRINGS:
        en, target = row[0], row[idx]
        if en not in src:
            missing.append(en[:60])
            continue
        src = src.replace(en, target)
    for old, new in STRUCT[lang]:
        if old not in src:
            missing.append(old[:60])
            continue
        src = src.replace(old, new)
    os.makedirs(f"public/{lang}", exist_ok=True)
    open(f"public/{lang}/index.html", "w", encoding="utf-8").write(src)
    print(f"public/{lang}/index.html written" + (f"  ⚠ {len(missing)} unmatched:" if missing else ""))
    for m in missing:
        print("   -", m)
    return not missing

ok = build("zh", 1) & build("de", 2)
sys.exit(0 if ok else 1)
