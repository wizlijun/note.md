//! Stable storage categories, not medical interpretation or cross-source equivalence.

use sha2::{Digest, Sha256};

/// Categorize known metric names without dropping unknown or future records.
/// The result is always one of the fixed storage-directory slugs below.
pub fn category(metric: &str, kind: &str) -> &'static str {
    if kind == "Attachment" {
        return match metric {
            "attachment.clinical" => "clinical",
            "attachment.electrocardiogram" => "heart",
            "attachment.workout-route" => "activity",
            _ => "other",
        };
    }
    let name: String = metric
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let kind = kind.to_ascii_lowercase();
    let contains = |terms: &[&str]| terms.iter().any(|term| name.contains(term));

    if matches!(kind.as_str(), "me" | "exportdate" | "metadataentry")
        || contains(&["hkcharacteristictypeidentifier"])
        || matches!(
            name.as_str(),
            "ourapersonalinfo"
                | "ouraringconfiguration"
                | "ouraringbatterylevel"
                | "ouratag"
                | "ouraenhancedtag"
        )
    {
        "metadata"
    } else if kind == "clinicalrecord"
        || contains(&["hkclinicaltype", "clinicalrecord", "fhir", "medicalrecord"])
    {
        "clinical"
    } else if contains(&["medication", "insulindelivery"]) || kind == "medicationrecord" {
        "medications"
    } else if contains(&[
        "menstrual",
        "intermenstrual",
        "cervicalmucus",
        "ovulation",
        "pregnancy",
        "pregnant",
        "lactation",
        "sexualactivity",
        "contraceptive",
        "basalbodytemperature",
        "progesterone",
        "estrogen",
    ]) {
        "reproductive"
    } else if contains(&[
        "audiogram",
        "audioexposure",
        "headphoneaudio",
        "hearingsensitivity",
        "hearingloss",
        "hearingtest",
    ]) {
        "hearing"
    } else if contains(&["sleep", "bedtime", "wakeup", "apnea"]) {
        "sleep"
    } else if contains(&[
        "heartrate",
        "heartbeat",
        "hrv",
        "atrialfibrillation",
        "electrocardiogram",
        "cardiovascularage",
        "cardiac",
        "irregularheartrhythm",
    ]) {
        "heart"
    } else if contains(&[
        "walkingspeed",
        "walkingsteplength",
        "walkingasymmetry",
        "walkingdoublesupport",
        "walkingsteadiness",
        "sixminutewalk",
        "stairascentspeed",
        "stairdescentspeed",
        "numberoftimesfallen",
    ]) {
        "mobility"
    } else if contains(&[
        "dietary",
        "nutrition",
        "food",
        "waterintake",
        "hydration",
        "energyconsumed",
    ]) {
        "nutrition"
    } else if contains(&[
        "mindful",
        "stateofmind",
        "meditation",
        "stress",
        "resilience",
    ]) || name == "ourasession"
    {
        "mindfulness"
    } else if contains(&[
        "bloodpressure",
        "bloodglucose",
        "bloodalcohol",
        "oxygensaturation",
        "pulseox",
        "spo2",
        "respirat",
        "bodytemperature",
        "perfusionindex",
        "electrodermalactivity",
        "forcedexpiratoryvolume",
        "forcedvitalcapacity",
        "peakexpiratoryflowrate",
    ]) {
        "vitals"
    } else if contains(&[
        "bodymass",
        "bodyfat",
        "leanbodymass",
        "bodycomposition",
        "bodyweight",
        "waistcircumference",
        "height",
        "bmi",
    ]) || matches!(
        name.as_str(),
        "garminweight"
            | "garminweightgoals"
            | "garminweightmeasurements"
            | "garminweightrange"
            | "ouraweight"
    ) {
        "body"
    } else if contains(&[
        "uvexposure",
        "timeindaylight",
        "environment",
        "watertemperature",
        "underwaterdepth",
    ]) {
        "environment"
    } else if matches!(kind.as_str(), "workout" | "activitysummary")
        || contains(&[
            "activity",
            "activities",
            "stepcount",
            "steps",
            "distance",
            "flightsclimbed",
            "energyburned",
            "exercisetime",
            "standtime",
            "movetime",
            "standhour",
            "workout",
            "running",
            "cycling",
            "swimming",
            "physicaleffort",
            "vo2",
            "training",
            "readiness",
            "bodybattery",
            "fitness",
            "movegoal",
            "exercisegoal",
            "standgoal",
        ])
    {
        "activity"
    } else {
        "other"
    }
}

