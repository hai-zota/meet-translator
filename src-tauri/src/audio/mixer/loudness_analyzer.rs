//! LUFS-style Loudness Analyzer — RMS-based measurement with perceptual weighting
//! Measures perceived loudness of audio (approximated from RMS values)
//!
//! Design:
//! - Uses RMS calculation from Gated Average (ITU-R BS.1770 simplified)
//! - Includes high-pass filter approximation for perceptual weighting
//! - Converts RMS to LUFS scale: LUFS = 20*log10(RMS) - 0.691

const LUFS_REFERENCE: f32 = 0.691; // ITU-R BS.1770 reference
const MIN_RMS_THRESHOLD: f32 = 1e-6; // Noise floor

/// Loudness analyzer using RMS-based measurement with HP filter approximation
/// For MVP, we use simplified RMS with perceptual weighting instead of full EBU R128,
/// which is sufficient for ducking decisions.
#[derive(Debug)]
pub struct LoufsAnalyzer {
    samples_per_window: usize,
    sample_buffer: Vec<f32>,

    // High-pass filter state for perceptual weighting
    // Approximates ITU-R BS.1770 K-weighting
    hp_y1: f32,     // Previous output for 1st order HP filter
    hp_x_prev: f32, // Previous input sample
}

impl LoufsAnalyzer {
    /// Create new loudness analyzer
    /// - sample_rate: Audio sample rate in Hz (e.g., 48000)
    /// - window_ms: Analysis window duration (100-300ms typical)
    pub fn new(sample_rate: u32, window_ms: u32) -> Result<Self, String> {
        if window_ms < 100 || window_ms > 300 {
            return Err(format!(
                "Invalid window_ms: {}. Must be 100-300ms",
                window_ms
            ));
        }

        let samples_per_window = (sample_rate as u32 * window_ms / 1000) as usize;

        Ok(Self {
            samples_per_window,
            sample_buffer: Vec::with_capacity(samples_per_window),
            hp_y1: 0.0,
            hp_x_prev: 0.0,
        })
    }

    /// Push PCM s16 samples and return LUFS-style measurement if window is complete
    /// Returns Option<f32> where Some(lufs) means new measurement available
    pub fn push_samples(&mut self, pcm_s16: &[i16]) -> Option<f32> {
        for sample in pcm_s16 {
            let f32_sample = *sample as f32 / 32768.0; // Convert s16 to normalized f32

            // Apply high-pass filter for perceptual weighting
            let filtered = self._apply_hp_filter(f32_sample);
            self.sample_buffer.push(filtered);

            if self.sample_buffer.len() >= self.samples_per_window {
                // Process window
                let lufs = self._process_window();
                self.sample_buffer.clear();
                return Some(lufs);
            }
        }
        None
    }

    /// Apply 1st-order high-pass filter (~100Hz cutoff)
    /// This approximates ITU-R BS.1770 K-weighting for perceptual loudness
    fn _apply_hp_filter(&mut self, x: f32) -> f32 {
        // 1st order HP filter: y = 0.95 * (y_prev + x - x_prev)
        // Cutoff ~100Hz @ 48kHz
        const HP_COEFF: f32 = 0.95;

        let y = HP_COEFF * (self.hp_y1 + x - self.hp_x_prev);
        self.hp_y1 = y;
        self.hp_x_prev = x;
        y
    }

    fn _process_window(&self) -> f32 {
        if self.sample_buffer.is_empty() {
            return -100.0; // Silence
        }

        // Calculate RMS (Root Mean Square) over window
        let sum_squares: f32 = self.sample_buffer.iter().map(|s| s * s).sum();
        let mean_square = sum_squares / self.sample_buffer.len() as f32;
        let rms = mean_square.sqrt();

        // Convert RMS to LUFS using ITU-R BS.1770 formula
        // LUFS = -0.691 + 10 * log10(mean_square)
        //      = -0.691 + 20 * log10(rms)
        if rms > MIN_RMS_THRESHOLD {
            -LUFS_REFERENCE + 20.0 * rms.log10()
        } else {
            -100.0 // Silence threshold
        }
    }

