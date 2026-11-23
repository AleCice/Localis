//! Audio/video containers (v0.5): probing at import (duration, video size, presence of an
//! audio track) and decoding of the audio track to the 16 kHz mono `f32` samples Whisper
//! expects. Pure Rust (symphonia + rubato): no system ffmpeg.
//!
//! Probing reads only the container headers (for MP4 the `moov` box, wherever it is), never
//! the whole file. Decoding streams packets from the file and resamples incrementally, so
//! only the 16 kHz output is kept in memory (about 230 MB per hour of audio).

use std::sync::atomic::{AtomicBool, Ordering};

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;

/// Sample rate expected by Whisper.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;
/// Longest recording that is transcribed (the 16 kHz samples are kept in memory).
pub const TRANSCRIBE_MAX_MS: u64 = 6 * 60 * 60 * 1000;
/// Input frames per resampler call.
const RESAMPLE_CHUNK: usize = 1024;

/// What the container says about a recording.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MediaInfo {
    pub duration_ms: Option<u64>,
    /// Width × height of the first video track, if any.
    pub video_size: Option<(u32, u32)>,
    /// At least one audio track (decodable or not).
    pub has_audio_track: bool,
    /// The default audio track uses a codec this build can decode (MP3, AAC, PCM).
    pub audio_decodable: bool,
}

fn open_format(
    source: Box<dyn MediaSource>,
    ext: &str,
) -> std::result::Result<Box<dyn FormatReader>, SymphoniaError> {
    let mss = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    hint.with_extension(ext);
    symphonia::default::get_probe().probe(
        &hint,
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    )
}

/// Reads the container headers. `Err` (technical detail) when the file is not a readable
/// container of a supported format.
pub(crate) fn probe(
    source: Box<dyn MediaSource>,
    ext: &str,
) -> std::result::Result<MediaInfo, String> {
    let format = open_format(source, ext).map_err(|e| e.to_string())?;
    let mut info = MediaInfo::default();
    let mut longest: Option<u64> = None;
    for track in format.tracks() {
        let ms = match (track.time_base, track.duration) {
            (Some(tb), Some(dur)) => tb
                .calc_duration(dur)
                .and_then(|t| u64::try_from(t.as_millis()).ok()),
            _ => None,
        };
        match &track.codec_params {
            Some(CodecParameters::Audio(params)) => {
                info.has_audio_track = true;
                // Duration from the frame count when the container has no explicit duration.
                let ms = ms.or_else(|| {
                    let rate = u64::from(params.sample_rate?);
                    let frames = track.num_frames?;
                    (rate > 0).then(|| frames.saturating_mul(1000) / rate)
                });
                longest = longest.max(ms);
            }
            Some(CodecParameters::Video(params)) => {
                if info.video_size.is_none() {
                    if let (Some(w), Some(h)) = (params.width, params.height) {
                        if w > 0 && h > 0 {
                            info.video_size = Some((u32::from(w), u32::from(h)));
                        }
                    }
                }
                longest = longest.max(ms);
            }
            _ => {}
        }
    }
    info.duration_ms = longest;
    if let Some(track) = format.default_track(TrackType::Audio) {
        if let Some(params) = track.codec_params.as_ref().and_then(|p| p.audio()) {
            info.audio_decodable = symphonia::default::get_codecs()
                .make_audio_decoder(params, &AudioDecoderOptions::default())
                .is_ok();
        }
    }
    Ok(info)
}

/// Why decoding stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// No audio track, or a codec this build cannot decode.
    Unsupported(String),
    /// The audio data is damaged.
    Corrupt(String),
    /// Longer than [`TRANSCRIBE_MAX_MS`].
    TooLong,
    Cancelled,
}

/// Decoded audio ready for Whisper.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    /// 16 kHz mono samples in −1..1.
    pub samples: Vec<f32>,
}

impl DecodedAudio {
    pub fn duration_ms(&self) -> u64 {
        self.samples.len() as u64 * 1000 / u64::from(WHISPER_SAMPLE_RATE)
    }
}

