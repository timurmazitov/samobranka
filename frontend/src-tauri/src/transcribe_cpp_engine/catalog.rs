//! Static catalog of the models the transcribe.cpp provider can use.
//!
//! The catalog is deliberately free of any engine interaction: it describes
//! what a model *is* — its transcribe.cpp family (the catalog variant), the
//! quantization of the published weights, the exact artifact size, the pinned
//! SHA-256 digest and where the weights live upstream. Nothing here loads the
//! native library, so a model can be listed, downloaded, validated and
//! deleted before transcription support exists.
//!
//! The catalog *is* the settings model list, and it follows a curation
//! policy: only models that (a) support Russian and (b) are published in the
//! Q8_0 quantization are listed. Russian support is decided by the upstream
//! transcribe.cpp README
//! (<https://github.com/handy-computer/transcribe.cpp/blob/main/README.md>)
//! and its `catalog/` metadata: a family may be catalogued only when its
//! `catalog/<variant>.json` lists `ru` in `languages` (the tests mirror that
//! allow-list). Q8_0 is the app's accuracy/size trade-off, so the other
//! quantizations upstream publishes (F16, Q6_K, Q5_K_M, Q4_K_M, F32, BF16)
//! are intentionally omitted — do not "restore" them. Adding a model means
//! checking the upstream README/catalog first and updating the allow-list
//! test alongside the entry.
//!
//! Every value below was verified against the Hugging Face API
//! (`api/models/<repo>` for the pinned commit, `tree/main` for the LFS
//! `oid`/`size` of each file) on 2026-11-20, except the Qwen3-ASR 1.7B
//! entry, verified the same way on 2026-11-21. Sources are pinned to a commit
//! so that the artifact a user downloads is the artifact the catalog
//! describes: `https://huggingface.co/handy-computer/<repo>/resolve/<commit>/<filename>`.
//! If upstream later re-quantizes or re-publishes a pinned artifact,
//! re-verify the exact byte size and lowercase-hex SHA-256 the same way
//! before updating the entry.
//!
//! Model ids are the artifact filename without its `.gguf` suffix, e.g.
//! `parakeet-ultra-Q8_0`. Note that the Qwen package keeps its upstream
//! capitalization (`Qwen3-ASR-0.6B-Q8_0`) while its family stays lowercase.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Installation state of a catalogued model. Mirrors the shape the Whisper,
/// Parakeet and audio.cpp managers expose so the frontend model managers stay
/// consistent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum ModelStatus {
    Available,
    Missing,
    Downloading {
        progress: u8,
    },
    Error(String),
    Corrupted {
        file_size: u64,
        expected_min_size: u64,
    },
}

/// A catalogued model plus its on-disk state.
#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    /// Stable model id used by the commands and the UI: the filename stem.
    pub name: String,
    /// Human-readable model name.
    pub display_name: String,
    /// transcribe.cpp model family (the catalog variant), e.g. `parakeet-ultra`.
    pub family: String,
    /// Weight quantization as published upstream, e.g. `F16` or `Q8_0`.
    pub quantization: String,
    /// File name inside the transcribe.cpp models directory.
    pub filename: String,
    /// Full path of the local artifact.
    pub path: PathBuf,
    /// Size in MiB, for display.
    pub size_mb: u32,
    /// Exact artifact size in bytes; downloads are validated against it.
    pub size_bytes: u64,
    /// Catalog description (purpose and trade-offs) in English. The model
    /// card resolves `models.transcribeCpp.descriptions.<family>` from the
    /// frontend catalog instead (native-i18n spec D6); this prose is the
    /// fallback for a family whose keys have not landed yet.
    pub description: String,
    /// SHA-256 digest of the artifact as published upstream, lowercase hex.
    pub sha256: String,
    /// Current installation state.
    pub status: ModelStatus,
}

/// Static description of one supported model.
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub name: &'static str,
    pub display_name: &'static str,
    pub family: &'static str,
    pub quantization: &'static str,
    pub filename: &'static str,
    pub size_mb: u32,
    pub exact_bytes: u64,
    /// English fallback prose; see [`ModelInfo::description`].
    pub description: &'static str,
    /// Lowercase hex SHA-256 as reported by the Hugging Face LFS metadata.
    pub sha256: &'static str,
    pub source_url: &'static str,
}

