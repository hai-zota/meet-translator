//! Voice Activity Detection (VAD) — Detects speech vs. silence/noise
//!
//! Implementation Strategy:
//! Phase 3 MVP Uses energy-based detection with spectral analysis (no ONNX overhead)
//! This is sufficient for ducking and can be enhanced with Silero VAD ONNX in Phase 4+
//!
//! Algorithm:
//! 1. Energy detection: Normalize RMS energy
//! 2. Zero crossing rate (ZCR): Lower ZCR indicates speech
//! 3. Energy-ZCR heuristic: Speech = high energy + low ZCR
//! 4. Rolling statistics: Compare against noise floor

#[derive(Debug, Clone, Copy)]
pub enum VadSensitivity {
    Low,    // 0.7: conservative, fewer false positives
    Medium, // 0.5: balanced
    High,   // 0.3: aggressive, fewer false negatives
}

/// Voice activity detection using energy + ZCR heuristic
/// Detects speech without ONNX overhead (MVP approach)
#[derive(Debug)]
pub struct VadProcessor {
    sensitivity: VadSensitivity,

    // Energy tracking for background noise estimation
    noise_floor: f32,      // Estimated background noise level
    energy_threshold: f32, // Adaptive threshold
    zcr_threshold: f32,    // Zero crossing rate threshold (0-1 normalized)

    // History for adaptive thresholding
    recent_energies: Vec<f32>,
    recent_zcrs: Vec<f32>,
    max_history: usize,
}

impl VadProcessor {
    /// Create new VAD processor
    /// - sensitivity: "low" (conservative), "medium" (balanced), "high" (aggressive)
    pub fn new(sensitivity: &str, _model_path: Option<&str>) -> Result<Self, String> {
        let sens = match sensitivity {
            "low" => VadSensitivity::Low,
            "medium" => VadSensitivity::Medium,
            "high" => VadSensitivity::High,
            other => return Err(format!("Unknown sensitivity: {}", other)),
        };

        Ok(Self {
            sensitivity: sens,
            noise_floor: -60.0, // Start with pessimistic assumption
            energy_threshold: -30.0,
            zcr_threshold: 0.5, // ZCR for speech typically < 0.5
            recent_energies: Vec::with_capacity(10),
            recent_zcrs: Vec::with_capacity(10),
            max_history: 10,
        })
    }

    /// Process one frame and return is_speech
    /// Expected: 512 samples @ 16kHz = 32ms frame
    pub fn process_frame(&mut self, pcm_f32: &[f32]) -> Result<bool, String> {
        if pcm_f32.is_empty() {
            return Ok(false);
        }

        // 1. Calculate energy (RMS in dB)
        let energy = self._calculate_energy_db(pcm_f32);

        // 2. Calculate zero-crossing rate
        let zcr = self._calculate_zcr(pcm_f32);

        // 3. Update adaptive statistics
        self._update_statistics(energy, zcr);

        // 4. Determine if speech based on sensitivity
        let is_speech = self._classify_frame(energy, zcr);

        Ok(is_speech)
    }

    /// Calculate energy in dB
    fn _calculate_energy_db(&self, samples: &[f32]) -> f32 {
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        let mean_sq = sum_sq / samples.len() as f32;
        let rms = mean_sq.sqrt();

        // Convert to dB: 20 * log10(rms), with floor at -100 dB
        if rms > 1e-6 {
            20.0 * rms.log10()
        } else {
            -100.0
        }
    }

    /// Calculate zero-crossing rate (normalized 0-1)
    fn _calculate_zcr(&self, samples: &[f32]) -> f32 {
        if samples.len() < 2 {
            return 0.0;
        }

        let mut crossings = 0;
        for i in 1..samples.len() {
            if (samples[i] >= 0.0 && samples[i - 1] < 0.0)
                || (samples[i] < 0.0 && samples[i - 1] >= 0.0)
            {
                crossings += 1;
            }
        }

        // Normalize by max possible crossings
        // Max crossings = samples.len() - 1 (alternating +/-)
        let normalized = crossings as f32 / (samples.len() - 1) as f32;
        normalized.clamp(0.0, 1.0)
    }

