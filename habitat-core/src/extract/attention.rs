use super::*;
use crate::focus::literal_contains as literal;
use crate::focus::{FocusCandidate, Occurrence};
use aho_corasick::AhoCorasick;
use chrono::NaiveDate;

impl Extractor {
    /// Freeze the observation date before any source is consumed. Wall-clock
    /// time is supplied by the adapter, never sampled inside extraction.
    pub fn set_focus(&mut self, context: FocusContext) -> Result<(), String> {
        if !self.seen.is_empty() {
            return Err("必须在读取来源之前冻结关注观察窗口".into());
        }
        let date = NaiveDate::parse_from_str(&context.as_of, "%Y-%m-%d")
            .map_err(|_| "关注观察日期无效")?;
        if date.format("%Y-%m-%d").to_string() != context.as_of
            || context.as_of.len() != 10
            || !(1..=3660).contains(&context.window_days)
            || !(-840..=840).contains(&context.utc_offset_minutes)
        {
            return Err("关注观察窗口或时区无效".into());
        }
        self.focus = Some(context);
        Ok(())
    }

    fn attention_evidence(&mut self, occurrence: &Occurrence) -> String {
        self.evidence(
            &occurrence.path,
            Locator {
                start: occurrence.start,
                end: occurrence.end,
                ..Default::default()
            },
            "attention",
            if occurrence.signal == "submitted_material" {
                "submitted"
            } else {
                "human"
            },
            "attention_sentence",
            "matched",
        )
    }