/// Decodes the default audio track of `source` to 16 kHz mono. `progress` receives the
/// fraction (0..1) of the track decoded so far, when the duration is known; `cancel` is
/// checked between packets.
pub fn decode_to_whisper(
    source: Box<dyn MediaSource>,
    ext: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> std::result::Result<DecodedAudio, DecodeError> {
    let mut format = open_format(source, ext).map_err(|e| DecodeError::Corrupt(e.to_string()))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| DecodeError::Unsupported("no audio track".into()))?;
    let track_id = track.id;
    let total = track.duration.map(|d| d.get()).filter(|&d| d > 0);
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| DecodeError::Unsupported("audio track without codec parameters".into()))?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| DecodeError::Unsupported(e.to_string()))?;

    let max_samples = (TRANSCRIBE_MAX_MS / 1000) as usize * WHISPER_SAMPLE_RATE as usize;
    let mut resampler: Option<(u32, MonoResampler)> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::new();
    let (mut packets, mut bad_packets) = (0u64, 0u64);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(DecodeError::Cancelled);
        }
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // A truncated file ends the stream: keep what was decoded.
            Err(SymphoniaError::IoError(_)) => break,
            Err(err) => return Err(DecodeError::Corrupt(err.to_string())),
        };
        if packet.track_id != track_id {
            continue;
        }
        packets += 1;
        if let Some(total) = total {
            let pts = u64::try_from(packet.pts.get()).unwrap_or(0);
            progress((pts as f32 / total as f32).clamp(0.0, 1.0));
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => {
                bad_packets += 1;
                continue;
            }
            Err(err) => return Err(DecodeError::Corrupt(err.to_string())),
        };
        let rate = decoded.spec().rate();
        let channels = decoded.spec().channels().count().max(1);
        if rate == 0 {
            return Err(DecodeError::Unsupported("sample rate 0".into()));
        }
        interleaved.resize(decoded.samples_interleaved(), 0.0);
        decoded.copy_to_slice_interleaved(&mut interleaved);
        mono.clear();
        mono.extend(
            interleaved
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
        match &mut resampler {
            None => {
                let mut r = MonoResampler::new(rate)?;
                r.push(&mono, &mut out)?;
                resampler = Some((rate, r));
            }
            Some((first_rate, r)) => {
                if *first_rate != rate {
                    return Err(DecodeError::Unsupported(format!(
                        "sample rate changed from {first_rate} to {rate}"
                    )));
                }
                r.push(&mono, &mut out)?;
            }
        }
        if out.len() > max_samples {
            return Err(DecodeError::TooLong);
        }
    }
    if packets > 0 && bad_packets * 2 > packets {
        return Err(DecodeError::Corrupt(format!(
            "{bad_packets} of {packets} packets could not be decoded"
        )));
    }
    if let Some((_, r)) = resampler {
        r.finish(&mut out)?;
    }
    if out.len() > max_samples {
        return Err(DecodeError::TooLong);
    }
    progress(1.0);
    Ok(DecodedAudio { samples: out })
}

/// Streaming mono resampler to 16 kHz (band-limited sinc interpolation), or a plain copy
/// when the input is already at 16 kHz.
struct MonoResampler {
    inner: Option<Async<f32>>,
    ratio: f64,
    pending: Vec<f32>,
    consumed: u64,
    produced: Vec<f32>,
    delay_dropped: bool,
}

fn resample_err(err: impl std::fmt::Display) -> DecodeError {
    DecodeError::Corrupt(format!("resampler: {err}"))
}

impl MonoResampler {
    fn new(rate: u32) -> std::result::Result<Self, DecodeError> {
        let ratio = f64::from(WHISPER_SAMPLE_RATE) / f64::from(rate);
        let inner = if rate == WHISPER_SAMPLE_RATE {
            None
        } else {
            let mut params = SincInterpolationParameters::new(128, WindowFunction::BlackmanHarris2);
            params.oversampling_factor = 128;
            params.interpolation = SincInterpolationType::Cubic;
            Some(
                Async::<f32>::new_sinc(ratio, 1.0, &params, RESAMPLE_CHUNK, 1, FixedAsync::Input)
                    .map_err(resample_err)?,
            )
        };
        Ok(MonoResampler {
            inner,
            ratio,
            pending: Vec::new(),
            consumed: 0,
            produced: Vec::new(),
            delay_dropped: false,
        })
    }