    /// Update rolling statistics for adaptive thresholding
    fn _update_statistics(&mut self, energy: f32, zcr: f32) {
        self.recent_energies.push(energy);
        self.recent_zcrs.push(zcr);

        // Keep rolling window
        if self.recent_energies.len() > self.max_history {
            self.recent_energies.remove(0);
        }
        if self.recent_zcrs.len() > self.max_history {
            self.recent_zcrs.remove(0);
        }

        // Update noise floor estimate (minimum observed energy)
        if let Some(&min_energy) = self
            .recent_energies
            .iter()
            .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        {
            self.noise_floor = min_energy.max(-80.0);
        }

        // Adaptive threshold: ~15dB above noise floor
        self.energy_threshold = self.noise_floor + 15.0;
    }

    /// Classify frame as speech or non-speech
    /// Uses sensitivity to adjust thresholds
    fn _classify_frame(&self, energy: f32, zcr: f32) -> bool {
        // Adjust thresholds based on sensitivity
        let (energy_boost, zcr_factor) = match self.sensitivity {
            VadSensitivity::Low => (5.0, 0.6), // Conservative: high thresholds
            VadSensitivity::Medium => (0.0, 0.5), // Balanced: nominal thresholds
            VadSensitivity::High => (-5.0, 0.4), // Aggressive: low thresholds
        };

        let adj_energy_threshold = self.energy_threshold + energy_boost;
        let adj_zcr_threshold = self.zcr_threshold * zcr_factor;

        // Speech detection heuristic:
        // High energy + low ZCR = likely speech
        // Must satisfy both conditions
        let high_energy = energy > adj_energy_threshold;
        let low_zcr = zcr < adj_zcr_threshold;

        high_energy && low_zcr
    }

    /// Get sensitivity level
    #[cfg(test)]
    pub fn sensitivity(&self) -> f32 {
        match self.sensitivity {
            VadSensitivity::Low => 0.7,
            VadSensitivity::Medium => 0.5,
            VadSensitivity::High => 0.3,
        }
    }

    /// Get current noise floor estimate (for debugging)
    #[cfg(test)]
    pub fn noise_floor(&self) -> f32 {
        self.noise_floor
    }

    /// Get current energy threshold (for debugging)
    #[cfg(test)]
    pub fn energy_threshold(&self) -> f32 {
        self.energy_threshold
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ CREATION & CONFIGURATION TESTS ============

    #[test]
    fn test_vad_creation() {
        let vad = VadProcessor::new("medium", None);
        assert!(vad.is_ok());

        let vad = vad.unwrap();
        assert_eq!(vad.sensitivity(), 0.5);
    }

    #[test]
    fn test_sensitivity_levels() {
        let vad_low = VadProcessor::new("low", None).unwrap();
        assert_eq!(vad_low.sensitivity(), 0.7);

        let vad_medium = VadProcessor::new("medium", None).unwrap();
        assert_eq!(vad_medium.sensitivity(), 0.5);

        let vad_high = VadProcessor::new("high", None).unwrap();
        assert_eq!(vad_high.sensitivity(), 0.3);
    }

    #[test]
    fn test_invalid_sensitivity() {
        let vad = VadProcessor::new("invalid", None);
        assert!(vad.is_err());
        assert!(vad.unwrap_err().contains("Unknown sensitivity"));
    }

    // ============ SILENCE DETECTION TESTS ============

    #[test]
    fn test_silence_detection() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        // Generate silence (all zeros)
        let silence = vec![0.0; 512];

        let result = vad.process_frame(&silence);
        assert!(result.is_ok());

        let is_speech = result.unwrap();
        println!("Silence detection: {}", is_speech);
        assert!(!is_speech, "Silence should not be detected as speech");
        assert!(
            vad.noise_floor() <= -60.0,
            "Silence should keep low noise floor"
        );
    }

    #[test]
    fn test_empty_frame() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        let empty = vec![];
        let result = vad.process_frame(&empty);

