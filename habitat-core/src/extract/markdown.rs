use super::*;
use jieba_rs::Jieba;
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use serde_yaml::Value;
use std::sync::OnceLock;

#[derive(Clone, Default)]
struct Unit {
    start: usize,
    end: usize,
    id: Option<String>,
    by: Option<String>,
    kind: String,
}

fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => vec![s.trim().to_owned()],
        Value::Sequence(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_owned())
            .collect(),
        _ => Vec::new(),
    }
}

fn split_frontmatter(text: &str) -> (Option<&str>, &str, usize) {
    if !text.starts_with("---\n") {
        return (None, text, 1);
    }
    let mut offset = 4;
    for line in text[4..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            let body = &text[offset + line.len()..];
            return (
                Some(&text[4..offset]),
                body,
                text[..offset + line.len()]
                    .bytes()
                    .filter(|b| *b == b'\n')
                    .count()
                    + 1,
            );
        }
        offset += line.len();
    }
    (None, text, 1)
}

fn outline_units(body: &str, first_line: usize) -> Vec<Unit> {
    let mut units: Vec<Unit> = Vec::new();
    let mut fence = 0;
    for (i, line) in body.lines().enumerate() {
        let number = first_line + i;
        let trimmed = line.trim_start();
        if fence > 0 {
            if let Some(unit) = units.last_mut() {
                unit.end = number;
            }
            let ticks = trimmed.chars().take_while(|c| *c == '`').count();
            if ticks >= fence && trimmed[ticks..].trim().is_empty() {
                fence = 0;
            }
            continue;
        }
        if let Some(content) = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""))
        {
            units.push(Unit {
                start: number,
                end: number,
                ..Unit::default()
            });
            let ticks = content.chars().take_while(|c| *c == '`').count();
            if ticks >= 3 {
                fence = ticks;
            }
        } else if let Some(unit) = units.last_mut() {
            unit.end = number;
            if let Some((key, value)) = trimmed.split_once(":: ") {
                match key {
                    "id" => unit.id = Some(value.trim().into()),
                    "by" => unit.by = Some(value.trim().into()),
                    "type" => unit.kind = value.trim().into(),
                    _ => {}
                }
            }
        } else if !line.trim().is_empty() {
            units.push(Unit {
                start: number,
                end: number,
                ..Unit::default()
            });
        }
    }
    units
}

fn line_at(starts: &[usize], byte: usize, first: usize) -> usize {
    starts.partition_point(|s| *s <= byte).saturating_sub(1) + first
}

struct ParsedBody {
    units: Vec<Unit>,
    links: Vec<(String, bool, usize)>,
    headings: Vec<String>,
    text: String,
}

fn parse_body(body: &str, first: usize) -> ParsedBody {
    let starts: Vec<_> = std::iter::once(0)
        .chain(body.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_WIKILINKS;
    let mut result = ParsedBody {
        units: Vec::new(),
        links: Vec::new(),
        headings: Vec::new(),
        text: String::new(),
    };
    let mut heading: Option<String> = None;
    let mut code = false;
    for (event, range) in Parser::new_ext(body, opts).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { .. }) => {
                heading = Some(String::new());
                result.units.push(Unit {
                    start: line_at(&starts, range.start, first),
                    end: line_at(&starts, range.end.saturating_sub(1), first),
                    ..Unit::default()
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(value) = heading.take() {
                    result.headings.push(value);
                }
            }
            Event::Start(Tag::Paragraph) | Event::Start(Tag::Item) => {
                result.units.push(Unit {
                    start: line_at(&starts, range.start, first),
                    end: line_at(&starts, range.end.saturating_sub(1), first),
                    ..Unit::default()
                });
            }
            Event::Start(Tag::CodeBlock(_)) => code = true,
            Event::End(TagEnd::CodeBlock) => code = false,
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) if !code => {
                result.links.push((
                    dest_url.into_string(),
                    matches!(link_type, LinkType::WikiLink { .. }),
                    line_at(&starts, range.start, first),
                ));
            }
            Event::Text(value) if !code => {
                if let Some(heading) = heading.as_mut() {
                    heading.push_str(&value);
                }
                result.text.push_str(&value);
                result.text.push(' ');
            }
            _ => {}
        }
    }
    result
}

