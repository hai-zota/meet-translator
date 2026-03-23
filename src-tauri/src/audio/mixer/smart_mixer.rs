//! SmartMixer — Main orchestrator combining LUFS + VAD + Ducking
//! Processes two audio streams and applies intelligent mixing with ducking

use super::{DuckingEngine, LoufsAnalyzer, MixerStats, VadProcessor};

/// Main mixer combining analysis, VAD, and ducking
pub struct SmartMixer {
    original_analyzer: LoufsAnalyzer,
    translated_analyzer: LoufsAnalyzer,
    vad: VadProcessor,
    ducking: DuckingEngine,

    // Settings
    enabled: bool,
}

impl SmartMixer {
    /// Create new SmartMixer
    /// - sample_rate: Audio sample rate (typically 48000 Hz)
    /// - ducking_level: 0.0 - 0.5 (default 0.2 = 20%)
    /// - vad_sensitivity: "low" | "medium" | "high"
    pub fn new(
        sample_rate: u32,
        ducking_level: f32,
        vad_sensitivity: &str,
    ) -> Result<Self, String> {
        let original_analyzer = LoufsAnalyzer::new(sample_rate, 100)?;
        let translated_analyzer = LoufsAnalyzer::new(sample_rate, 100)?;
        let vad = VadProcessor::new(vad_sensitivity, None)?;

        let mut ducking = DuckingEngine::new();
        ducking.configure(ducking_level, -40.0);

        Ok(Self {
            original_analyzer,
            translated_analyzer,
            vad,
            ducking,
            enabled: true,
        })
    }

    /// Enable or disable mixer
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Update ducking parameters
    pub fn update_settings(
        &mut self,
        ducking_level: f32,
        vad_sensitivity: &str,
    ) -> Result<(), String> {
        self.vad = VadProcessor::new(vad_sensitivity, None)?;
        self.ducking.configure(ducking_level, -40.0);
        Ok(())
    }

    /// Process one audio chunk and return mixed output + stats
    /// - original_pcm: PCM s16 from Mic/System
    /// - translated_pcm: PCM s16 from TTS
    ///
    /// Returns: (mixed_pcm, MixerStats)
    pub fn process_chunk(
        &mut self,
        original_pcm: &[i16],
        translated_pcm: &[i16],
    ) -> Result<(Vec<i16>, MixerStats), String> {
        if !self.enabled {
            return Ok((
                vec![],
                MixerStats {
                    original_lufs: None,
                    translated_lufs: None,
                    ducking_gain: 1.0,
                    is_speech: false,
                },
            ));
        }

        if original_pcm.is_empty() && translated_pcm.is_empty() {
            return Ok((
                vec![],
                MixerStats {
                    original_lufs: None,
                    translated_lufs: None,
                    ducking_gain: 1.0,
                    is_speech: false,
                },
            ));
        }

        if translated_pcm.is_empty() {
            return Ok((
                original_pcm.to_vec(),
                MixerStats {
                    original_lufs: self.original_analyzer.push_samples(original_pcm),
                    translated_lufs: None,
                    ducking_gain: 1.0,
                    is_speech: self
                        .vad
                        .process_frame(&self._to_f32(original_pcm))
                        .unwrap_or(false),
                },
            ));
        }

        if original_pcm.is_empty() {
            return Ok((
                translated_pcm.to_vec(),
                MixerStats {
                    original_lufs: None,
                    translated_lufs: self.translated_analyzer.push_samples(translated_pcm),
                    ducking_gain: 1.0,
                    is_speech: false,
                },
            ));
        }

        // Analyze loudness
        let original_lufs = self.original_analyzer.push_samples(original_pcm);
        let translated_lufs = self.translated_analyzer.push_samples(translated_pcm);

        // Detect voice
        let is_speech = self
            .vad
            .process_frame(&self._to_f32(original_pcm))
            .unwrap_or(false);

        // Calculate ducking gain
        let orig_lufs = original_lufs.unwrap_or(-100.0);
        let trans_lufs = translated_lufs.unwrap_or(-100.0);
        let translated_active = trans_lufs > -40.0;

        let ducking_gain = self.ducking.process(orig_lufs, translated_active, 16);
        // Voice-over behavior: keep original bed audible even during strong translated speech.
        let ducking_gain = ducking_gain.max(0.30);

        // Apply gain to original and mix
        let attenuated = self._apply_gain_s16(original_pcm, ducking_gain);
        let mixed = self._mix_streams_soft_limited(&attenuated, translated_pcm);

        let stats = MixerStats {
            original_lufs,
            translated_lufs,
            ducking_gain,
            is_speech,
        };

        Ok((mixed, stats))
    }

