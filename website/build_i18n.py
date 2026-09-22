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
 ('content="note.md — The markdown editor for humans and agents"',
  'content="note.md — 人与 agent 共用的 markdown 编辑器"',
  'content="note.md — Der Markdown-Editor für Menschen und Agents"',
  'content="note.md — 人間とエージェントのための markdown エディタ"'),
 ('content="Read what your agents write, keep your judgment in plain markdown, and approve which personal memories '
  'become trusted context. Your files stay yours."',
  'content="读 agent 写的东西，把你的判断留在纯 markdown 里，并亲自批准哪些个人记忆可以成为可信上下文。文件始终属于你。"',
  'content="Lies, was deine Agents schreiben, bewahre dein Urteil in reinem Markdown und bestätige selbst, welche '
  'persönlichen Erinnerungen zu vertrauenswürdigem Kontext werden. Deine Dateien bleiben deine."',
  'content="Agent が書いたものを読み、あなたの判断をプレーンな markdown に残し、どの個人メモリを信頼できる文脈にするか自分で承認する。ファイルはいつまでもあなたのもの。"'),
 ('<a href="#features">features</a>',
  '<a href="#features">功能</a>',
  '<a href="#features">funktionen</a>',
  '<a href="#features">機能</a>'),
 ('<a href="#sidecar">sidecar notes</a>',
  '<a href="#sidecar">手记</a>',
  '<a href="#sidecar">randnotizen</a>',
  '<a href="#sidecar">サイドノート</a>'),
 ('<a href="/blog/personal-ai-memory/">memory</a>',
  '<a href="/blog/personal-ai-memory/">记忆</a>',
  '<a href="/blog/personal-ai-memory/">gedächtnis</a>',
  '<a href="/blog/personal-ai-memory/">メモリ</a>'),
 ('<a href="/orchestrate-agents/">for agents</a>',
  '<a href="/orchestrate-agents/">给 agent</a>',
  '<a href="/orchestrate-agents/">für agents</a>',
  '<a href="/orchestrate-agents/">エージェント向け</a>'),
 ('<a href="https://plugins.notemd.net">plugins</a>',
  '<a href="https://plugins.notemd.net">插件</a>',
  '<a href="https://plugins.notemd.net">plugins</a>',
  '<a href="https://plugins.notemd.net">プラグイン</a>'),
 ('"/download">Download</a>',
  '"/download">下载</a>',
  '"/download">Laden</a>',
  '"/download">ダウンロード</a>'),
 ('<span class="kicker">For the age of infinite text</span>',
  '<span class="kicker">无限文本的时代</span>',
  '<span class="kicker">Für das Zeitalter des unendlichen Texts</span>',
  '<span class="kicker">無限のテキストの時代に</span>'),
 ('<h1>Read what AI writes.<br>Keep what <em>you</em> think.<span class="cursor"></span></h1>',
  '<h1>读 AI 写的，<br>留下<em>你想的</em>。<span class="cursor"></span></h1>',
  '<h1>Lies, was KI schreibt.<br>Behalte, was <em>du</em> denkst.<span class="cursor"></span></h1>',
  '<h1>読むのは AI の文。<br>残すのは<em>あなたの考え</em>。<span class="cursor"></span></h1>'),
 ('AI writes more than you can read. note.md is where you get through it: highlight, question, fix it on the spot. '
  'It all lands in the vault your agents share — plain markdown. Agents can notice what matters; only you approve '
  'what becomes memory.',
  'AI 写的，读不完。note.md 让你读得进去：划重点、写疑问、直接改。全部存进你和 Agent 共享的 vault，纯 markdown。Agent 可以发现要紧的事；什么成为记忆，只有你能批准。',
  'KI schreibt mehr, als du lesen kannst. In note.md kommst du durch: markieren, nachfragen, direkt korrigieren. '
  'Alles landet im Vault, den deine Agents teilen — pures Markdown. Agents können erkennen, was wichtig ist; nur du bestätigst, was Erinnerung wird.',
  'AI が書く量は、読み切れない。note.md なら読み進められる。ハイライトして、疑問を書いて、その場で直す。'
  'すべては Agent と共有する Vault に、ただの markdown として残る。Agent は大切なことに気づける。何を記憶にするか承認するのは、あなただけ。'),
 ('12 MB<i>·</i>Typora-compatible themes<i>·</i>Mermaid &amp; Graphviz, tuned<i>·</i>outliner, [[wikilinks]], daily notes'
  '<i>·</i>one vault every agent shares',
  '12 MB<i>·</i>兼容 Typora 主题<i>·</i>Mermaid、Graphviz 都调过<i>·</i>大纲、[[双链]]、每日笔记<i>·</i>一个 vault，所有 agent 共用',
  '12 MB<i>·</i>Typora-kompatible Themes<i>·</i>Mermaid &amp; Graphviz, abgestimmt<i>·</i>Outliner, [[Wikilinks]], Tagesnotizen'
  '<i>·</i>ein Vault für alle Agents',
  '12 MB<i>·</i>Typora 互換テーマ<i>·</i>Mermaid、Graphviz 調整済み<i>·</i>アウトライン、[[ウィキリンク]]、デイリーノート'
  '<i>·</i>一つの vault をすべての agent と'),
 ('<span class="bl">Download for macOS</span>',
  '<span class="bl">下载 macOS 版</span>',
  '<span class="bl">Für macOS laden</span>',
  '<span class="bl">macOS 版をダウンロード</span>'),
 # Swapped in by the inline script for Windows visitors; appears twice.
 ('data-dl-win="Download for Windows"',
  'data-dl-win="下载 Windows 版"',
  'data-dl-win="Für Windows laden"',
  'data-dl-win="Windows 版をダウンロード"'),
 ('data-dl-other="View desktop releases"',
  'data-dl-other="查看桌面版发布"',
  'data-dl-other="Desktop-Releases ansehen"',
  'data-dl-other="デスクトップ版を見る"'),
 ('<span class="bl">Star on GitHub</span>',
  '<span class="bl">GitHub 加星</span>',
  '<span class="bl">Auf GitHub sternen</span>',
  '<span class="bl">GitHub でスター</span>'),
 ('macOS 13+ · free &amp; open · your files stay on your own Mac · <a href="/download?os=mac&amp;arch=x86_64">Intel Mac?</a>'
  ' · <a href="/download?os=windows">Windows?</a>',
  'macOS 13+ · 免费开源 · 文件都在你自己电脑上 · <a href="/download?os=mac&amp;arch=x86_64">Intel 芯片 Mac？</a>'
  ' · <a href="/download?os=windows">Windows？</a>',
  'macOS 13+ · frei &amp; offen · deine Dateien bleiben auf deinem Mac · <a href="/download?os=mac&amp;arch=x86_64">Intel-Mac?</a>'
  ' · <a href="/download?os=windows">Windows?</a>',
  'macOS 13+ · 無料＆オープン · ファイルはあなたの Mac の中に · <a href="/download?os=mac&amp;arch=x86_64">Intel Mac は？</a>'
  ' · <a href="/download?os=windows">Windows は？</a>'),
 ('Windows 10/11 x64 · free &amp; open · Windows releases can trail macOS, and some native plugins are macOS-only · <a href="/download?os=mac">Mac?</a>',
  'Windows 10/11 x64 · 免费开源 · Windows 发布可能落后于 macOS，部分原生插件仅支持 macOS · <a href="/download?os=mac">Mac？</a>',
  'Windows 10/11 x64 · frei &amp; offen · Windows-Releases können macOS hinterherhinken; einige native Plugins gibt es nur für macOS · <a href="/download?os=mac">Mac?</a>',
  'Windows 10/11 x64 · 無料＆オープン · Windows 版は macOS 版より遅れる場合があり、一部のネイティブプラグインは macOS 専用 · <a href="/download?os=mac">Mac は？</a>'),
 ('Desktop app for macOS 13+ and Windows 10/11 x64 · Linux, mobile, and Windows ARM builds are not currently published',
  '桌面应用支持 macOS 13+ 与 Windows 10/11 x64 · 暂不发布 Linux、移动端或 Windows ARM 版本',
  'Desktop-App für macOS 13+ und Windows 10/11 x64 · derzeit keine Builds für Linux, Mobilgeräte oder Windows ARM',
  'デスクトップアプリは macOS 13+ と Windows 10/11 x64 対応 · Linux、モバイル、Windows ARM 版は現在未提供'),
 ('<div class="sec-k">Five things</div>',
  '<div class="sec-k">五件事</div>',
  '<div class="sec-k">Fünf Dinge</div>',
  '<div class="sec-k">五つのこと</div>'),
 # ---- claim 01 ----
 ('<h2>AI handles the writing.<br>This handles the reading.</h2>',
  '<h2>写，交给 AI。<br>读，交给这里。</h2>',
  '<h2>Die KI schreibt.<br>Hier liest du.</h2>',
  '<h2>書くのは AI。<br>読むのは、ここ。</h2>'),
 ('Preview and source, one key apart. Typora-compatible themes work as they are. Mermaid, Graphviz and math, all '
  'tuned. The whole app installs at ~19 MB, with no browser engine inside.',
  '预览与源码，一键之隔。兼容 Typora 的主题拿来就用。Mermaid、Graphviz、公式，都调过。整个应用安装后约 19 MB，没有浏览器内核。',
  'Vorschau und Quelltext, eine Taste auseinander. Typora-kompatible Themes laufen, wie sie sind. Mermaid, '
  'Graphviz und Formeln — alles abgestimmt. Installiert braucht die ganze App rund 19 MB, ohne Browser-Engine im Bauch.',
  'プレビューとソースは、キー一つ隣。Typora 互換テーマは、そのまま使える。Mermaid も Graphviz も数式も、調整済み。インストール後も約 19 MB、ブラウザエンジンは入っていない。'),
 ('A shaky line? Highlight it. A doubt? In the margin. Wrong? Fix it on the spot.',
  '可疑的句子，划出来。疑问，写在旁边。错了，当场改。',
  'Eine wacklige Zeile? Markieren. Ein Zweifel? An den Rand. Falsch? Sofort korrigieren.',
  '怪しい一文は、ハイライト。疑問は、余白に。間違いは、その場で。'),
 ('Claude, Codex and OpenClaw all have a chat window. None of them is made for reading.',
  'Claude、Codex、OpenClaw 都有聊天窗口。没有一个是为读而做的。',
  'Claude, Codex und OpenClaw haben alle ein Chatfenster. Keines davon ist zum Lesen gemacht.',
  'Claude も Codex も OpenClaw も、チャット窓は持っている。でも、読むためのものではない。'),
 # ---- claim 02 ----
 ('<h2>The best of the last<br>generation. Built in.</h2>',
  '<h2>上一代的精华，<br>全都内置。</h2>',
  '<h2>Das Beste der letzten<br>Generation. Eingebaut.</h2>',
  '<h2>前世代の良いところは、<br>全部内蔵。</h2>'),
 ('local-first · git sync · outliner · [[wikilinks]] · backlinks · wiki pages · daily notes · plugins',
  '本地优先 · git 同步 · 大纲 · [[双链]] · 反向链接 · wiki 页面 · 每日笔记 · 插件',
  'local-first · Git-Sync · Outliner · [[Wikilinks]] · Backlinks · Wiki-Seiten · Tagesnotizen · Plugins',
  'ローカル優先 · git 同期 · アウトライナー · [[ウィキリンク]] · バックリンク · wiki ページ · デイリーノート · プラグイン'),
 ('Roam and Obsidian worked this out years ago. note.md puts it back into files. One plugin brings your '
  'whole Roam graph over. An Obsidian vault just opens.',
  '这些事，Roam 和 Obsidian 早就想明白了。note.md 把它们放回文件里。一个插件，搬来整个 Roam 图谱；Obsidian 的 vault，直接打开。',
  'Roam und Obsidian hatten das vor Jahren heraus. note.md legt es zurück in Dateien. Ein Plugin holt deinen '
  'ganzen Roam-Graphen herüber. Ein Obsidian-Vault geht einfach auf.',
  'Roam と Obsidian は、とっくに答えを出していた。note.md はそれをファイルに戻す。プラグイン一つで Roam のグラフを丸ごと移せる。Obsidian の vault は、そのまま開く。'),
 # ---- claim 03 ----
 ('<h2>Agent-ready by design.<br>Use the AI you already have.</h2>',
  '<h2>为 AI Agent 原生设计。<br>用你已经在用的 AI。</h2>',
  '<h2>Von Grund auf Agent-ready.<br>Mit der KI, die du schon nutzt.</h2>',
  '<h2>AIエージェントを前提に設計。<br>いつものAIを、そのまま。</h2>'),
 ('Built-in agent workflows use the agents, AI subscriptions, API accounts, or local runtimes you already have. '
  'note.md sells no tokens, adds no token markup, and charges no separate per-token fee.',
  '内置 Agent 工作流复用你已有的 Agent、AI 订阅、API 账户或本地运行环境。note.md 不另售 Token，不对 Token 加价，也不另收一份按 Token 计费的使用费。',
  'Die integrierten Agent-Workflows nutzen deine vorhandenen Agents, KI-Abos, API-Zugänge oder deine lokale Laufzeitumgebung. '
  'note.md verkauft keine Tokens, schlägt nichts auf Tokenpreise auf und berechnet keine separate Tokengebühr.',
  '内蔵のエージェントワークフローは、すでに利用中のエージェント、AIサブスクリプション、APIアカウント、またはローカル実行環境をそのまま使います。'
  'note.md 独自のトークン販売、価格上乗せ、従量課金はありません。'),
 ("Model usage still follows your chosen provider's plan, limits, and billing — or your own local compute.",
  '实际模型用量与限制仍按你所选服务的订阅额度、API 计费执行；本地模型使用你自己的算力。',
  'Für Modellnutzung, Limits und mögliche Kosten gelten weiterhin dein gewählter Anbieter beziehungsweise deine lokale Umgebung.',
  'モデルの利用量・制限・料金は、選択したサービスのプランまたはローカル環境に従います。'),
 ('Your folder is the workspace every AI tool shares. Cowork, Claude Code, Codex, DeepSeek, ChatGPT, OpenClaw, Hermes — same '
  'files, same house rules, all in git. '
  '<a href="/orchestrate-agents/">See how</a>.',
  '你的文件夹，就是所有 AI 工具共用的工作台。Cowork、Claude Code、Codex、DeepSeek、ChatGPT、OpenClaw、Hermes——同一批文件，同一套规矩，'
  '全在 git 里。<a href="/orchestrate-agents/">看怎么做</a>。',
  'Dein Ordner ist der Arbeitsplatz, den alle KI-Tools teilen. Cowork, Claude Code, Codex, DeepSeek, ChatGPT, OpenClaw, Hermes '
  '— dieselben Dateien, dieselben Hausregeln, alles in Git. '
  '<a href="/orchestrate-agents/">So geht\'s</a>.',
  'あなたのフォルダは、どの AI ツールも共有する作業台。Cowork、Claude Code、Codex、DeepSeek、ChatGPT、OpenClaw、Hermes——同じファイル、'
  '同じルール、すべて git の中。<a href="/orchestrate-agents/">やり方を見る</a>。'),
 ('Every file it writes follows <a href="https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md">Open '
  'Knowledge Format</a> v0.2, strictly: what a document is, where it came from, who checked it — plain YAML at the top '
  'of the file. Any tool can read your vault. Not just this one.',
  '它写出的每一个文件，都严格遵循 <a href="https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md">Open '
  'Knowledge Format</a> v0.2：这是什么、从哪来、谁确认过——就写在文件开头的 YAML 里。你的 vault，任何工具都读得懂，不止这一个。',
  'Jede Datei, die es schreibt, folgt strikt dem <a href="https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md">Open '
  'Knowledge Format</a> v0.2: was ein Dokument ist, woher es kommt, wer es geprüft hat — schlichtes YAML am Anfang der '
  'Datei. Jedes Werkzeug kann deinen Vault lesen. Nicht nur dieses.',
  '書き出すファイルはすべて <a href="https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md">Open '
  'Knowledge Format</a> v0.2 に厳密に従う。何の文書か、どこから来たか、誰が確認したか——ファイル冒頭のただの YAML に。'
  'あなたの vault は、どのツールからでも読める。これだけではなく。'),
 ("Built-in agents, without a second token meter. Change AI tools whenever you want. What's yours stays yours.",
  '内置 Agent，不多一层 Token 账单。换 AI 工具，随时。你的东西，永远是你的。',
  'Integrierte Agents, ohne zweiten Token-Zähler. Wechsle das KI-Tool, wann du willst. Was deins ist, bleibt deins.',
  '内蔵 Agent に、二重のトークン課金はありません。AI ツールはいつ変えてもいい。あなたのものは、あなたのままです。'),
 # ---- claim 04 ----
 ('<h2>Need something else?<br>Add it.</h2>',
  '<h2>还要什么，<br>自己加。</h2>',
  '<h2>Brauchst du mehr?<br>Bau es dazu.</h2>',
  '<h2>ほかに欲しいものは、<br>自分で足す。</h2>'),
 ('Write a plugin. Add a scheduled job. Hang your skills off it.',
  '写个插件。加个定时任务。挂上你的 skills。',
  'Schreib ein Plugin. Häng einen Cronjob dran. Setz deine Skills obendrauf.',
  'プラグインを書く。定期実行を足す。skills をぶら下げる。'),
 ('Put a <span class="mono-s">?</span> in a sidecar note and Smart Lookup writes a fenced answer beneath it — async, '
  'without touching the source document. You decide whether to adopt it.',
  '在手记里打个 <span class="mono-s">?</span>，Smart Lookup 会异步在下方写入受控答案区块，不碰源文档。要不要采纳，由你决定。',
  'Setz ein <span class="mono-s">?</span> in eine Randnotiz. Smart Lookup schreibt asynchron eine abgegrenzte Antwort '
  'darunter, ohne das Quelldokument zu ändern. Du entscheidest, ob du sie übernimmst.',
  'サイドノートに <span class="mono-s">?</span> を置くと、Smart Lookup が非同期で区切られた回答を直下に書く。元文書には触れない。採用するかは、あなたが決める。'),
 # ---- claim 05 ----
 ('<h2>Agents notice.<br>You decide what becomes memory.</h2>',
  '<h2>Agent 负责发现。<br>什么成为记忆，由你决定。</h2>',
  '<h2>Agents bemerken.<br>Du entscheidest, was Erinnerung wird.</h2>',
  '<h2>Agent が気づく。<br>記憶にするかは、あなたが決める。</h2>'),
 ('Your preferences, boundaries and decisions should not be guessed. An agent finds candidates in the work and '
  'conversations you choose to bring in; note.md gives them back to you one at a time. Only what you confirm becomes '
  'lasting context.',
  '你的偏好、边界和决定，不该靠模型猜。Agent 从你选择带进来的工作与沟通中发现候选；note.md 一条一条交给你判断。只有你确认的，才成为长期上下文。',
  'Deine Vorlieben, Grenzen und Entscheidungen sollten nicht erraten werden. Ein Agent findet Kandidaten in der Arbeit und den Gesprächen, die du bewusst einbringst; note.md legt sie dir einzeln vor. Nur was du bestätigst, wird dauerhafter Kontext.',
  'あなたの好み、境界、決定を、モデルの推測に任せてはいけない。Agent はあなたが選んで持ち込んだ仕事や会話から候補を見つけ、note.md が一つずつ提示する。あなたが確認したものだけが、長く使われる文脈になる。'),
 ('Search finds what you wrote. Memory governs what an agent may believe about you — and what it may act on. note.md '
  'keeps those jobs separate on purpose.',
  '搜索帮 agent 找到你写过的资料。Memory 决定它可以相信哪些关于你的主张，又可以据此做什么。note.md 刻意把两件事分开。',
  'Die Suche findet, was du geschrieben hast. Memory regelt, was ein Agent über dich annehmen darf — und wonach er handeln darf. note.md trennt diese Aufgaben bewusst.',
  '検索は、あなたが書いた資料を見つける。Memory は、Agent があなたについて何を信頼し、何に基づいて行動してよいかを管理する。note.md はこの二つを意図して分けている。'),
 ('<a href="/blog/personal-ai-memory/">Why trustworthy personal memory needs your yes →</a>',
  '<a href="/blog/personal-ai-memory/">可信的个人记忆，为什么必须由你点头 →</a>',
  '<a href="/blog/personal-ai-memory/">Warum verlässliches persönliches Gedächtnis dein Ja braucht →</a>',
  '<a href="/blog/personal-ai-memory/">信頼できる個人メモリに、なぜあなたの確認が必要なのか →</a>'),
 ('<div class="sec-k">New in v6.904–v6.921</div>',
  '<div class="sec-k">v6.904–v6.921 新功能</div>',
  '<div class="sec-k">Neu in v6.904–v6.921</div>',
  '<div class="sec-k">v6.904–v6.921 の新機能</div>'),
 ('<h2>Read in the right view.</h2>', '<h2>用合适的视图阅读。</h2>', '<h2>Lies in der passenden Ansicht.</h2>', '<h2>内容に合う表示で読む。</h2>'),
 ('Navigate long files with the table of contents, browse structured notes as Timeline or Index views, explore links '
  'in Knowledge Browser, and page through <code>*.typeset.md</code> books.',
  '用目录导航长文，以时间线或索引视图浏览结构化笔记，在知识浏览器中探索链接，并以分页排版阅读 <code>*.typeset.md</code> 书籍。',
  'Navigiere lange Dateien über das Inhaltsverzeichnis, lies strukturierte Notizen als Timeline oder Index, erkunde '
  'Links im Knowledge Browser und blättere durch <code>*.typeset.md</code>-Bücher.',
  '目次で長文を移動し、構造化ノートをタイムラインや索引で見て、Knowledge Browser でリンクを探索し、<code>*.typeset.md</code> の本をページ表示で読める。'),
 ('<h2>Bring more into the vault.</h2>', '<h2>把更多资料带进 vault。</h2>', '<h2>Bring mehr in den Vault.</h2>', '<h2>さらに多くを Vault へ。</h2>'),
 ('Sync Apple Notes and Roam Research, archive Meetings, and keep Assistant Mail as local records. Availability depends '
  'on platform; current Apple Notes and other native packages may be macOS-only.',
  '同步 Apple Notes 与 Roam Research，归档会议，并把 Assistant Mail 留作本地记录。功能可用性取决于平台；当前 Apple Notes 等原生插件可能仅支持 macOS。',
  'Synchronisiere Apple Notes und Roam Research, archiviere Meetings und bewahre Assistant Mail lokal auf. Die '
  'Verfügbarkeit hängt von der Plattform ab; Apple Notes und andere native Pakete können derzeit macOS vorbehalten sein.',
  'Apple Notes と Roam Research を同期し、会議をアーカイブし、Assistant Mail をローカル記録として残せる。利用可否はプラットフォーム依存で、Apple Notes など一部のネイティブパッケージは現在 macOS 専用。'),
 ('<h2>Think spatially.</h2>', '<h2>在空间中思考。</h2>', '<h2>Denke räumlich.</h2>', '<h2>空間で考える。</h2>'),
 ('Open JSON Canvas files, format JSON, keep imported sources read-only, and let untitled notes and canvases receive '
  'stable names when you save.',
  '打开 JSON Canvas、格式化 JSON、让导入来源保持只读；无标题笔记和画布会在保存时获得稳定文件名。',
  'Öffne JSON Canvas-Dateien, formatiere JSON, halte importierte Quellen schreibgeschützt und gib unbenannten Notizen '
  'und Canvases beim Speichern stabile Namen.',
  'JSON Canvas を開き、JSON を整形し、取り込んだソースを読み取り専用に保てる。無題のノートやキャンバスには保存時に安定した名前が付く。'),
 ('<h2>Agents propose. You approve.</h2>', '<h2>Agent 提议，由你批准。</h2>', '<h2>Agents schlagen vor. Du bestätigst.</h2>', '<h2>Agent が提案し、あなたが承認する。</h2>'),
 ('Smart Lookup returns governed answers, Memory applies role and scope, Conversation Transcript Corrections keeps human '
  'approval in the loop, and plugin installs hot-reload without restarting the app.',
  'Smart Lookup 返回受控答案，Memory 应用角色与范围，沟通转写勘误保留人工批准；插件安装与更新无需重启即可热加载。',
  'Smart Lookup liefert kontrollierte Antworten, Memory wendet Rolle und Geltungsbereich an, Gesprächstranskript-Korrekturen '
  'behalten die menschliche Freigabe bei, und Plugins werden ohne App-Neustart neu geladen.',
  'Smart Lookup は管理された回答を返し、Memory は役割と範囲を適用し、会話文字起こし訂正は人の承認を維持する。プラグインはアプリを再起動せず再読み込みされる。'),
 ('<div class="sec-k">The trick</div>',
  '<div class="sec-k">关键</div>',
  '<div class="sec-k">Der Trick</div>',
  '<div class="sec-k">仕組み</div>'),
 ("<h2>AI text is infinite.<br>Your attention isn't.</h2>",
  '<h2>AI 的文字无限。<br>你的注意力有限。</h2>',
  '<h2>KI-Text ist unendlich.<br>Deine Aufmerksamkeit nicht.</h2>',
  '<h2>AI のテキストは無限。<br>あなたの注意力は違う。</h2>'),
 ('Every document gets a note file of its own. What the AI wrote stays on one side. What you think stays on the other.',
  '每篇文档，配一个笔记文件。AI 写的归一边，你想的归另一边。',
  'Jedes Dokument bekommt seine eigene Notizdatei. Was die KI schrieb, bleibt auf der einen Seite. Was du denkst, auf '
  'der anderen.',
  'どの文書にも、専用のノートファイルがつく。AI が書いたものはこちら。あなたが考えたことはあちら。'),
 ('<span class="ft">The document. An AI wrote it, and can write it again tomorrow.</span>',
  '<span class="ft">文档。AI 写的，明天还能再写一份。</span>',
  '<span class="ft">Das Dokument. Eine KI hat es geschrieben und kann es morgen neu schreiben.</span>',
  '<span class="ft">ドキュメント。AI が書いた。明日また書ける。</span>'),
 ('<span class="ft">Your highlights, doubts and questions. This part, no model can write.</span>',
  '<span class="ft">你的高亮、疑问和判断。这部分，AI 写不出来。</span>',
  '<span class="ft">Deine Markierungen, Zweifel und Fragen. Diesen Teil kann kein Modell schreiben.</span>',
  '<span class="ft">あなたのハイライト、疑問、問い。ここだけは、どのモデルにも書けない。</span>'),
 ('Ten thousand words? Anyone can generate those. Your take, nobody can. <b>And it\'s sitting on your '
  'own disk.</b>',
  '一万字，谁都能生成。你的看法，谁也生成不了。<b>而它就在你自己的硬盘里。</b>',
  'Zehntausend Wörter? Kann jeder generieren. Deine Sicht, niemand. <b>Und sie liegt auf deiner eigenen Platte.</b>',
  '一万語なら、誰でも生成できる。あなたの見方は、誰にも。<b>そしてそれは、あなた自身のディスクの中に。</b>'),
 ('<span class="star">✦</span> what AI writes',
  '<span class="star">✦</span> AI 写的',
  '<span class="star">✦</span> was die KI schreibt',
  '<span class="star">✦</span> AI が書いたもの'),
 ('<span class="pt"></span> what you think',
  '<span class="pt"></span> 你想的',
  '<span class="pt"></span> was du denkst',
  '<span class="pt"></span> あなたの考え'),
 ('<h2>Own your thinking.</h2>', '<h2>拥有你的思考。</h2>', '<h2>Besitze dein Denken.</h2>', '<h2>思考を所有せよ。</h2>'),
 ("Free. Open. A folder on your own computer. That's it.",
  '免费。开源。就是你自己电脑上的一个文件夹。',
  'Kostenlos. Offen. Ein Ordner auf deinem eigenen Rechner. Mehr nicht.',
  '無料。オープン。あなた自身のパソコンにあるフォルダ一つ。それだけ。'),
 ('macOS 13 or later · Apple Silicon &amp; <a href="/download?os=mac&amp;arch=x86_64">Intel</a>'
  ' · also on <a href="/download?os=windows">Windows</a> · some native plugins are macOS-only · from GitHub Releases',
  'macOS 13 或更高 · Apple Silicon 与 <a href="/download?os=mac&amp;arch=x86_64">Intel</a>'
  ' · 也有 <a href="/download?os=windows">Windows</a> 版 · 部分原生插件仅支持 macOS · 从 GitHub Releases 获取',
  'macOS 13 oder neuer · Apple Silicon &amp; <a href="/download?os=mac&amp;arch=x86_64">Intel</a>'
  ' · auch für <a href="/download?os=windows">Windows</a> · einige native Plugins nur für macOS · von GitHub Releases',
  'macOS 13 以降 · Apple Silicon &amp; <a href="/download?os=mac&amp;arch=x86_64">Intel</a>'
  ' · <a href="/download?os=windows">Windows</a> 版もあり · 一部のネイティブプラグインは macOS 専用 · GitHub Releases から'),
 ('Windows 10/11 x64 · releases can trail macOS · some native plugins are macOS-only · also on <a href="/download?os=mac">macOS</a> 13+ · from GitHub Releases',
  'Windows 10/11 x64 · 发布可能落后于 macOS · 部分原生插件仅支持 macOS · 也有 <a href="/download?os=mac">macOS</a> 13+ 版 · 从 GitHub Releases 获取',
  'Windows 10/11 x64 · Releases können macOS hinterherhinken · einige native Plugins nur für macOS · auch für <a href="/download?os=mac">macOS</a> 13+ · von GitHub Releases',
  'Windows 10/11 x64 · macOS 版より遅れる場合あり · 一部のネイティブプラグインは macOS 専用 · <a href="/download?os=mac">macOS</a> 13+ 版もあり · GitHub Releases から'),
 ('Desktop only · macOS 13+ and Windows 10/11 x64 · no Linux, mobile, or Windows ARM build is currently published',
  '仅桌面端 · macOS 13+ 与 Windows 10/11 x64 · 暂不发布 Linux、移动端或 Windows ARM 版本',
  'Nur Desktop · macOS 13+ und Windows 10/11 x64 · derzeit keine Builds für Linux, Mobilgeräte oder Windows ARM',
  'デスクトップのみ · macOS 13+ と Windows 10/11 x64 · Linux、モバイル、Windows ARM 版は現在未提供'),
 ('Written and maintained entirely by AI coding. Reviewed and tested by a human before every release.',
  '代码全部由 AI 写，也由 AI 维护。每次发布前，都有人亲自审、亲自测。',
  'Vollständig per AI-Coding geschrieben und gepflegt. Vor jedem Release von einem Menschen geprüft und getestet.',
  'コードはすべて AI が書き、AI が保守する。リリースのたびに、人がレビューしてテストしている。'),
 ("Text is cheap now. What you thought about it isn't.",
  '文字现在很便宜。你的看法不便宜。',
  'Text ist jetzt billig. Was du darüber dachtest, nicht.',
  'テキストはもう安い。それをどう思ったかは、安くない。'),
 ('<b>Compare</b>', '<b>对比</b>', '<b>Vergleich</b>', '<b>比較</b>'),
 ('<b>Integrations</b>', '<b>集成</b>', '<b>Integrationen</b>', '<b>連携</b>'),
 ('<b>Guides</b>', '<b>指南</b>', '<b>Anleitungen</b>', '<b>ガイド</b>'),
 ('>Personal AI memory you confirm</a>',
  '>由你确认的个人 AI 记忆</a>',
  '>Persönliches AI-Gedächtnis, von dir bestätigt</a>',
  '>あなたが確認する個人 AI メモリ</a>'),
 ('>Free sharing on Cloudflare</a>',
  '>Cloudflare 免费分享</a>',
  '>Kostenlos teilen über Cloudflare</a>',
  '>Cloudflare で無料共有</a>'),
 ('>One vault, many agents</a>',
  '>一个 vault，多个 agent</a>',
  '>Ein Vault, viele Agents</a>',
  '>ひとつの Vault、多くのエージェント</a>'),
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

# zh headings are set in Source Han Serif; only the zh page pays for the webfont.
FONTS = {
    "zh": [('&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap',
            '&family=Courier+Prime:ital,wght@0,400;0,700;1,400&family=Noto+Serif+SC:wght@700&display=swap')],
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
    src = src.replace(f'<meta property="og:url" content="{BASE}/">', f'<meta property="og:url" content="{BASE}/{lang}/">')
    for old, new in SWITCH[lang] + FONTS.get(lang, []):
        if old not in src:
            missing.append(old[:60]); continue
        src = src.replace(old, new)
    for seg in ("compare", "integrations", "guides", "blog", "orchestrate-agents"):
        src = src.replace(f'href="/{seg}/', f'href="/{lang}/{seg}/')
    os.makedirs(f"public/{lang}", exist_ok=True)
    open(f"public/{lang}/index.html", "w", encoding="utf-8").write(src)
    print(f"public/{lang}/index.html written" + (f"  ⚠ {len(missing)} unmatched:" if missing else ""))
    for m in missing:
        print("   -", m)
    return not missing

ok = all([build("de"), build("ja"), build("zh")])
sys.exit(0 if ok else 1)