/// A readable, bounded filename component, stable for the exact original metric.
///
/// Removing prefixes and folding case/separators is lossy. A short digest is
/// always included so two metrics do not depend on import order to disambiguate
/// their filenames (including future HK names with the same stripped suffix).
pub fn metric_slug(metric: &str) -> String {
    let short = [
        "HKQuantityTypeIdentifier",
        "HKCategoryTypeIdentifier",
        "HKCharacteristicTypeIdentifier",
        "HKClinicalTypeIdentifier",
        "HKDataTypeIdentifier",
        "HKDataType",
        "HKWorkoutActivityType",
    ]
    .iter()
    .find_map(|prefix| metric.strip_prefix(prefix))
    .unwrap_or(metric);
    let mut chars = short.chars().peekable();
    let mut prev: Option<char> = None;
    let mut slug = String::new();
    while let Some(c) = chars.next() {
        if c.is_ascii_alphanumeric() {
            let next = chars.peek().copied();
            let camel_boundary = c.is_ascii_uppercase()
                && (prev.is_some_and(|p| p.is_ascii_lowercase())
                    || (prev.is_some_and(|p| p.is_ascii_digit())
                        && next.is_some_and(|n| n.is_ascii_lowercase()))
                    || (prev.is_some_and(|p| p.is_ascii_uppercase())
                        && next.is_some_and(|n| n.is_ascii_lowercase())));
            if camel_boundary && !slug.is_empty() && !slug.ends_with('-') {
                slug.push('-');
            }
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        prev = Some(c);
        // Long metric IDs remain safe for normal filesystem component limits.
        if slug.len() >= 80 {
            slug.truncate(80);
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let stem = if slug.is_empty() { "metric" } else { slug };
    let digest = format!("{:x}", Sha256::digest(metric.as_bytes()));
    format!("{stem}-{}", &digest[..12])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_apple_types_have_stable_categories() {
        let cases = [
            ("HKCategoryTypeIdentifierSleepAnalysis", "sleep"),
            ("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "heart"),
            ("HKQuantityTypeIdentifierVO2Max", "activity"),
            ("HKQuantityTypeIdentifierStepCount", "activity"),
            ("HKQuantityTypeIdentifierBodyMassIndex", "body"),
            ("HKQuantityTypeIdentifierOxygenSaturation", "vitals"),
            ("HKQuantityTypeIdentifierDietaryWater", "nutrition"),
            ("HKCategoryTypeIdentifierMindfulSession", "mindfulness"),
            (
                "HKQuantityTypeIdentifierBasalBodyTemperature",
                "reproductive",
            ),
            ("HKQuantityTypeIdentifierInsulinDelivery", "medications"),
            ("HKClinicalTypeIdentifierLabResultRecord", "clinical"),
            ("HKQuantityTypeIdentifierUVExposure", "environment"),
            ("HKQuantityTypeIdentifierWalkingSpeed", "mobility"),
            (
                "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
                "hearing",
            ),
            ("HKCharacteristicTypeIdentifierBiologicalSex", "metadata"),
            ("HKQuantityTypeIdentifierNewUnknownMeasurement", "other"),
        ];
        for (metric, expected) in cases {
            assert_eq!(category(metric, "Record"), expected, "{metric}");
        }
        assert_eq!(category("", "Workout"), "activity");
        assert_eq!(category("", "ActivitySummary"), "activity");
        assert_eq!(category("", "Me"), "metadata");
        assert_eq!(category("", "UnknownFutureRecord"), "other");
        assert_eq!(category("attachment.clinical", "Attachment"), "clinical");
        assert_eq!(
            category("attachment.electrocardiogram", "Attachment"),
            "heart"
        );
        assert_eq!(
            category("attachment.workout-route", "Attachment"),
            "activity"
        );
        assert_eq!(category("attachment.other", "Attachment"), "other");
    }

    #[test]
    fn vendor_names_remain_distinct_and_unknowns_survive() {
        for (metric, expected) in [
            ("garmin.hrv", "heart"),
            ("garmin.bodyBattery", "activity"),
            ("garmin.pulse_ox", "vitals"),
            ("garmin.trainingReadiness", "activity"),
            ("oura.daily_sleep", "sleep"),
            ("oura.daily_activity", "activity"),
            ("oura.daily_readiness", "activity"),
            ("oura.cardiovascular_age", "heart"),
            ("oura.session", "mindfulness"),
            ("oura.personal_info", "metadata"),
            ("oura.ring_configuration", "metadata"),
            ("oura.ring_battery_level", "metadata"),
            ("oura.enhanced_tag", "metadata"),
            ("garmin.weight_measurements", "body"),
            ("garmin.weight_range", "body"),
            ("garmin.activities", "activity"),
            ("oura.unknown_new_metric", "other"),
        ] {
            assert_eq!(category(metric, "Record"), expected, "{metric}");
        }
        assert!(metric_slug("garmin.HRV").starts_with("garmin-hrv-"));
        assert!(metric_slug("oura.daily_sleep").starts_with("oura-daily-sleep-"));
        assert_ne!(metric_slug("garmin.sleep"), metric_slug("oura.sleep"));
    }

    #[test]
    fn readable_slugs_handle_camel_case_acronyms_and_prefixes() {
        for (metric, stem) in [
            ("HKQuantityTypeIdentifierHeartRate", "heart-rate-"),
            (
                "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
                "heart-rate-variability-sdnn-",
            ),
            ("HKQuantityTypeIdentifierVO2Max", "vo2-max-"),
            ("HRVStatus", "hrv-status-"),
            ("HKDataTypeSleepDuration", "sleep-duration-"),
        ] {
            let slug = metric_slug(metric);
            assert!(slug.starts_with(stem), "{metric}: {slug}");
            assert_eq!(slug.len(), stem.len() + 12);
            assert_eq!(slug, metric_slug(metric));
        }
    }

    #[test]
    fn normalization_collisions_get_distinct_stable_suffixes() {
        let names = [
            "HKQuantityTypeIdentifierHeartRate",
            "HKCategoryTypeIdentifierHeartRate",
            "HeartRate",
            "heart-rate",
            "heart_rate",
            "heart rate",
            "HEART_RATE",
        ];
        let unique: std::collections::HashSet<_> =
            names.iter().map(|name| metric_slug(name)).collect();
        assert_eq!(unique.len(), names.len());
    }

    #[test]
    fn unicode_paths_and_long_ids_produce_safe_bounded_components() {
        for metric in [
            "心率",
            "睡眠",
            "../../sleep",
            "/tmp/heart\\rate",
            ".",
            "",
            "<bad>:metric",
        ] {
            let slug = metric_slug(metric);
            assert!(slug
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'));
            assert!(!slug.starts_with('-'));
            assert!(!slug.contains("--"));
            assert!(slug.len() <= 93);
        }
        assert_ne!(metric_slug("心率"), metric_slug("睡眠"));
        assert!(metric_slug("心率").starts_with("metric-"));
        assert!(metric_slug(&"A".repeat(1000)).len() <= 93);
    }
}