impl ModelSpec {
    /// Where this model's artifact lives inside `models_dir`.
    pub fn file_path(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(self.filename)
    }

    /// Build the serializable description of this model for a given
    /// on-disk status.
    pub fn model_info(&self, models_dir: &Path, status: ModelStatus) -> ModelInfo {
        ModelInfo {
            name: self.name.to_string(),
            display_name: self.display_name.to_string(),
            family: self.family.to_string(),
            quantization: self.quantization.to_string(),
            filename: self.filename.to_string(),
            path: self.file_path(models_dir),
            size_mb: self.size_mb,
            size_bytes: self.exact_bytes,
            description: self.description.to_string(),
            sha256: self.sha256.to_string(),
            status,
        }
    }
}

/// Builds the catalog from variant declarations. Each variant lists its
/// offered quantizations as `QUANT => { bytes, size_mb, sha256 }`; the model
/// id and filename are built as `<slug>-<QUANT>` / `<slug>-<QUANT>.gguf`, so
/// the id is the filename stem by construction and the source URL pins the
/// published repository revision. The `size_mb` display figure is
/// `bytes / 1 MiB` rounded; the test suite asserts that relationship against
/// the exact byte count, so the two can never drift apart silently.
macro_rules! model_catalog {
    (
        $(
            slug: $slug:expr,
            display: $display:expr,
            family: $family:expr,
            repo: $repo:expr,
            commit: $commit:expr,
            description: $description:expr,
            [ $( $quant:ident => { bytes: $bytes:expr, size_mb: $size_mb:expr, sha256: $sha256:expr } ),* $(,)? ]
        ),* $(,)?
    ) => {
        &[ $( $(
            ModelSpec {
                name: concat!($slug, "-", stringify!($quant)),
                display_name: $display,
                family: $family,
                quantization: stringify!($quant),
                filename: concat!($slug, "-", stringify!($quant), ".gguf"),
                size_mb: $size_mb,
                exact_bytes: $bytes,
                description: $description,
                sha256: $sha256,
                source_url: concat!(
                    "https://huggingface.co/handy-computer/",
                    $repo,
                    "/resolve/",
                    $commit,
                    "/",
                    $slug,
                    "-",
                    stringify!($quant),
                    ".gguf"
                ),
            }
        ),* ),* ]
    };
}