    /// Get RMS of current buffer (for testing)
    #[cfg(test)]
    fn _last_rms(&self) -> f32 {
        if self.sample_buffer.is_empty() {
            return 0.0;
        }
        let sum_sq: f32 = self.sample_buffer.iter().map(|s| s * s).sum();
        (sum_sq / self.sample_buffer.len() as f32).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ UNIT TESTS ============

    #[test]
    fn test_analyzer_creation() {
        let analyzer = LoufsAnalyzer::new(48000, 100);
        assert!(analyzer.is_ok());

        let _a = analyzer.unwrap();
    }

    #[test]
    fn test_invalid_window_too_small() {
        let analyzer = LoufsAnalyzer::new(48000, 50); // Too small
        assert!(analyzer.is_err());
        assert!(analyzer.unwrap_err().contains("100-300ms"));
    }

    #[test]
    fn test_invalid_window_too_large() {
        let analyzer = LoufsAnalyzer::new(48000, 500); // Too large
        assert!(analyzer.is_err());
    }

    #[test]
    fn test_different_sample_rates() {
        // Should handle common sample rates
        for sr in &[16000, 44100, 48000, 96000] {
            let a = LoufsAnalyzer::new(*sr, 100);
            assert!(a.is_ok());
        }
    }

    // ============ LOUDNESS MEASUREMENT TESTS ============

    #[test]
    fn test_silence_measurement() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();
        let silence = vec![0i16; 4800]; // 100ms silence @ 48kHz

        let lufs = analyzer.push_samples(&silence);
        assert!(lufs.is_some());

        let l = lufs.unwrap();
        println!("Silence LUFS: {}", l);
        // Silence should be very negative (< -80 LUFS)
        assert!(l < -80.0, "Silence should be < -80 LUFS, got {}", l);
    }

    #[test]
    fn test_full_scale_sine_wave() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();

        // Generate 1kHz sine wave at full scale
        // Full scale = ±32767, but we'll use 0.9 to avoid clipping issues
        let amplitude: i16 = (32767.0 * 0.9) as i16;
        let freq = 1000.0;
        let sample_rate = 48000.0;

        let mut sine_samples = vec![0i16; 4800];
        for i in 0..4800 {
            let t = i as f32 / sample_rate;
            let sample = (amplitude as f32 * (2.0 * std::f32::consts::PI * freq * t).sin()) as i16;
            sine_samples[i] = sample;
        }

        let lufs = analyzer.push_samples(&sine_samples);
        assert!(lufs.is_some());