fn lexical_features(title: &str, tags: &[String], headings: &[String], text: &str) -> Vec<String> {
    static SEGMENTER: OnceLock<Jieba> = OnceLock::new();
    let jieba = SEGMENTER.get_or_init(Jieba::new);
    let mut scores: BTreeMap<String, u32> = BTreeMap::new();
    const STOP: &[&str] = &[
        "the",
        "and",
        "for",
        "this",
        "that",
        "with",
        "from",
        "you",
        "your",
        "are",
        "was",
        "not",
        "have",
        "has",
        "will",
        "can",
        "into",
        "none",
        "true",
        "false",
        "null",
        "const",
        "let",
        "function",
        "return",
        "string",
        "self",
        "pub",
        "use",
        "我们",
        "你们",
        "他们",
        "这个",
        "那个",
        "一个",
        "可以",
        "需要",
        "就是",
        "因为",
        "所以",
        "但是",
        "进行",
        "已经",
        "以及",
        "如果",
        "没有",
        "什么",
        "如何",
        "内容",
        "用户",
        "文件",
        "问题",
        "使用",
        "相关",
        "通过",
        "当前",
        "今天",
        "时间",
        "知道",
        "然后",
        "可能",
        "还是",
        "这样",
        "现在",
        "时候",
        "这里",
        "不是",
        "觉得",
        "一些",
        "这些",
        "它们",
        "自己",
        "其中",
        "一个人",
        "时候",
        "好的",
    ];
    for (value, weight) in std::iter::once((title, 6))
        .chain(tags.iter().map(|s| (s.as_str(), 8)))
        .chain(headings.iter().map(|s| (s.as_str(), 3)))
        .chain(std::iter::once((text, 1)))
    {
        for token in jieba.cut(value, true) {
            let word = normalize(token.word);
            let length = word.chars().count();
            if !(2..=48).contains(&length)
                || STOP.contains(&word.as_str())
                || !word.chars().any(char::is_alphabetic)
                || word.chars().any(|c| c.is_control())
            {
                continue;
            }
            let score = scores.entry(word).or_default();
            *score = score.saturating_add(weight).min(4096);
        }
    }
    let mut ranked: Vec<_> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut result: Vec<String> = ranked.into_iter().take(24).map(|(word, _)| word).collect();
    for explicit in std::iter::once(title)
        .chain(tags.iter().map(String::as_str))
        .take(8)
    {
        if (2..=64).contains(&explicit.chars().count()) {
            result.push(normalize(explicit));
        }
    }
    result.sort();
    result.dedup();
    result
}

