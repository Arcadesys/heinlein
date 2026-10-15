//! Deterministic, bounded model-test support. No user archives or external services.
use std::{collections::BTreeMap, panic::AssertUnwindSafe};

pub(super) struct Case {
    pub steps: usize,
    state: u64,
    trace: Vec<String>,
    counts: BTreeMap<&'static str, usize>,
}
impl Case {
    // SplitMix64, with an explicitly fixed algorithm for portable seed replay.
    pub fn number(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e3779b97f4a7c15);
        let mut n = self.state;
        n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
        n ^ (n >> 31)
    }
    pub fn pick(&mut self, count: usize) -> usize {
        (self.number() % count as u64) as usize
    }
    pub fn record(&mut self, operation: &'static str, detail: impl std::fmt::Display) {
        *self.counts.entry(operation).or_default() += 1;
        self.trace
            .push(format!("{}: {operation} {detail}", self.trace.len()));
    }
    pub fn text(&mut self) -> String {
        let newline = if self.pick(2) == 0 { "\r\n" } else { "\n" };
        let variants = ["é", "e\u{301}", "東京", "नमस्ते", "🏳️‍🌈", "🧑🏽‍🚀", "مرحبا"];
        let word = variants[self.pick(variants.len())];
        let nonce = self.number();
        let body = format!("Fragments. Queer—furry. {word}\t{nonce:016x}{newline}Again.{newline}");
        match self.pick(5) {
            0 => format!("---{newline}title: 'Exact: {word}'{newline}unknown: keep{newline}---{newline}{newline}{body}"),
            1 => format!("---{newline}{{\"title\":\"{word}\",\"unknown\":{nonce}}}{newline}---{newline}{body}"),
            2 => format!("\u{feff}{body}"),
            3 => body.trim_end_matches(['\r', '\n']).into(),
            _ => body,
        }
    }
}
fn setting(name: &str, default: u64, max: u64) -> u64 {
    let value = std::env::var(name).map_or(default, |v| {
        v.strip_prefix("0x").map_or_else(
            || v.parse().expect("fuzz setting must be an unsigned integer"),
            |s| u64::from_str_radix(s, 16).expect("fuzz seed must be hexadecimal"),
        )
    });
    let min = u64::from(name != "HEINLEIN_FUZZ_SEED");
    assert!(
        (min..=max).contains(&value),
        "{name} must be in {min}..={max}"
    );
    value
}
pub(super) fn campaign(name: &str, run: impl Fn(&mut Case)) {
    let base = setting("HEINLEIN_FUZZ_SEED", 0x4845494e4c45494e, u64::MAX);
    let seeds = setting("HEINLEIN_FUZZ_SEEDS", 6, 100_000);
    let steps = setting("HEINLEIN_FUZZ_STEPS", 48, 1024) as usize;
    let mut totals = BTreeMap::new();
    for offset in 0..seeds {
        let seed = base.wrapping_add(offset);
        let mut case = Case {
            steps,
            state: seed,
            trace: vec![],
            counts: BTreeMap::new(),
        };
        if let Err(error) = std::panic::catch_unwind(AssertUnwindSafe(|| run(&mut case))) {
            let message = error
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| error.downcast_ref::<&str>().copied())
                .unwrap_or("non-string panic");
            panic!("{name}: seed={seed:#x}, steps={steps}\nReplay: HEINLEIN_FUZZ_SEED={seed:#x} HEINLEIN_FUZZ_SEEDS=1 HEINLEIN_FUZZ_STEPS={steps}\n{message}\nTrace:\n{}", case.trace.join("\n"));
        }
        for (op, count) in case.counts {
            *totals.entry(op).or_insert(0) += count;
        }
        if seeds >= 128 && (offset + 1) % 128 == 0 {
            eprintln!("FUZZ {name}: completed {}/{seeds} seeds", offset + 1);
        }
    }
    eprintln!("FUZZ {name}: base={base:#x}, seeds={seeds}, steps={steps}, operations={} coverage={totals:?}", totals.values().sum::<usize>());
}