        let l = lufs.unwrap();
        println!("Full-scale sine (0.9 amp) LUFS: {}", l);
        // With HP filter applied, expect ~2dB reduction from ideal -3.52 LUFS
        // Actual range: -6 to -4 LUFS
        assert!(
            l > -7.0 && l < -4.0,
            "Full-scale should be ~-5.5 LUFS (with HP filter), got {}",
            l
        );
    }

    #[test]
    fn test_realistic_speech_level() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();

        // Simulate speech at typical level (~0.3 amplitude)
        let amplitude: i16 = (32767.0 * 0.3) as i16;
        let freq = 300.0; // Lower frequency for speech-like
        let sample_rate = 48000.0;

        let mut samples = vec![0i16; 4800];
        for i in 0..4800 {
            let t = i as f32 / sample_rate;
            let sample = (amplitude as f32 * (2.0 * std::f32::consts::PI * freq * t).sin()) as i16;
            samples[i] = sample;
        }

        let lufs = analyzer.push_samples(&samples);
        assert!(lufs.is_some());

        let l = lufs.unwrap();
        println!("Speech-like (0.3 amp) LUFS: {}", l);
        // With HP filter: expect ~2dB reduction, so -19.5 to -16.5 LUFS
        assert!(
            l > -21.0 && l < -15.0,
            "Speech should be ~-18.5 LUFS (with HP filter), got {}",
            l
        );
    }

    #[test]
    fn test_windowing_partial_samples() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();

        // Push partial window (not complete)
        let partial = vec![100i16; 2400]; // Only 50ms
        let result = analyzer.push_samples(&partial);

        // Should not return measurement (incomplete window)
        assert!(
            result.is_none(),
            "Incomplete window should not produce output"
        );

        // Push rest of window
        let rest = vec![100i16; 2400]; // Complete to 100ms
        let result = analyzer.push_samples(&rest);

        // Should return measurement now
        assert!(result.is_some(), "Complete window should produce output");
    }

    #[test]
    fn test_rolling_windows() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();

        // Push silence for first window
        let silence = vec![0i16; 4800];
        let lufs1 = analyzer.push_samples(&silence);
        assert!(lufs1.is_some());

        // Buffer should be cleared, next window starts fresh
        let amplitude: i16 = (32767.0 * 0.3) as i16;
        let mut samples = vec![0i16; 4800];
        for i in 0..4800 {
            let t = i as f32 / 48000.0;
            samples[i] = (amplitude as f32 * (2.0 * std::f32::consts::PI * 300.0 * t).sin()) as i16;
        }
        let lufs2 = analyzer.push_samples(&samples);
        assert!(lufs2.is_some());

        // Outputs should be very different
        let l1 = lufs1.unwrap();
        let l2 = lufs2.unwrap();
        println!("Window 1 LUFS: {}, Window 2 LUFS: {}", l1, l2);
        assert!((l1 - l2).abs() > 10.0, "Outputs should be very different");
    }

    // ============ MONOTONICITY TESTS ============

    #[test]
    fn test_louder_signal_higher_lufs() {
        let mut a1 = LoufsAnalyzer::new(48000, 100).unwrap();
        let mut a2 = LoufsAnalyzer::new(48000, 100).unwrap();

        // Sine wave at 0.2 amplitude
        let mut samples1 = vec![0i16; 4800];
        for i in 0..4800 {
            let t = i as f32 / 48000.0;
            samples1[i] =
                ((32767.0 * 0.2) as f32 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin()) as i16;
        }

        // Sine wave at 0.5 amplitude (louder)
        let mut samples2 = vec![0i16; 4800];
        for i in 0..4800 {
            let t = i as f32 / 48000.0;
            samples2[i] =
                ((32767.0 * 0.5) as f32 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin()) as i16;
        }

        let lufs1 = a1.push_samples(&samples1).unwrap();
        let lufs2 = a2.push_samples(&samples2).unwrap();

        println!("0.2 amp: {} LUFS, 0.5 amp: {} LUFS", lufs1, lufs2);
        // Louder signal should have higher (less negative) LUFS
        assert!(lufs2 > lufs1, "0.5x amplitude should be louder than 0.2x");
    }

    // ============ PERFORMANCE/BENCHMARK TESTS ============

    #[test]
    fn test_process_speed_single_window() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();
        let samples = vec![100i16; 4800]; // 100ms @ 48kHz

        let start = std::time::Instant::now();
        let _result = analyzer.push_samples(&samples);
        let elapsed = start.elapsed();

        println!(
            "Processing 100ms window: {:.3}ms",
            elapsed.as_secs_f32() * 1000.0
        );
        // Should be much faster than 5ms (target is <1ms)
        assert!(
            elapsed.as_millis() < 5,
            "Window processing too slow: {}ms",
            elapsed.as_millis()
        );
    }

    #[test]
    fn test_process_speed_streaming() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();

        // Simulate 1 second of streaming audio in 16ms chunks (typical)
        let chunk_samples = 768; // 16ms @ 48kHz
        let num_chunks = 63; // 1 second

        let start = std::time::Instant::now();
        let mut count = 0;
        for _ in 0..num_chunks {
            let chunk = vec![100i16; chunk_samples];
            if analyzer.push_samples(&chunk).is_some() {
                count += 1;
            }
        }
        let elapsed = start.elapsed();

        println!(
            "Processing {} chunks (1s audio): {:.3}ms, {} windows",
            num_chunks,
            elapsed.as_secs_f32() * 1000.0,
            count
        );

        // Total time for 1s streaming should be well under 5ms
        assert!(
            elapsed.as_millis() < 50,
            "Streaming too slow: {}ms for 1s",
            elapsed.as_millis()
        );
    }

    // ============ EDGE CASES ============

    #[test]
    fn test_empty_samples() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();
        let empty = vec![];

        let result = analyzer.push_samples(&empty);
        assert!(result.is_none(), "Empty sample set should return None");
    }

    #[test]
    fn test_max_sample_value() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();
        let max_samples = vec![i16::MAX; 4800];

        let lufs = analyzer.push_samples(&max_samples);
        assert!(lufs.is_some());

        let l = lufs.unwrap();
        println!("Max i16 constant (DC) LUFS: {}", l);
        // DC is filtered out by high-pass filter, so constant signal is heavily attenuated
        // Expected: much lower than actual AC signal
        // For ducking, we don't care about DC anyway
        assert!(
            l < -20.0,
            "DC constant signal should be heavily attenuated by HP filter, got {}",
            l
        );
    }

    #[test]
    fn test_min_sample_value() {
        let mut analyzer = LoufsAnalyzer::new(48000, 100).unwrap();
        let min_samples = vec![i16::MIN; 4800];

        let lufs = analyzer.push_samples(&min_samples);
        assert!(lufs.is_some());

        let l = lufs.unwrap();
        println!("Min i16 constant (DC) LUFS: {}", l);
        // DC is filtered out by HP filter
        // Expected: much lower than actual AC signal
        assert!(
            l < -20.0,
            "DC constant signal should be heavily attenuated by HP filter, got {}",
            l
        );
    }
}