impl Extractor {
    pub(super) fn read_markdown(&mut self, path: &str, raw: &str) {
        let text = raw.replace("\r\n", "\n").replace('\r', "\n");
        let markdown = path.ends_with(".md");
        let (front, body, first) = if markdown {
            split_frontmatter(&text)
        } else {
            (None, text.as_str(), 1)
        };
        let fm: Value = match front {
            Some(value) => match serde_yaml::from_str(value) {
                Ok(value) => value,
                Err(_) => {
                    self.diagnostic(
                        "frontmatter.invalid",
                        path,
                        "frontmatter 无法解析，仍保留正文与文件身份",
                    );
                    Value::Null
                }
            },
            None => Value::Null,
        };
        if path.ends_with("/blocklist.md") {
            self.sources.get_mut(path).unwrap().role = "config".into();
            self.blocked.extend(
                body.lines()
                    .map(|l| normalize(l.trim().trim_start_matches(['-', '*', '+']).trim()))
                    .filter(|s| !s.is_empty() && !s.starts_with('#')),
            );
            return;
        }
        let mut parsed = if markdown {
            parse_body(body, first)
        } else {
            ParsedBody {
                units: Vec::new(),
                links: Vec::new(),
                headings: Vec::new(),
                text: body.into(),
            }
        };
        let outline = path.ends_with(".note.md");
        let units = if outline {
            outline_units(body, first)
        } else {
            parsed.units.clone()
        };
        // The outline format stores rendered Markdown answers inside an outer
        // fence. That container is not a programming-code example.
        if outline {
            let lines: Vec<_> = body.lines().collect();
            for unit in units.iter().filter(|u| u.kind == "answer") {
                let at = unit.start - first;
                let start = lines
                    .get(at)
                    .copied()
                    .unwrap_or("")
                    .trim_start()
                    .trim_start_matches("- ");
                let fence = start.chars().take_while(|c| *c == '`').count();
                if fence < 3 {
                    continue;
                }
                let end = (at + 1..lines.len().min(unit.end - first + 1))
                    .find(|i| {
                        let line = lines[*i].trim();
                        let ticks = line.chars().take_while(|c| *c == '`').count();
                        ticks >= fence && line[ticks..].is_empty()
                    })
                    .unwrap_or(lines.len().min(unit.end - first + 1));
                let inner = lines[at + 1..end]
                    .iter()
                    .map(|line| line.trim_start())
                    .collect::<Vec<_>>()
                    .join("\n");
                let answer = parse_body(&inner, unit.start + 1);
                parsed.links.extend(answer.links);
                parsed.text.push_str(&answer.text);
            }
        }
        let title = fm["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| {
                parsed
                    .headings
                    .iter()
                    .find(|s| !s.trim().is_empty())
                    .cloned()
            })
            .unwrap_or_else(|| file_stem(path));
        let aliases = strings(&fm["aliases"]);
        let tags = strings(&fm["tags"]);
        let sources: Vec<_> = fm["sources"]
            .as_sequence()
            .into_iter()
            .flatten()
            .filter_map(|s| s["resource"].as_str().or_else(|| s["uri"].as_str()))
            .map(str::to_owned)
            .collect();
        let authored = fm["generated"]["by"]
            .as_str()
            .unwrap_or_else(|| self.inputs[path].origin.as_str())
            .to_owned();
        let source_id = self.sources[path].id.clone();
        let doc_ev = self.evidence(
            path,
            Locator {
                start: 1,
                end: first.max(1),
                ..Locator::default()
            },
            "metadata",
            &authored,
            "document",
            "matched",
        );
        let project = fm["type"]
            .as_str()
            .is_some_and(|s| matches!(normalize(s).as_str(), "project" | "项目"));
        let node = self.add_node(
            format!("document:{source_id}"),
            title.clone(),
            if project { "project" } else { "document" },
            if project { "candidate" } else { "observed" },
            vec![doc_ev.clone()],
            aliases.clone(),
        );
        if project {
            self.nodes.get_mut(&node).unwrap().intent_status = Some("declared_project".into());
        }
        self.features.insert(
            node.clone(),
            lexical_features(&title, &tags, &parsed.headings, &parsed.text),
        );
        let empty = if outline {
            !body.lines().any(|line| {
                let value = line.trim();
                !value.is_empty()
                    && value != "-"
                    && !value.split_once("::").is_some_and(|(k, _)| {
                        [
                            "id",
                            "type",
                            "line",
                            "collapsed",
                            "created",
                            "updated",
                            "status",
                            "answered",
                            "by",
                        ]
                        .contains(&k)
                    })
            })
        } else {
            body.trim().is_empty()
        };
        self.documents.insert(
            path.into(),
            Document {
                node: node.clone(),
                aliases,
                empty,
                sources,
            },
        );
        for tag in tags {
            let normalized = normalize(tag.trim_start_matches('#'));
            if normalized.is_empty() {
                continue;
            }
            let tag_node = self.add_node(
                format!("tag:{normalized}"),
                tag.trim_start_matches('#').into(),
                "concept",
                "observed",
                vec![doc_ev.clone()],
                Vec::new(),
            );
            self.features
                .entry(tag_node.clone())
                .or_insert_with(|| lexical_features(&tag, &[], &[], ""));
            self.add_edge(
                "tagged_with",
                "observed",
                vec![
                    Participant {
                        node: node.clone(),
                        role: "document".into(),
                    },
                    Participant {
                        node: tag_node,
                        role: "tag".into(),
                    },
                ],
                vec![doc_ev.clone()],
            );
        }
        if let Some(project) = fm["task"]["project"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        {
            let target = self.add_node(
                format!("project:{}", normalize(project)),
                project.into(),
                "project",
                "candidate",
                vec![doc_ev.clone()],
                Vec::new(),
            );
            self.nodes.get_mut(&target).unwrap().intent_status =
                Some("task_project_reference".into());
            self.features
                .entry(target.clone())
                .or_insert_with(|| lexical_features(project, &[], &[], ""));
            self.add_edge(
                "project_context",
                "observed",
                vec![
                    Participant {
                        node: node.clone(),
                        role: "document".into(),
                    },
                    Participant {
                        node: target,
                        role: "project".into(),
                    },
                ],
                vec![doc_ev],
            );
        }
        let mut distinct = BTreeSet::new();
        let body_lines: Vec<_> = body.lines().collect();
        for (target, wiki, line) in parsed.links {
            if !distinct.insert((target.clone(), wiki, line)) {
                continue;
            }
            let unit = units
                .iter()
                .filter(|u| u.start <= line && u.end >= line)
                .min_by_key(|u| u.end - u.start);
            let locator = unit
                .map(|u| Locator {
                    start: u.start,
                    end: u.end,
                    outline_id: u.id.clone(),
                    json_pointer: None,
                })
                .unwrap_or(Locator {
                    start: line,
                    end: line,
                    ..Locator::default()
                });
            let by = unit.and_then(|u| u.by.as_deref()).unwrap_or(&authored);
            let ev = self.evidence(
                path,
                locator,
                "context",
                by,
                if outline { "outline_node" } else { "paragraph" },
                "matched",
            );
            if wiki && !self.contexts.contains_key(&ev) {
                let (start, end) = unit.map(|u| (u.start, u.end)).unwrap_or((line, line));
                let context = body_lines
                    [start.saturating_sub(first)..(end - first + 1).min(body_lines.len())]
                    .join("\n");
                let mut terms = lexical_features("", &[], &[], &context);
                terms.truncate(12);
                self.contexts.insert(ev.clone(), terms);
            }
            self.pending.push(PendingLink {
                source: path.into(),
                from: node.clone(),
                target,
                wiki,
                evidence: ev,
            });
        }
    }
}
