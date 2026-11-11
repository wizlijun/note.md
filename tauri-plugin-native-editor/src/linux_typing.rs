//! Pair the two deliveries of a physical key without suppressing key repeats.
use std::collections::VecDeque;

const CAPACITY: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Source {
    Local,
    Ime,
}

struct Pending {
    source: Source,
    time: u32,
    code: u32,
    release: bool,
}

#[derive(Default)]
pub(super) struct Pairing {
    pending: VecDeque<Pending>,
}

impl Pairing {
    pub(super) fn duplicate(
        &mut self,
        source: Source,
        time: u32,
        code: u32,
        release: bool,
    ) -> bool {
        if time == 0 || code == 0 {
            return false;
        }
        if let Some(index) = self.pending.iter().position(|key| {
            key.source != source && key.time == time && key.code == code && key.release == release
        }) {
            self.pending.remove(index);
            return true;
        }
        // Fcitx can reuse the original timestamp throughout a held-key repeat.
        // Retain each same-source delivery until its other-source pair arrives.
        if self.pending.len() == CAPACITY {
            self.pending.pop_front();
        }
        self.pending.push_back(Pending {
            source,
            time,
            code,
            release,
        });
        false
    }

    pub(super) fn clear(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_each_delivery_once_in_either_order() {
        for (first, second) in [(Source::Local, Source::Ime), (Source::Ime, Source::Local)] {
            let mut pairing = Pairing::default();
            assert!(!pairing.duplicate(first, 100, 38, false));
            assert!(pairing.duplicate(second, 100, 38, false));
            assert!(pairing.pending.is_empty());
            assert!(!pairing.duplicate(second, 100, 38, false));
        }
    }

    #[test]
    fn repeated_timestamps_keep_every_same_source_repeat() {
        let mut pairing = Pairing::default();
        for _ in 0..5 {
            assert!(!pairing.duplicate(Source::Ime, 100, 38, false));
        }
        for _ in 0..5 {
            assert!(pairing.duplicate(Source::Local, 100, 38, false));
        }
        assert!(pairing.pending.is_empty());
        for _ in 0..5 {
            assert!(!pairing.duplicate(Source::Local, 100, 38, false));
            assert!(pairing.duplicate(Source::Ime, 100, 38, false));
        }
    }

    #[test]
    fn timestamp_keycode_and_release_are_all_part_of_identity() {
        let mut pairing = Pairing::default();
        assert!(!pairing.duplicate(Source::Local, 100, 38, false));
        assert!(!pairing.duplicate(Source::Ime, 101, 38, false));
        assert!(!pairing.duplicate(Source::Ime, 100, 39, false));
        assert!(!pairing.duplicate(Source::Ime, 100, 38, true));
        assert!(pairing.duplicate(Source::Ime, 100, 38, false));
        assert_eq!(pairing.pending.len(), 3);
    }

    #[test]
    fn invalid_identity_is_never_cached_or_paired() {
        let mut pairing = Pairing::default();
        for (time, code) in [(0, 38), (100, 0), (0, 0)] {
            for source in [Source::Local, Source::Ime, Source::Local] {
                assert!(!pairing.duplicate(source, time, code, false));
            }
        }
        assert!(pairing.pending.is_empty());
    }

    #[test]
    fn capacity_evicts_oldest_unpaired_delivery() {
        let mut pairing = Pairing::default();
        for time in 1..=CAPACITY as u32 + 1 {
            assert!(!pairing.duplicate(Source::Local, time, 38, false));
        }
        assert_eq!(pairing.pending.len(), CAPACITY);
        assert!(!pairing.duplicate(Source::Ime, 1, 38, false));
        assert_eq!(pairing.pending.len(), CAPACITY);
        assert!(pairing.duplicate(Source::Ime, CAPACITY as u32 + 1, 38, false));
    }

    #[test]
    fn clear_prevents_pairing_across_input_sessions() {
        let mut pairing = Pairing::default();
        assert!(!pairing.duplicate(Source::Local, 100, 38, false));
        pairing.clear();
        assert!(pairing.pending.is_empty());
        assert!(!pairing.duplicate(Source::Ime, 100, 38, false));
    }
}
