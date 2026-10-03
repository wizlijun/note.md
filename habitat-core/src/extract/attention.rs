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
        let events = crate::term_quality::deduplicate_events(
            std::mem::take(&mut self.focus_events)
                .into_iter()
                .filter(|e| e.date <= context.as_of)
                .collect(),
        );
        let eligible = |n: &&Node| {
            matches!(
                n.node_type.as_str(),
                "concept"
                    | "entity"
                    | "project"
                    | "keyword"
                    | "person"
                    | "tool"
                    | "resource"
                    | "term_candidate"
            ) && (crate::keyword::acceptable(&n.label) || n.node_type == "project")
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
        for node in self.nodes.values().filter(eligible) {
            let key = normalize(&node.label);
            let hint = match node.node_type.as_str() {
                "project"
                    if matches!(
                        node.intent_status.as_deref(),
                        Some("declared_project" | "task_project_reference")
                    ) || node.status != "imported" =>
                {
                    "project"
                }
                "project" => "entity",
                "person" => "person",
                "tool" => "tool",
                "resource" => "resource",
                "entity" => "entity",
                _ => "concept",
            };
            let old = anchors.get(&key).map(String::as_str);
            if hint == "project" || old == Some("project") {
                anchors.insert(key, "project".into());
            } else if let Some(old) = old {
                if old != hint {
                    anchors.insert(key, "entity".into());
                }
            } else {
                anchors.insert(key, hint.into());
            }
        }
        // All histories share the same admission test, including previous
        // versions. Retention never bypasses term quality.
        for (key, label) in &self.previous_keywords {
            vocabulary
                .entry(key.clone())
                .or_insert_with(|| label.clone());
        }
        vocabulary.extend(crate::term_quality::candidate_terms(&events));
        for label in crate::concept_relations::candidate_endpoints(&events) {
            vocabulary.entry(normalize(&label)).or_insert(label);
        }
        let candidates = crate::focus::rank_events(events.clone(), &context, &anchors)?;
        for candidate in &candidates {
            vocabulary.insert(normalize(&candidate.term), candidate.term.clone());
        }
        let assessments = crate::term_quality::assess_terms(&events, &vocabulary, &anchors);
        // Rejected fragments are neither concepts nor background entities.
        // Remove original/previous anchors too; discard whole affected claims
        // instead of rewriting their participant meaning.
        self.nodes.retain(|_, node| {
            !assessments
                .get(&normalize(&node.label))
                .is_some_and(|a| a.rejected)
        });
        self.edges.retain(|_, edge| {
            edge.participants
                .iter()
                .all(|p| self.nodes.contains_key(&p.node))
        });
        vocabulary.retain(|key, _| {
            assessments.get(key).is_some_and(|a| {
                !a.rejected
                    && (a.frequency > 0 || a.class == crate::term_quality::TermClass::Project)
            })
        });
        for node in self.nodes.values_mut() {
            if matches!(
                node.node_type.as_str(),
                "concept"
                    | "keyword"
                    | "entity"
                    | "person"
                    | "tool"
                    | "resource"
                    | "term_candidate"
                    | "project"
            ) {
                node.node_type = assessments
                    .get(&normalize(&node.label))
                    .map(|a| a.class.node_type())
                    .unwrap_or("term_candidate")
                    .into();
            }
        }
        let as_of = NaiveDate::parse_from_str(&context.as_of, "%Y-%m-%d").unwrap();
        let first = (as_of - chrono::Duration::days(context.window_days as i64 - 1)).to_string();
        let active_events = events
            .iter()
            .filter(|e| e.date >= first)
            .map(|e| &e.event_id)
            .collect::<BTreeSet<_>>()
            .len()
            .max(1) as f64;
        let mut candidates =
            crate::focus::qualify_candidates(candidates, &assessments, as_of, active_events);
        candidates.retain(|c| {
            assessments
                .get(&normalize(&c.term))
                .is_some_and(|a| a.class.main())
        });
        let preliminary = crate::focus::foreground(&candidates);
        let vocabulary: Vec<_> = vocabulary.into_iter().collect();
        let patterns = AhoCorasick::new(vocabulary.iter().map(|(_, label)| label.to_lowercase()))
            .map_err(|e| format!("关注词典构建失败: {e}"))?;
        let active: BTreeSet<_> = preliminary.iter().map(|c| normalize(&c.term)).collect();
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
                let assessment = &assessments[key];
                if !crate::term_quality::mention_context(&event.text, label)
                    || assessment.class == crate::term_quality::TermClass::Keyword
                        && (!assessment.concept_events.contains(&event.event_id)
                            || !crate::term_quality::concept_context(&event.text, label))
                {
                    continue;
                }
                if !assessment.concept_events.contains(&event.event_id)
                    && !assessment.background_events.contains(&event.event_id)
                {
                    continue;
                }
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
                    assessment.class.node_type(),
                    "observed",
                    vec![evidence],
                    Vec::new(),
                );
                original_ids.insert(key.clone(), node);
                historical
                    .entry(key.clone())
                    .or_insert_with(|| FocusCandidate {
                        term: label.clone(),
                        kind: if assessment.class == crate::term_quality::TermClass::Keyword {
                            "concept"
                        } else {
                            "context"
                        }
                        .into(),
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
        // A separate dated background ranking supplies the background view;
        // these nodes never consume the concept quota or define main districts.
        let mut background = Vec::new();
        for candidate in historical.values() {
            let class = assessments[&normalize(&candidate.term)].class;
            if matches!(
                class,
                crate::term_quality::TermClass::Keyword | crate::term_quality::TermClass::Candidate
            ) {
                continue;
            }
            let mut events: BTreeMap<String, Occurrence> = BTreeMap::new();
            for occurrence in &candidate.occurrences {
                if occurrence.date >= first && occurrence.date <= context.as_of {
                    events
                        .entry(occurrence.event_id.clone())
                        .or_insert_with(|| occurrence.clone());
                }
            }
            let dates: BTreeSet<_> = events.values().map(|o| o.date.clone()).collect();
            if dates.len() < 2 {
                continue;
            }
            let activation: f64 = dates
                .iter()
                .map(|date| {
                    2f64.powf(
                        -(as_of - NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap()).num_days()
                            as f64
                            / 10.,
                    )
                })
                .sum();
            background.push(FocusCandidate {
                term: candidate.term.clone(),
                kind: "context".into(),
                score: activation.ln_1p() * (1. + (1. + dates.len() as f64).ln()),
                active_days: dates.len(),
                events: events.len(),
                last_observed_at: dates.last().unwrap().clone(),
                occurrences: events.into_values().collect(),
            });
        }
        let max_background = background
            .iter()
            .map(|c| c.score)
            .fold(0., f64::max)
            .max(f64::EPSILON);
        for c in &mut background {
            c.score = 0.3 * c.score / max_background;
        }
        candidates.retain(|c| c.kind == "concept");
        candidates.extend(background);
        candidates.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.term.cmp(&b.term)));
        let selected = crate::focus::foreground(&candidates);
        for candidate in &selected {
            self.retained_keywords.insert(normalize(&candidate.term));
        }
        // Relationships belong to the retained knowledge graph, so remeasure
        // all trusted historical observations rather than just today's window.
        // Otherwise advancing a date alone would erase established roads.
        let historical: Vec<_> = historical
            .into_values()
            .filter(|c| assessments[&normalize(&c.term)].class.main())
            .collect();
        let relation_terms: BTreeMap<_, _> = historical
            .iter()
            .map(|c| (normalize(&c.term), c.term.clone()))
            .collect();
        for claim in crate::concept_relations::extract_relations(&events, &relation_terms) {
            let (Some(from), Some(to)) =
                (original_ids.get(&claim.from), original_ids.get(&claim.to))
            else {
                continue;
            };
            let participants = vec![
                Participant {
                    node: from.clone(),
                    role: "subject".into(),
                },
                Participant {
                    node: to.clone(),
                    role: "object".into(),
                },
            ];
            let evidence = self.attention_evidence(&claim.occurrence);
            self.add_edge(&claim.relation, &claim.status, participants, vec![evidence]);
        }
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