    pub(super) fn extract_attention(&mut self) -> Result<(), String> {
        let Some(context) = self.focus.clone() else {
            return Ok(());
        };
        let events = std::mem::take(&mut self.focus_events);
        let eligible = |n: &&Node| {
            matches!(
                n.node_type.as_str(),
                "concept" | "entity" | "project" | "keyword"
            ) && crate::keyword::acceptable(&normalize(&n.label))
        };
        // Always refresh the complete currently extracted vocabulary, starting
        // on the first run. Refreshing only previous selected nodes would cause
        // the second identical run to discover more evidence and violate no-op.
        let mut vocabulary: BTreeMap<String, String> = self
            .nodes
            .values()
            .filter(eligible)
            .map(|n| (normalize(&n.label), n.label.clone()))
            .collect();
        let mut anchors: BTreeMap<String, String> = BTreeMap::new();
        for node in self.nodes.values().filter(eligible).filter(|n| n.status != "imported") {
            let key = normalize(&node.label);
            // An explicit native project declaration wins deterministically;
            // traversal order of equal-spelling generic concepts cannot erase
            // it. Imported entity guesses are not personal concept metadata.
            if node.node_type == "project" {
                anchors.insert(key, "strong_context".into());
            } else {
                anchors.entry(key).or_insert_with(|| "concept".into());
            }
        }
        let candidates: Vec<_> = crate::focus::rank_events(events.clone(), &context, &anchors)?
            .into_iter()
            .filter(|c| crate::keyword::acceptable(&normalize(&c.term)))
            .collect();
        let selected = crate::focus::foreground(&candidates);
        for (key, label) in &self.previous_keywords {
            vocabulary
                .entry(key.clone())
                .or_insert_with(|| label.clone());
        }
        for candidate in &selected {
            vocabulary.insert(normalize(&candidate.term), candidate.term.clone());
        }
        let vocabulary: Vec<_> = vocabulary.into_iter().collect();
        let patterns = AhoCorasick::new(vocabulary.iter().map(|(_, label)| label.to_lowercase()))
            .map_err(|e| format!("关注词典构建失败: {e}"))?;
        let active: BTreeSet<_> = selected.iter().map(|c| normalize(&c.term)).collect();
        let mut original_ids: BTreeMap<String, String> = BTreeMap::new();
        let mut historical: BTreeMap<String, FocusCandidate> = BTreeMap::new();
        // Refresh historical evidence against current bytes. Future-dated
        // records cannot support a present structure or a retention decision.
        for event in &events {
            if event.date.as_str() > context.as_of.as_str() {
                continue;
            }
            let lowercase = event.text.to_lowercase();
            let matches: BTreeSet<_> = patterns
                .find_overlapping_iter(&lowercase)
                .filter(|m| {
                    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
                    let term = &lowercase[m.start()..m.end()];
                    (!term.chars().next().is_some_and(word)
                        || !lowercase[..m.start()].chars().next_back().is_some_and(word))
                        && (!term.chars().next_back().is_some_and(word)
                            || !lowercase[m.end()..].chars().next().is_some_and(word))
                })
                .map(|m| m.pattern().as_usize())
                .collect();
            for index in matches {
                let (key, label) = &vocabulary[index];
                let occurrence = Occurrence {
                    path: event.path.clone(),
                    date: event.date.clone(),
                    start: event.start,
                    end: event.end,
                    text: event.text.clone(),
                    event_id: event.event_id.clone(),
                    signal: event.signal.clone(),
                    date_basis: event.date_basis.clone(),
                };
                let evidence = self.attention_evidence(&occurrence);
                let node = self.add_node(
                    format!("attention-word:{key}"),
                    label.clone(),
                    "keyword",
                    "observed",
                    vec![evidence],
                    Vec::new(),
                );
                original_ids.insert(key.clone(), node);
                historical
                    .entry(key.clone())
                    .or_insert_with(|| FocusCandidate {
                        term: label.clone(),
                        kind: "concept".into(),
                        score: 0.,
                        active_days: 0,
                        events: 0,
                        last_observed_at: String::new(),
                        occurrences: Vec::new(),
                    })
                    .occurrences
                    .push(occurrence);
                if active.contains(key) || self.previous_keywords.contains_key(key) {
                    self.retained_keywords.insert(key.clone());
                }
            }
        }
        // Relationships belong to the retained knowledge graph, so remeasure
        // all trusted historical observations rather than just today's window.
        // Otherwise advancing a date alone would erase established roads.
        let historical: Vec<_> = historical.into_values().collect();
        for relation in crate::focus::associations(&historical) {
            let Some(a) = original_ids.get(&normalize(&relation.a)).cloned() else {
                continue;
            };
            let Some(b) = original_ids.get(&normalize(&relation.b)).cloned() else {
                continue;
            };
            let mut evidence = Vec::new();
            for occurrence in &relation.occurrences {
                if literal(&occurrence.text, &relation.a) && literal(&occurrence.text, &relation.b)
                {
                    evidence.push(self.attention_evidence(occurrence));
                }
            }
            if evidence.is_empty() {
                continue;
            }
            if let Some(id) = self.add_edge(
                "co_discussed",
                "statistical",
                vec![
                    Participant {
                        node: a,
                        role: "term".into(),
                    },
                    Participant {
                        node: b,
                        role: "term".into(),
                    },
                ],
                evidence,
            ) {
                self.statistical_weights.insert(id, relation.weight);
            }
        }
        let mut observations = BTreeMap::new();
        for candidate in selected {
            let key = normalize(&candidate.term);
            let node = original_ids
                .get(&key)
                .ok_or("关注候选没有可核验的原文匹配")?
                .clone();
            let mut evidence = BTreeSet::new();
            let mut days = BTreeSet::new();
            let mut event_ids = BTreeSet::new();
            for occurrence in &candidate.occurrences {
                if !literal(&occurrence.text, &candidate.term) {
                    return Err(format!(
                        "关注候选与引用原文不一致: {} at {}:{}",
                        candidate.term, occurrence.path, occurrence.start
                    ));
                }
                let id = self.attention_evidence(occurrence);
                self.nodes.get_mut(&node).unwrap().evidence.push(id.clone());
                evidence.insert(id.clone());
                days.insert(occurrence.date.clone());
                event_ids.insert(occurrence.event_id.clone());
                let observation = AttentionObservation {
                    evidence: id.clone(),
                    date: occurrence.date.clone(),
                    event_id: occurrence.event_id.clone(),
                    signal: occurrence.signal.clone(),
                    date_basis: occurrence.date_basis.clone(),
                    confidence: if occurrence.date_basis == "same_day_session" {
                        0.8
                    } else {
                        0.9
                    },
                };
                if observations.get(&id).is_some_and(|old| old != &observation) {
                    return Err("同一证据出现冲突的关注事件或日期归属".into());
                }
                observations.insert(id, observation);
            }
            self.attention.push(Attention {
                node,
                score: candidate.score,
                last_observed_at: days.last().cloned().ok_or("关注候选缺少日期")?,
                active_days: days.len() as u32,
                events: event_ids.len() as u32,
                evidence: evidence.into_iter().collect(),
                category: candidate.kind,
            });
        }
        self.attention_observations = observations.into_values().collect();
        Ok(())
    }
}