    /// Feeds input samples; appends the samples ready so far to `out`.
    fn push(&mut self, input: &[f32], out: &mut Vec<f32>) -> std::result::Result<(), DecodeError> {
        let Some(inner) = &mut self.inner else {
            out.extend_from_slice(input);
            return Ok(());
        };
        self.consumed += input.len() as u64;
        self.pending.extend_from_slice(input);
        let mut start = 0;
        while self.pending.len() - start >= RESAMPLE_CHUNK {
            let chunk = &self.pending[start..start + RESAMPLE_CHUNK];
            let adapter = InterleavedSlice::new(chunk, 1, RESAMPLE_CHUNK).map_err(resample_err)?;
            let result = inner.process(&adapter, None).map_err(resample_err)?;
            self.produced.extend(result.take_data());
            start += RESAMPLE_CHUNK;
        }
        self.pending.drain(..start);
        let delay = inner.output_delay();
        self.drain_into(out, delay);
        Ok(())
    }

    /// Moves the produced samples to `out`, dropping once the `delay` samples of silence
    /// the filter puts in front of the signal.
    fn drain_into(&mut self, out: &mut Vec<f32>, delay: usize) {
        if !self.delay_dropped {
            if self.produced.len() <= delay {
                return;
            }
            self.produced.drain(..delay);
            self.delay_dropped = true;
        }
        out.append(&mut self.produced);
    }

    /// Flushes the filter and trims the output to the exact expected length.
    fn finish(mut self, out: &mut Vec<f32>) -> std::result::Result<(), DecodeError> {
        let Some(inner) = &mut self.inner else {
            return Ok(());
        };
        let expected = (self.consumed as f64 * self.ratio).round() as usize;
        let delay = inner.output_delay();
        let mut guard = 0;
        loop {
            let pending_delay = if self.delay_dropped { 0 } else { delay };
            let have = out.len() + self.produced.len().saturating_sub(pending_delay);
            if have >= expected || guard > 64 {
                break;
            }
            // Pad the remaining input with silence to a full chunk.
            let mut chunk = std::mem::take(&mut self.pending);
            chunk.resize(RESAMPLE_CHUNK, 0.0);
            let adapter = InterleavedSlice::new(&chunk, 1, RESAMPLE_CHUNK).map_err(resample_err)?;
            let result = inner.process(&adapter, None).map_err(resample_err)?;
            self.produced.extend(result.take_data());
            guard += 1;
        }
        let delay = inner.output_delay();
        self.drain_into(out, delay);
        out.truncate(expected);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, secs: f32, freq: f32) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    fn resample(rate: u32, input: &[f32], piece: usize) -> Vec<f32> {
        let mut r = MonoResampler::new(rate).unwrap();
        let mut out = Vec::new();
        for chunk in input.chunks(piece) {
            r.push(chunk, &mut out).unwrap();
        }
        r.finish(&mut out).unwrap();
        out
    }

    /// Estimated frequency from zero crossings.
    fn frequency(samples: &[f32], rate: u32) -> f32 {
        let crossings = samples
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        crossings as f32 * rate as f32 / samples.len() as f32
    }

    #[test]
    fn resampling_keeps_length_and_pitch() {
        for rate in [8_000, 22_050, 44_100, 48_000] {
            let input = sine(rate, 2.0, 440.0);
            for piece in [100, 1024, 5000] {
                let out = resample(rate, &input, piece);
                let expected = (input.len() as f64 * 16_000.0 / f64::from(rate)).round() as usize;
                assert_eq!(out.len(), expected, "rate {rate} piece {piece}");
                let f = frequency(&out[1000..out.len() - 1000], 16_000);
                assert!((f - 440.0).abs() < 5.0, "rate {rate}: {f} Hz");
                // No delay prefix: the signal starts right away.
                assert!(out[50..200].iter().any(|s| s.abs() > 0.1), "rate {rate}");
                assert!(out.iter().all(|s| s.abs() < 0.7));
            }
        }
    }

    #[test]
    fn sixteen_khz_is_copied() {
        let input = sine(16_000, 0.5, 300.0);
        assert_eq!(resample(16_000, &input, 333), input);
    }

    #[test]
    fn high_frequencies_are_filtered_not_aliased() {
        // 7.9 kHz at 44.1 kHz is just below the 8 kHz Nyquist of the output; 12 kHz is above
        // and must be removed rather than folded back.
        let input = sine(44_100, 1.0, 12_000.0);
        let out = resample(44_100, &input, 4096);
        let rms = (out[2000..14000].iter().map(|s| s * s).sum::<f32>() / 12000.0).sqrt();
        assert!(rms < 0.01, "rms {rms}");
    }
}