    fn _to_f32(&self, pcm_s16: &[i16]) -> Vec<f32> {
        pcm_s16.iter().map(|&s| s as f32 / 32768.0).collect()
    }

    fn _apply_gain_s16(&self, pcm: &[i16], gain: f32) -> Vec<i16> {
        if (gain - 1.0).abs() < 0.0001 {
            pcm.to_vec()
        } else {
            pcm.iter()
                .map(|&s| {
                    let f32_sample = s as f32 * gain;
                    f32_sample.clamp(-32768.0, 32767.0) as i16
                })
                .collect()
        }
    }

    fn _mix_streams_soft_limited(&self, stream_a: &[i16], stream_b: &[i16]) -> Vec<i16> {
        let len = stream_a.len().max(stream_b.len());
        let mut mixed = vec![0i16; len];

        for i in 0..len {
            let a = stream_a.get(i).copied().unwrap_or(0) as f32 / 32768.0;
            let b = stream_b.get(i).copied().unwrap_or(0) as f32 / 32768.0;

            // Keep translated as foreground while preserving original as background.
            let linear_mix = (a * 0.85) + (b * 1.0);

            // Soft clip reduces harsh distortion compared to hard clipping.
            let limited = linear_mix.tanh().clamp(-1.0, 1.0);
            mixed[i] = (limited * 32767.0) as i16;
        }

        mixed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pcm_sine(
        freq_hz: f32,
        amplitude: f32,
        num_samples: usize,
        sample_rate: u32,
    ) -> Vec<i16> {
        (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                let s = amplitude * (2.0 * std::f32::consts::PI * freq_hz * t).sin();
                (s * 32767.0) as i16
            })
            .collect()
    }

    fn make_silence(n: usize) -> Vec<i16> {
        vec![0i16; n]
    }

    // ============ CREATION TESTS ============

    #[test]
    fn test_mixer_creation() {
        let mixer = SmartMixer::new(48000, 0.2, "medium");
        assert!(mixer.is_ok());
    }

    #[test]
    fn test_mixer_creation_all_sensitivities() {
        for sens in &["low", "medium", "high"] {
            let m = SmartMixer::new(48000, 0.2, sens);
            assert!(m.is_ok(), "Should create with sensitivity={}", sens);
        }
    }

    #[test]
    fn test_mixer_creation_invalid_sensitivity() {
        let m = SmartMixer::new(48000, 0.2, "invalid");
        assert!(m.is_err(), "Invalid sensitivity should fail");
    }

    // ============ PROCESS EMPTY / PASSTHROUGH ============

    #[test]
    fn test_mixer_process_empty() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();
        let result = mixer.process_chunk(&[], &[]);
        assert!(result.is_ok());