        assert!(result.is_ok());
        assert!(!result.unwrap(), "Empty frame should return false");
    }

    // ============ SPEECH DETECTION TESTS ============

    #[test]
    fn test_speech_like_signal() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        // Simulate speech: moderate energy + low ZCR
        let freq = 150.0;
        let sample_rate = 16000.0;
        let amplitude = 0.2;

        let mut speech = vec![0.0; 512];
        for i in 0..512 {
            let t = i as f32 / sample_rate;
            speech[i] = amplitude * (2.0 * std::f32::consts::PI * freq * t).sin();
        }

        // Warm-up frames with silence to establish noise floor
        let silence = vec![0.0; 512];
        for _ in 0..5 {
            let _ = vad.process_frame(&silence);
        }

        // Now check if speech is detected
        let result = vad.process_frame(&speech);
        assert!(result.is_ok());

        let is_speech = result.unwrap();
        println!("Speech-like detection after silence warmup: {}", is_speech);
        // With established noise floor, speech should be detected
        assert!(
            is_speech,
            "Speech-like signal should be detected after noise floor established"
        );
    }

    #[test]
    fn test_high_frequency_noise() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        // High frequency noise (high ZCR)
        let freq = 3000.0;
        let sample_rate = 16000.0;
        let amplitude = 0.1;

        let mut noise = vec![0.0; 512];
        for i in 0..512 {
            let t = i as f32 / sample_rate;
            noise[i] = amplitude * (2.0 * std::f32::consts::PI * freq * t).sin();
        }

        let result = vad.process_frame(&noise);
        assert!(result.is_ok());

        let is_speech = result.unwrap();
        println!("High-freq noise detection: {}", is_speech);
        // High ZCR should prevent detection as speech
        assert!(
            !is_speech,
            "High-frequency noise should not be detected as speech"
        );
    }

    // ============ SENSITIVITY TESTS ============

    #[test]
    fn test_sensitivity_affects_detection() {
        let freq = 200.0;
        let sample_rate = 16000.0;
        let amplitude = 0.08;

        let mut weak_speech = vec![0.0; 512];
        for i in 0..weak_speech.len() {
            let t = i as f32 / sample_rate;
            weak_speech[i] = amplitude * (2.0 * std::f32::consts::PI * freq * t).sin();
        }

        let mut vad_low = VadProcessor::new("low", None).unwrap();
        let mut vad_high = VadProcessor::new("high", None).unwrap();

        // Warm-up with silence to establish noise floor
        let silence = vec![0.0; 512];
        for _ in 0..5 {
            let _ = vad_low.process_frame(&silence);
            let _ = vad_high.process_frame(&silence);
        }

        let result_low = vad_low.process_frame(&weak_speech).unwrap();
        let result_high = vad_high.process_frame(&weak_speech).unwrap();

        println!("Weak speech - Low: {}, High: {}", result_low, result_high);
        // High sensitivity should detect at least as much as low
        assert!(
            result_high || !result_low,
            "High sensitivity should detect >= low"
        );
        assert!(vad_high.energy_threshold() <= vad_low.energy_threshold(), "High sensitivity path should not require a stricter threshold than low sensitivity after identical warmup");
    }

    // ============ STREAMING TESTS ============

    #[test]
    fn test_streaming_detection() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        // First establish silence baseline
        let silence = vec![0.0; 512];
        for _ in 0..5 {
            let _ = vad.process_frame(&silence);
        }

        // Simulate 200ms of speech (3200 samples @ 16kHz)
        let freq = 200.0;
        let sample_rate = 16000.0;
        let amplitude = 0.15;

        let mut all_samples = vec![0.0; 3200];
        for i in 0..3200 {
            let t = i as f32 / sample_rate;
            all_samples[i] = amplitude * (2.0 * std::f32::consts::PI * freq * t).sin();
        }

        let mut detections = vec![];
        for chunk in all_samples.chunks(512) {
            if let Ok(is_speech) = vad.process_frame(&chunk.to_vec()) {
                detections.push(is_speech);
            }
        }

        println!("Streaming detections: {:?}", detections);

        // Should detect consistent speech (all or most true)
        let detected_count = detections.iter().filter(|&&d| d).count();
        assert!(
            detected_count >= detections.len() - 1,
            "Most frames should detect speech"
        );
    }

    // ============ MONOTONICITY TESTS ============

    #[test]
    fn test_louder_signal_more_likely_speech() {
        let sample_rate = 16000.0;
        let freq = 200.0;

        let mut quiet = vec![0.0; 512];
        for i in 0..512 {
            let t = i as f32 / sample_rate;
            quiet[i] = 0.05 * (2.0 * std::f32::consts::PI * freq * t).sin();
        }

        let mut loud = vec![0.0; 512];
        for i in 0..512 {
            let t = i as f32 / sample_rate;
            loud[i] = 0.20 * (2.0 * std::f32::consts::PI * freq * t).sin();
        }

        let mut vad = VadProcessor::new("medium", None).unwrap();

        // Establish noise floor with silence
        let silence = vec![0.0; 512];
        for _ in 0..5 {
            let _ = vad.process_frame(&silence);
        }

        let result_quiet = vad.process_frame(&quiet).unwrap();
        let result_loud = vad.process_frame(&loud).unwrap();

        println!("Quiet: {}, Loud: {}", result_quiet, result_loud);
        // Higher amplitude should give higher likelihood
        assert!(
            result_loud || !result_quiet,
            "Louder should detect >= quiet"
        );
    }

    // ============ PERFORMANCE TESTS ============

    #[test]
    fn test_frame_processing_speed() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        let samples = vec![0.1; 512];

        let start = std::time::Instant::now();
        for _ in 0..100 {
            let _ = vad.process_frame(&samples);
        }
        let elapsed = start.elapsed();

        let per_frame = elapsed.as_secs_f32() * 1000.0 / 100.0;
        println!("VAD per-frame latency: {:.3}ms", per_frame);

        assert!(
            per_frame < 0.5,
            "Frame processing should be <0.5ms, got {:.3}ms",
            per_frame
        );
    }

    #[test]
    fn test_various_frame_sizes() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        for size in &[128, 256, 512, 1024] {
            let samples = vec![0.1; *size];
            let result = vad.process_frame(&samples);
            assert!(result.is_ok(), "Frame size {} should work", size);
        }
    }

    // ============ EDGE CASES ============

    #[test]
    fn test_high_amplitude_sine_wave() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        // Establish noise floor first with silence
        let silence = vec![0.0; 512];
        for _ in 0..5 {
            let _ = vad.process_frame(&silence);
        }

        // High-amplitude sine wave (speech-like with low frequency)
        let freq = 200.0;
        let sample_rate = 16000.0;
        let amplitude = 0.5; // High amplitude

        let mut loud_sine = vec![0.0; 512];
        for i in 0..512 {
            let t = i as f32 / sample_rate;
            loud_sine[i] = amplitude * (2.0 * std::f32::consts::PI * freq * t).sin();
        }

        let result = vad.process_frame(&loud_sine);
        assert!(result.is_ok());

        let is_speech = result.unwrap();
        println!("High amplitude sine detection: {}", is_speech);
        // High energy sine wave should be detected as speech
        assert!(is_speech, "High-amplitude sine wave should be detected");
    }

    #[test]
    fn test_mixed_signal() {
        let mut vad = VadProcessor::new("medium", None).unwrap();

        // Mix low-freq + high-freq
        let speech_freq = 200.0;
        let noise_freq = 4000.0;
        let sample_rate = 16000.0;

        let mut mixed = vec![0.0; 512];
        for i in 0..512 {
            let t = i as f32 / sample_rate;
            let speech = 0.12 * (2.0 * std::f32::consts::PI * speech_freq * t).sin();
            let noise = 0.08 * (2.0 * std::f32::consts::PI * noise_freq * t).sin();
            mixed[i] = (speech + noise) * 0.5;
        }

        let silence = vec![0.0; 512];
        for _ in 0..5 {
            let _ = vad.process_frame(&silence);
        }

        let result = vad.process_frame(&mixed);
        assert!(result.is_ok());
    }
}