/// Models supported by the transcribe.cpp provider, in display order:
/// Russian-first (GigaAM), then the multilingual variants, then Whisper.
/// Exactly ten entries — the Russian-capable variants at the Q8_0
/// quantization (see the module docs for the curation policy). Every entry
/// carries the exact artifact size and the SHA-256 digest pinned from the
/// Hugging Face LFS metadata of the listed commit (see the module docs).
pub const MODEL_CATALOG: &[ModelSpec] = model_catalog!(
    slug: "gigaam-v3-ctc",
    display: "GigaAM v3 CTC",
    family: "gigaam-v3-ctc",
    repo: "gigaam-v3-ctc-gguf",
    commit: "53ac479633748119e11b049cf28bc801f0440f10",
    description: "Russian speech recognition (GigaAM v3 CTC). Strong accuracy for Russian meetings.",
    [
        Q8_0 => { bytes: 271_803_328, size_mb: 259, sha256: "71e5c82890e9e243a6bd7575f129f5d1bd2c3ca3ae79aab75cfb1a6934c6a62b" },
    ],
    slug: "gigaam-v3-e2e-ctc",
    display: "GigaAM v3 e2e CTC",
    family: "gigaam-v3-e2e-ctc",
    repo: "gigaam-v3-e2e-ctc-gguf",
    commit: "59717de63d50dd9dd93b3249da6ad3f2f1c4ad6b",
    description: "Russian speech recognition (GigaAM v3 end-to-end CTC). Best accuracy per size for Russian meetings.",
    [
        Q8_0 => { bytes: 272_151_136, size_mb: 260, sha256: "9ccce4750dc813a493d96ca15ee251712bedec15ac9a02fa3d2bd732f08ae5eb" },
    ],
    slug: "gigaam-v3-rnnt",
    display: "GigaAM v3 RNN-T",
    family: "gigaam-v3-rnnt",
    repo: "gigaam-v3-rnnt-gguf",
    commit: "93cba3cdf21d66ca7a746718c849419c2946d6bb",
    description: "Russian speech recognition (GigaAM v3 RNN-T). Better punctuation than the CTC variant.",
    [
        Q8_0 => { bytes: 273_022_880, size_mb: 260, sha256: "130d54450be2922144b265d90d453b781fc2b5adaee52a16954b00f3686201f7" },
    ],
    slug: "gigaam-v3-e2e-rnnt",
    display: "GigaAM v3 e2e RNN-T",
    family: "gigaam-v3-e2e-rnnt",
    repo: "gigaam-v3-e2e-rnnt-gguf",
    commit: "3efd5b39882ceadca5570a8fb9fa1a2c801d6d6d",
    description: "Russian speech recognition (GigaAM v3 end-to-end RNN-T). Punctuation-forward variant at full size.",
    [
        Q8_0 => { bytes: 273_724_832, size_mb: 261, sha256: "78d63b47723b7f8d78c6113a6ef983b5a86e2a86f6c273e1f5cb6967b1c4467a" },
    ],
    slug: "parakeet-tdt-0.6b-v3",
    display: "Parakeet TDT 0.6B v3",
    family: "parakeet-tdt-0.6b-v3",
    repo: "parakeet-tdt-0.6b-v3-gguf",
    commit: "d8d8c32cb2017c57e5307767343e97870f8a7f53",
    description: "Multilingual speech recognition (NVIDIA Parakeet TDT 0.6B v3) with strong Russian and English accuracy.",
    [
        Q8_0 => { bytes: 739_508_576, size_mb: 705, sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7" },
    ],
    slug: "parakeet-ultra",
    display: "Parakeet Ultra",
    family: "parakeet-ultra",
    repo: "parakeet-ultra-gguf",
    commit: "a1539be1b849ea7463b88343e5277b373d0c4ea9",
    description: "Multilingual speech recognition (Parakeet Ultra). Provider default: balanced Russian and English quality at a moderate size.",
    [
        Q8_0 => { bytes: 740_363_168, size_mb: 706, sha256: "007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59" },
    ],
    slug: "Qwen3-ASR-0.6B",
    display: "Qwen3-ASR 0.6B",
    family: "qwen3-asr-0.6b",
    repo: "Qwen3-ASR-0.6B-gguf",
    commit: "7e7c69a577fa2725dfedbe34b5e999336e30a19b",
    description: "Multilingual speech recognition (Qwen3-ASR 0.6B), the strongest Russian accuracy in the catalog.",
    [
        Q8_0 => { bytes: 850_423_456, size_mb: 811, sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8" },
    ],
    slug: "Qwen3-ASR-1.7B",
    display: "Qwen3-ASR 1.7B",
    family: "qwen3-asr-1.7b",
    repo: "Qwen3-ASR-1.7B-gguf",
    commit: "0e0a596e3959c3f3f2ab7d443a5b6f0f4a4bba6f",
    description: "Multilingual speech recognition (Qwen3-ASR 1.7B), the strongest Russian accuracy family in the catalog.",
    [
        Q8_0 => { bytes: 2_185_030_624, size_mb: 2084, sha256: "9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7" },
    ],
    slug: "whisper-large-v3-turbo",
    display: "Whisper large-v3 Turbo",
    family: "whisper-large-v3-turbo",
    repo: "whisper-large-v3-turbo-gguf",
    commit: "18ada752005f5fddef499256f9a458d0b37a203a",
    description: "Multilingual speech recognition (OpenAI Whisper large-v3 Turbo), the fast Whisper fallback for long-tail languages.",
    [
        Q8_0 => { bytes: 886_381_728, size_mb: 845, sha256: "257aa7ec9121c22c167d5e2c49e3e76b4ba0e6e27ebc13074eba0a80f8190220" },
    ],
    slug: "whisper-large-v3",
    display: "Whisper large-v3",
    family: "whisper-large-v3",
    repo: "whisper-large-v3-gguf",
    commit: "274ad1d1cf680b7ee53cc70f78461394cd3a344b",
    description: "Multilingual speech recognition (OpenAI Whisper large-v3), the most accurate Whisper release.",
    [
        Q8_0 => { bytes: 1_668_741_440, size_mb: 1591, sha256: "2fa1a5f179f8a511a53e2108db270aa4af3ce08cd976af4180e2854666bb4ba3" },
    ],
);

/// The full catalog.
pub fn catalog() -> &'static [ModelSpec] {
    MODEL_CATALOG
}

/// Look up a catalogued model by its stable name.
pub fn find_model(name: &str) -> Option<&'static ModelSpec> {
    MODEL_CATALOG.iter().find(|spec| spec.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> &'static ModelSpec {
        find_model(name).unwrap_or_else(|| panic!("{name} must be catalogued"))
    }

    /// The exact ten catalogued models, in display order: Russian-first
    /// (GigaAM), then the multilingual variants, then Whisper, with the
    /// 1.7B Qwen next to the 0.6B one. The catalog is the settings list, so
    /// this is the whole user-facing contract: an accidental re-addition of
    /// a non-Russian or non-Q8_0 model must fail here.
    const EXPECTED_CATALOG: [&str; 10] = [
        "gigaam-v3-ctc-Q8_0",
        "gigaam-v3-e2e-ctc-Q8_0",
        "gigaam-v3-rnnt-Q8_0",
        "gigaam-v3-e2e-rnnt-Q8_0",
        "parakeet-tdt-0.6b-v3-Q8_0",
        "parakeet-ultra-Q8_0",
        "Qwen3-ASR-0.6B-Q8_0",
        "Qwen3-ASR-1.7B-Q8_0",
        "whisper-large-v3-turbo-Q8_0",
        "whisper-large-v3-Q8_0",
    ];

    /// Families whose upstream `catalog/<variant>.json` lists `ru` in
    /// `languages` (upstream README
    /// <https://github.com/handy-computer/transcribe.cpp/blob/main/README.md>
    /// and its catalog metadata are the source of truth; verified 2026-11-21).
    /// Only these families may be catalogued.
    const RUSSIAN_CAPABLE_FAMILIES: [&str; 10] = [
        "gigaam-v3-ctc",
        "gigaam-v3-e2e-ctc",
        "gigaam-v3-rnnt",
        "gigaam-v3-e2e-rnnt",
        "parakeet-tdt-0.6b-v3",
        "parakeet-ultra",
        "qwen3-asr-0.6b",
        "qwen3-asr-1.7b",
        "whisper-large-v3-turbo",
        "whisper-large-v3",
    ];

    #[test]
    fn catalog_contains_exactly_the_ten_russian_capable_q8_0_models() {
        let names: Vec<&str> = catalog().iter().map(|spec| spec.name).collect();
        assert_eq!(
            names, EXPECTED_CATALOG,
            "the catalog is the settings list: exactly the ten curated models, in display order"
        );
        assert!(
            catalog().iter().all(|spec| spec.quantization == "Q8_0"),
            "only the Q8_0 quantization is offered"
        );
    }

    #[test]
    fn every_catalogued_family_supports_russian_per_the_upstream_allow_list() {
        for spec in catalog() {
            assert!(
                RUSSIAN_CAPABLE_FAMILIES.contains(&spec.family),
                "model {} has family {}, which the upstream transcribe.cpp catalog \
                 does not list Russian for",
                spec.name,
                spec.family
            );
        }
        // Family coverage: four GigaAM, two Parakeet, two Qwen, two Whisper.
        for family in RUSSIAN_CAPABLE_FAMILIES {
            assert_eq!(
                catalog().iter().filter(|spec| spec.family == family).count(),
                1,
                "family {family} must be catalogued exactly once"
            );
        }
    }

    /// Shared assertions for the two Qwen entries: display name, lowercase
    /// family, the capitalised package filename, the artifact size and digest
    /// pinned from the Hugging Face LFS metadata of the listed commit, the
    /// commit-pinned source URL and the common description wording.
    fn assert_qwen_entry(
        name: &str,
        display_name: &str,
        family: &str,
        filename: &str,
        exact_bytes: u64,
        size_mb: u32,
        sha256: &str,
        repo: &str,
        commit: &str,
        description_fragment: &str,
    ) {
        let entry = spec(name);

        assert_eq!(entry.display_name, display_name);
        assert_eq!(entry.family, family);
        assert_eq!(entry.quantization, "Q8_0");
        assert_eq!(entry.filename, filename);
        // Pinned from the Hugging Face LFS metadata of the commit below.
        assert_eq!(entry.exact_bytes, exact_bytes);
        assert_eq!(entry.size_mb, size_mb);
        assert_eq!(entry.sha256, sha256);
        assert_eq!(
            entry.source_url,
            format!("https://huggingface.co/handy-computer/{repo}/resolve/{commit}/{filename}")
        );
        assert!(
            entry.description.contains(description_fragment),
            "description must follow the shared Qwen wording for {name}: {}",
            entry.description
        );
    }

    #[test]
    fn qwen3_asr_1_7b_is_listed_under_its_capitalised_package_but_lowercase_family() {
        assert_qwen_entry(
            "Qwen3-ASR-1.7B-Q8_0",
            "Qwen3-ASR 1.7B",
            "qwen3-asr-1.7b",
            "Qwen3-ASR-1.7B-Q8_0.gguf",
            2_185_030_624,
            2084,
            "9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7",
            "Qwen3-ASR-1.7B-gguf",
            "0e0a596e3959c3f3f2ab7d443a5b6f0f4a4bba6f",
            "Multilingual speech recognition (Qwen3-ASR 1.7B)",
        );
    }

    #[test]
    fn qwen_variant_is_listed_under_its_capitalised_package_but_lowercase_family() {
        assert_qwen_entry(
            "Qwen3-ASR-0.6B-Q8_0",
            "Qwen3-ASR 0.6B",
            "qwen3-asr-0.6b",
            "Qwen3-ASR-0.6B-Q8_0.gguf",
            850_423_456,
            811,
            "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
            "Qwen3-ASR-0.6B-gguf",
            "7e7c69a577fa2725dfedbe34b5e999336e30a19b",
            "Multilingual speech recognition (Qwen3-ASR 0.6B)",
        );
        // No BF16 entry.
        assert!(
            catalog()
                .iter()
                .all(|spec| spec.quantization != "BF16" && spec.quantization != "F32"),
            "only the Q8_0 quantization is catalogued"
        );
    }

    #[test]
    fn the_default_model_is_catalogued_with_the_default_quant() {
        let default = spec(crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL);

        assert_eq!(default.family, "parakeet-ultra");
        assert_eq!(default.quantization, "Q8_0");
        assert_eq!(default.filename, "parakeet-ultra-Q8_0.gguf");
    }

    #[test]
    fn model_id_matches_filename_stem() {
        for spec in catalog() {
            assert_eq!(
                spec.filename,
                format!("{}.gguf", spec.name),
                "model {} must be stored under its stable name",
                spec.name
            );
        }
    }

    #[test]
    fn size_mb_is_the_exact_byte_size_rounded_to_mib() {
        for spec in catalog() {
            let size_mib = (spec.exact_bytes as f64 / (1024.0 * 1024.0)).round() as u32;
            assert_eq!(spec.size_mb, size_mib, "model {} size_mb", spec.name);
        }
    }

    #[test]
    fn descriptions_carry_no_compile_time_quantization_suffix() {
        // The card renders descriptions from frontend i18n keys and shows the
        // quantization as a badge plus a localized note (native-i18n ticket
        // 04). The Rust prose is only the English fallback, so the macro must
        // not append the old " Quantization: <QUANT>." sentence to it.
        for spec in catalog() {
            assert!(
                !spec.description.contains("Quantization"),
                "model {} still carries the appended quantization sentence: {}",
                spec.name,
                spec.description
            );
        }
    }

    #[test]
    fn catalog_names_are_unique_and_models_are_found_by_name() {
        let mut names: Vec<&str> = catalog().iter().map(|spec| spec.name).collect();
        names.sort_unstable();
        let unique = names.len();
        names.dedup();
        assert_eq!(names.len(), unique, "catalog names must be unique");

        for spec in catalog() {
            assert!(find_model(spec.name).is_some());
        }
        assert!(find_model("whisper-large").is_none());
    }

    #[test]
    fn artifacts_are_pinned_to_commits_in_the_handy_computer_repositories() {
        for spec in catalog() {
            // https://huggingface.co/handy-computer/<repo>/resolve/<commit>/<filename>
            let rest = spec
                .source_url
                .strip_prefix("https://huggingface.co/handy-computer/")
                .unwrap_or_else(|| {
                    panic!("weights must come from handy-computer: {}", spec.source_url)
                });
            let (repo, tail) = rest.split_once("/resolve/").unwrap_or_else(|| {
                panic!("source url must pin a commit: {}", spec.source_url)
            });
            assert!(!repo.is_empty() && repo.ends_with("-gguf"), "repo: {repo}");

            let (commit, filename) = tail.split_once('/').unwrap_or_else(|| {
                panic!("source url must end with /<filename>: {}", spec.source_url)
            });
            assert_eq!(
                commit.len(),
                40,
                "commit must be a full SHA: {}",
                spec.source_url
            );
            assert!(
                commit.chars().all(|c| c.is_ascii_hexdigit()),
                "commit must be hex: {}",
                spec.source_url
            );
            assert_eq!(
                filename, spec.filename,
                "artifact {filename} does not match model {}",
                spec.name
            );
            assert!(
                spec.sha256.len() == 64
                    && spec
                        .sha256
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
                "model {} must pin a lowercase hex SHA-256",
                spec.name
            );
        }
    }

    #[test]
    fn gigaam_weights_come_from_the_handy_computer_packages() {
        let entry = spec("gigaam-v3-e2e-ctc-Q8_0");

        assert!(
            entry.source_url.starts_with(
                "https://huggingface.co/handy-computer/gigaam-v3-e2e-ctc-gguf/resolve/"
            ),
            "unexpected source: {}",
            entry.source_url
        );
        assert!(entry
            .source_url
            .ends_with("/gigaam-v3-e2e-ctc-Q8_0.gguf"));
    }

    #[test]
    fn model_info_carries_family_quantization_and_digest_metadata() {
        let spec = spec("whisper-large-v3-Q8_0");
        let info = spec.model_info(Path::new("/models/transcribecpp"), ModelStatus::Missing);

        assert_eq!(info.name, "whisper-large-v3-Q8_0");
        assert_eq!(info.family, "whisper-large-v3");
        assert_eq!(info.quantization, "Q8_0");
        assert_eq!(info.filename, "whisper-large-v3-Q8_0.gguf");
        assert_eq!(
            info.path,
            PathBuf::from("/models/transcribecpp/whisper-large-v3-Q8_0.gguf")
        );
        assert_eq!(
            info.sha256,
            "2fa1a5f179f8a511a53e2108db270aa4af3ce08cd976af4180e2854666bb4ba3"
        );
        assert_eq!(info.size_bytes, 1_668_741_440);
        assert!(matches!(info.status, ModelStatus::Missing));
    }

    #[test]
    fn status_serializes_in_the_shape_the_ui_expects() {
        let info = spec("parakeet-ultra-Q8_0").model_info(
            Path::new("/models"),
            ModelStatus::Downloading { progress: 7 },
        );
        let json = serde_json::to_value(&info).unwrap();

        assert_eq!(json["status"]["Downloading"]["progress"], 7);
        assert_eq!(json["quantization"], "Q8_0");

        let corrupted = serde_json::to_value(ModelStatus::Corrupted {
            file_size: 10,
            expected_min_size: 20,
        })
        .unwrap();
        assert_eq!(corrupted["Corrupted"]["file_size"], 10);
        assert_eq!(corrupted["Corrupted"]["expected_min_size"], 20);
    }
}