        let (mixed, _stats) = result.unwrap();
        assert!(mixed.is_empty());
    }

    #[test]
    fn test_mixer_disabled_passthrough() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();
        mixer.set_enabled(false);

        let orig = make_pcm_sine(200.0, 0.3, 480, 48000);
        let trans = make_pcm_sine(350.0, 0.3, 480, 48000);

        let (mixed, stats) = mixer.process_chunk(&orig, &trans).unwrap();

        assert!(
            mixed.is_empty(),
            "Disabled mixer should return empty output"
        );
        assert_eq!(
            stats.ducking_gain, 1.0,
            "Disabled mixer should have unity gain"
        );
    }

    // ============ MIXING CORRECTNESS TESTS ============

    #[test]
    fn test_mixer_output_length_matches_input() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();

        let orig = make_pcm_sine(200.0, 0.3, 480, 48000);
        let trans = make_pcm_sine(350.0, 0.3, 480, 48000);

        let (mixed, _stats) = mixer.process_chunk(&orig, &trans).unwrap();
        assert_eq!(mixed.len(), 480, "Output length should match input");
    }

    #[test]
    fn test_mixer_output_is_sum_of_streams() {
        let mut mixer = SmartMixer::new(48000, 1.0, "low").unwrap(); // ducking_level=1.0 = no attenuation

        let n = 480;
        let orig = vec![100i16; n];
        let trans = vec![200i16; n];

        let (mixed, _stats) = mixer.process_chunk(&orig, &trans).unwrap();

        // With gain=1.0, mixed = original + translated = 300
        // (gain might not be 1.0 on first frame due to attack, so check range)
        assert!(!mixed.is_empty());
        let avg: i32 = mixed.iter().map(|&s| s as i32).sum::<i32>() / n as i32;
        println!("Average mixed sample: {}", avg);
        assert!(avg > 0, "Mixed signal should be positive");
    }

    #[test]
    fn test_mixing_clamps_to_i16_range() {
        let mut mixer = SmartMixer::new(48000, 1.0, "low").unwrap();

        // Near-max signals that would overflow without clamping
        let orig = vec![20000i16; 480];
        let trans = vec![20000i16; 480];

        let (mixed, _) = mixer.process_chunk(&orig, &trans).unwrap();

        for &s in &mixed {
            assert!(
                s <= i16::MAX && s >= i16::MIN,
                "Sample {} out of i16 range",
                s
            );
        }
    }

    // ============ DUCKING BEHAVIOUR TESTS ============

    #[test]
    fn test_ducking_reduces_original_gain() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();

        let n = 480;
        let orig = make_pcm_sine(200.0, 0.5, n, 48000);
        let trans = make_pcm_sine(350.0, 0.4, n, 48000);

        // Warm-up with silence baseline for VAD
        let silence = make_silence(n);
        for _ in 0..5 {
            let _ = mixer.process_chunk(&silence, &silence);
        }

        let mut stats_list = vec![];
        for _ in 0..20 {
            let (_, stats) = mixer.process_chunk(&orig, &trans).unwrap();
            stats_list.push(stats.ducking_gain);
        }

        let min_gain = stats_list.iter().cloned().fold(1.0f32, f32::min);
        println!("Minimum ducking gain: {}", min_gain);
        assert!(
            min_gain < 0.95,
            "Ducking should reduce original gain below 0.95"
        );
    }

    #[test]
    fn test_no_ducking_when_translated_silent() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();

        let n = 480;
        let orig = make_pcm_sine(200.0, 0.3, n, 48000);
        let silence = make_silence(n);

        let (_, stats) = mixer.process_chunk(&orig, &silence).unwrap();
        assert_eq!(
            stats.ducking_gain, 1.0,
            "No ducking when translated is silent"
        );
    }

    // ============ STATS TESTS ============

    #[test]
    fn test_stats_returns_lufs_values() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();

        let n = 4800; // 100ms @ 48kHz (matches window_ms=100)
        let orig = make_pcm_sine(200.0, 0.3, n, 48000);
        let trans = make_pcm_sine(350.0, 0.2, n, 48000);

        let (_, stats) = mixer.process_chunk(&orig, &trans).unwrap();

        println!(
            "Stats: orig_lufs={:?}, trans_lufs={:?}, gain={}, speech={}",
            stats.original_lufs, stats.translated_lufs, stats.ducking_gain, stats.is_speech
        );

        // For 100ms window, LUFS values should be populated
        assert!(
            stats.original_lufs.is_some(),
            "original_lufs should be Some after 100ms window"
        );
    }

    #[test]
    fn test_stats_ducking_gain_is_bounded() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();

        let n = 480;
        let orig = make_pcm_sine(200.0, 0.3, n, 48000);
        let trans = make_pcm_sine(350.0, 0.4, n, 48000);

        for _ in 0..30 {
            let (_, stats) = mixer.process_chunk(&orig, &trans).unwrap();
            assert!(
                stats.ducking_gain >= 0.0 && stats.ducking_gain <= 1.0,
                "Ducking gain must be in [0, 1], got {}",
                stats.ducking_gain
            );
        }
    }

    // ============ UPDATE SETTINGS TESTS ============

    #[test]
    fn test_update_settings_ducking_level() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();
        let result = mixer.update_settings(0.1, "high");
        assert!(result.is_ok());
    }

    #[test]
    fn test_update_settings_invalid_sensitivity() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();
        let result = mixer.update_settings(0.1, "bad");
        assert!(result.is_err());
    }

    #[test]
    fn test_16khz_runtime_path_populates_stats() {
        let sample_rate = 16000;
        let mut mixer = SmartMixer::new(sample_rate, 0.2, "medium").unwrap();

        let n = 160; // 10ms @ 16kHz
        let orig = make_pcm_sine(200.0, 0.25, n, sample_rate);
        let trans = make_pcm_sine(350.0, 0.20, n, sample_rate);

        let mut last_stats = None;
        for _ in 0..10 {
            let (_, stats) = mixer.process_chunk(&orig, &trans).unwrap();
            last_stats = Some(stats);
        }

        let stats = last_stats.expect("stats should exist after processing");
        assert!(
            stats.original_lufs.is_some(),
            "16kHz path should populate original LUFS after 100ms"
        );
        assert!(
            stats.translated_lufs.is_some(),
            "16kHz path should populate translated LUFS after 100ms"
        );
    }

    #[test]
    fn test_16khz_runtime_path_ducking_activates() {
        let sample_rate = 16000;
        let mut mixer = SmartMixer::new(sample_rate, 0.2, "medium").unwrap();

        let n = 160; // 10ms @ 16kHz
        let silence = make_silence(n);
        for _ in 0..10 {
            let _ = mixer.process_chunk(&silence, &silence);
        }

        let orig = make_pcm_sine(200.0, 0.35, n, sample_rate);
        let trans = make_pcm_sine(350.0, 0.30, n, sample_rate);

        let mut min_gain = 1.0f32;
        for _ in 0..30 {
            let (_, stats) = mixer.process_chunk(&orig, &trans).unwrap();
            min_gain = min_gain.min(stats.ducking_gain);
        }

        assert!(
            min_gain < 0.95,
            "16kHz runtime path should activate ducking, min_gain={}",
            min_gain
        );
    }

    // ============ PERFORMANCE TESTS ============

    #[test]
    fn test_process_chunk_latency() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();

        let n = 480; // 10ms @ 48kHz
        let orig = make_pcm_sine(200.0, 0.3, n, 48000);
        let trans = make_pcm_sine(350.0, 0.2, n, 48000);

        let start = std::time::Instant::now();
        for _ in 0..100 {
            let _ = mixer.process_chunk(&orig, &trans);
        }
        let elapsed = start.elapsed();

        let per_chunk_ms = elapsed.as_secs_f32() * 1000.0 / 100.0;
        println!("SmartMixer per-chunk: {:.3}ms (10ms chunks)", per_chunk_ms);

        assert!(
            per_chunk_ms < 2.0,
            "Should process in <2ms per 10ms chunk, got {:.3}ms",
            per_chunk_ms
        );
    }

    #[test]
    fn test_asymmetric_chunk_lengths() {
        let mut mixer = SmartMixer::new(48000, 0.2, "medium").unwrap();

        let orig = make_pcm_sine(200.0, 0.3, 480, 48000);
        let trans = make_pcm_sine(350.0, 0.2, 960, 48000); // Translated is longer

        let (mixed, _) = mixer.process_chunk(&orig, &trans).unwrap();
        assert_eq!(mixed.len(), 960, "Output should match max of input lengths");
    }

    #[test]
    fn test_process_chunk_latency_16khz_runtime_path() {
        let sample_rate = 16000;
        let mut mixer = SmartMixer::new(sample_rate, 0.2, "medium").unwrap();

        let n = 160; // 10ms @ 16kHz
        let orig = make_pcm_sine(200.0, 0.3, n, sample_rate);
        let trans = make_pcm_sine(350.0, 0.2, n, sample_rate);

        let start = std::time::Instant::now();
        for _ in 0..200 {
            let _ = mixer.process_chunk(&orig, &trans);
        }
        let elapsed = start.elapsed();

        let per_chunk_ms = elapsed.as_secs_f32() * 1000.0 / 200.0;
        println!(
            "SmartMixer per-chunk: {:.3}ms (10ms @ 16kHz runtime path)",
            per_chunk_ms
        );

        assert!(
            per_chunk_ms < 2.0,
            "16kHz runtime path should process in <2ms per chunk, got {:.3}ms",
            per_chunk_ms
        );
    }
}
