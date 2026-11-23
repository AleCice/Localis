//! v0.5 local speech recognition with whisper.cpp (crate `whisper-rs`, CPU only). This is
//! the only module that touches whisper: the transcription worker talks to it through the
//! [`Transcriber`] trait, so everything else is tested without a model.

use std::ffi::{c_int, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Once;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Languages offered for transcription (`TranscriptionLanguage` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Auto,
    It,
    En,
    Fr,
    De,
    Es,
}

impl Language {
    pub const ALL: [Language; 6] = [
        Language::Auto,
        Language::It,
        Language::En,
        Language::Fr,
        Language::De,
        Language::Es,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Language::Auto => "auto",
            Language::It => "it",
            Language::En => "en",
            Language::Fr => "fr",
            Language::De => "de",
            Language::Es => "es",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Language::ALL.into_iter().find(|l| l.as_str() == s)
    }
}

/// One recognised segment (times in milliseconds from the start of the audio).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecognizedSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Output of a transcription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recognized {
    /// ISO 639-1 code: the chosen language, or the detected one for `auto`.
    pub language: String,
    pub segments: Vec<RecognizedSegment>,
}

/// Why a transcription did not complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscribeError {
    /// The model file could not be loaded.
    Model(String),
    /// Stopped through the abort flag.
    Cancelled,
    Failed(String),
}

/// Input of one transcription. `progress` receives 0–100; `abort` is polled by the engine.
pub struct TranscribeRequest<'a> {
    pub model_path: &'a Path,
    /// 16 kHz mono samples.
    pub samples: &'a [f32],
    pub language: Language,
    pub threads: usize,
    pub progress: &'a AtomicI32,
    pub abort: &'a AtomicBool,
}

/// Speech recognition engine (whisper.cpp in the app, a fake in tests).
pub trait Transcriber: Send + Sync {
    fn transcribe(&self, request: &TranscribeRequest<'_>) -> Result<Recognized, TranscribeError>;
}

/// Threads for whisper: all cores but one (at least one), so the UI stays responsive.
pub fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1))
        .unwrap_or(1)
        .max(1)
}

/// whisper.cpp through `whisper-rs`.
#[derive(Debug, Default, Clone, Copy)]
pub struct WhisperTranscriber;

static LOGGING: Once = Once::new();

unsafe extern "C" fn on_progress(
    _ctx: *mut whisper_rs::WhisperSysContext,
    _state: *mut whisper_rs::WhisperSysState,
    progress: c_int,
    user_data: *mut c_void,
) {
    // SAFETY: `user_data` is the `&AtomicI32` set in `transcribe`, alive for the whole
    // `full` call that invokes this callback.
    let target = unsafe { &*(user_data as *const AtomicI32) };
    target.store(progress.clamp(0, 100), Ordering::Relaxed);
}

unsafe extern "C" fn should_abort(user_data: *mut c_void) -> bool {
    // SAFETY: `user_data` is the `&AtomicBool` set in `transcribe` (see above).
    let flag = unsafe { &*(user_data as *const AtomicBool) };
    flag.load(Ordering::Relaxed)
}

/// Bracketed or parenthesised-only output such as `[BLANK_AUDIO]` or `(musica)` is not speech.
pub fn is_non_speech(text: &str) -> bool {
    let t = text.trim();
    t.is_empty()
        || (t.starts_with('[') && t.ends_with(']'))
        || (t.starts_with('(') && t.ends_with(')'))
        || (t.starts_with('*') && t.ends_with('*'))
        || t.chars().all(|c| !c.is_alphanumeric())
}

impl Transcriber for WhisperTranscriber {
    fn transcribe(&self, request: &TranscribeRequest<'_>) -> Result<Recognized, TranscribeError> {
        // whisper.cpp logs heavily to stderr; route it to the (absent) log backend.
        LOGGING.call_once(whisper_rs::install_logging_hooks);
        let mut ctx_params = WhisperContextParameters::default();
        ctx_params.use_gpu(false);
        let ctx = WhisperContext::new_with_params(request.model_path, ctx_params)
            .map_err(|e| TranscribeError::Model(e.to_string()))?;
        let mut state = ctx
            .create_state()
            .map_err(|e| TranscribeError::Model(e.to_string()))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
        params.set_language(Some(request.language.as_str()));
        params.set_translate(false);
        params.set_n_threads(c_int::try_from(request.threads.max(1)).unwrap_or(1));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_nst(true);
        params.set_token_timestamps(false);
        // SAFETY: both callbacks only read/write the atomics passed as user data, which
        // outlive `state.full` (borrowed from `request` for the whole call).
        unsafe {
            params.set_progress_callback(Some(on_progress));
            params.set_progress_callback_user_data(
                request.progress as *const AtomicI32 as *mut c_void,
            );
            params.set_abort_callback(Some(should_abort));
            params.set_abort_callback_user_data(request.abort as *const AtomicBool as *mut c_void);
        }
        let result = state.full(params, request.samples);
        if request.abort.load(Ordering::SeqCst) {
            return Err(TranscribeError::Cancelled);
        }
        result.map_err(|e| TranscribeError::Failed(e.to_string()))?;

        let language = match request.language {
            Language::Auto => whisper_rs::get_lang_str(state.full_lang_id_from_state())
                .unwrap_or("auto")
                .to_owned(),
            other => other.as_str().to_owned(),
        };
        let mut segments = Vec::new();
        for segment in state.as_iter() {
            let text = segment
                .to_str_lossy()
                .map(|t| t.trim().to_owned())
                .unwrap_or_default();
            if is_non_speech(&text) {
                continue;
            }
            // Timestamps are in centiseconds.
            let start = u64::try_from(segment.start_timestamp()).unwrap_or(0) * 10;
            let end = (u64::try_from(segment.end_timestamp()).unwrap_or(0) * 10).max(start);
            segments.push(RecognizedSegment {
                start_ms: start,
                end_ms: end,
                text,
            });
        }
        request.progress.store(100, Ordering::Relaxed);
        Ok(Recognized { language, segments })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_round_trip() {
        for l in Language::ALL {
            assert_eq!(Language::parse(l.as_str()), Some(l));
        }
        assert_eq!(Language::parse("pt"), None);
    }

    #[test]
    fn non_speech_markers() {
        for t in ["[BLANK_AUDIO]", " (musica) ", "*applausi*", "...", "", "♪"] {
            assert!(is_non_speech(t), "{t:?}");
        }
        assert!(!is_non_speech("La derivata."));
    }

    #[test]
    fn threads_leave_one_core() {
        let n = default_threads();
        assert!(n >= 1);
        if let Ok(cores) = std::thread::available_parallelism() {
            assert!(n <= cores.get().max(1));
        }
    }
}
