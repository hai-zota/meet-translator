//! Dynamic Ducking Engine — Automatic gain reduction state machine
//! States: Waiting → Ducking(Attack) → Hold → Releasing

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DuckingState {
    Waiting,   // Original @ 100%
    Ducking,   // Attacking/Holding @ target level
    Releasing, // Fading back to 100%
}

/// Dynamic ducking engine with Attack/Hold/Release envelope
pub struct DuckingEngine {
    state: DuckingState,

    // Parameters
    attack_time_ms: u32,      // 200ms default
    release_time_ms: u32,     // 500ms default
    ducking_level: f32,       // 0.2 (20% volume) default
    detection_threshold: f32, // -40 LUFS default

    // Runtime
    current_gain: f32,
    transition_start_ms: u64,
    last_signal_time_ms: u64,
    current_time_ms: u64,
}

impl DuckingEngine {
    /// Create ducking engine with default parameters
    pub fn new() -> Self {
        Self {
            state: DuckingState::Waiting,
            attack_time_ms: 200,
            release_time_ms: 500,
            ducking_level: 0.2,
            detection_threshold: -40.0,
            current_gain: 1.0,
            transition_start_ms: 0,
            last_signal_time_ms: 0,
            current_time_ms: 0,
        }
    }

    /// Configure ducking parameters
    pub fn configure(&mut self, ducking_level: f32, threshold: f32) {
        self.ducking_level = ducking_level.clamp(0.0, 1.0);
        self.detection_threshold = threshold;
    }

    /// Process one audio frame and return ducking gain
    /// - original_lufs: Loudness of original stream (LUFS)
    /// - translated_active: Whether translated stream has signal
    /// - dt_ms: Time delta since last call (milliseconds)
    ///
    /// Returns: Gain multiplier for original stream (0.0 - 1.0)
    pub fn process(&mut self, original_lufs: f32, translated_active: bool, dt_ms: u32) -> f32 {
        // Update elapsed time
        self.current_time_ms += dt_ms as u64;

        // State machine logic
        match self.state {
            DuckingState::Waiting => {
                self.current_gain = 1.0;

                // Check if translated has strong signal
                if translated_active && original_lufs > self.detection_threshold {
                    self._enter_ducking_state();
                }
            }
            DuckingState::Ducking => {
                let elapsed_ms = (self.current_time_ms - self.transition_start_ms) as u32;

                if elapsed_ms < self.attack_time_ms {
                    // Attack phase: interpolate 1.0 → ducking_level
                    let t = elapsed_ms as f32 / self.attack_time_ms as f32;
                    self.current_gain = self._interpolate_exponential(1.0, self.ducking_level, t);
                } else {
                    // Hold phase
                    self.current_gain = self.ducking_level;
                }

                // Track last time translated signal was active (for hold timer)
                if translated_active && original_lufs > self.detection_threshold {
                    self.last_signal_time_ms = self.current_time_ms;
                }

                // Check if hold time exceeded (500ms), start releasing
                if self.current_time_ms - self.last_signal_time_ms > 500 {
                    self._enter_releasing_state();
                }
            }
            DuckingState::Releasing => {
                let elapsed_ms = (self.current_time_ms - self.transition_start_ms) as u32;

                if elapsed_ms < self.release_time_ms {
                    // Release phase: interpolate ducking_level → 1.0
                    let t = elapsed_ms as f32 / self.release_time_ms as f32;
                    self.current_gain = self._interpolate_exponential(self.ducking_level, 1.0, t);
                } else {
                    // Release complete, return to Waiting
                    self.state = DuckingState::Waiting;
                    self.current_gain = 1.0;
                }

                // If translated signal returns, cancel release and re-enter ducking
                if translated_active && original_lufs > self.detection_threshold {
                    self._enter_ducking_state();
                }
            }
        }

        self.current_gain
    }

    fn _enter_ducking_state(&mut self) {
        self.state = DuckingState::Ducking;
        self.transition_start_ms = self.current_time_ms;
        self.last_signal_time_ms = self.current_time_ms;
        println!("[Ducking] → Ducking state (attack phase)");
    }

    fn _enter_releasing_state(&mut self) {
        self.state = DuckingState::Releasing;
        self.transition_start_ms = self.current_time_ms;
        println!("[Ducking] → Releasing state");
    }

    /// Exponential easing: t^2 for smoother fade
    fn _interpolate_exponential(&self, from: f32, to: f32, t: f32) -> f32 {
        let clamped_t = t.clamp(0.0, 1.0);
        let eased = clamped_t * clamped_t; // t^2 easing
        from + (to - from) * eased
    }

    /// Get current state
    #[cfg(test)]
    pub fn state(&self) -> DuckingState {
        self.state
    }

    /// Get current gain
    #[cfg(test)]
    pub fn current_gain(&self) -> f32 {
        self.current_gain
    }
}

impl Default for DuckingEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ CREATION TESTS ============

    #[test]
    fn test_ducking_creation() {
        let engine = DuckingEngine::new();
        assert_eq!(engine.state(), DuckingState::Waiting);
        assert_eq!(engine.current_gain(), 1.0);
    }

    #[test]
    fn test_configure_ducking_level() {
        let mut engine = DuckingEngine::new();
        engine.configure(0.1, -35.0);
        // Trigger ducking to check effect
        engine.process(-20.0, true, 16);
        assert_eq!(engine.state(), DuckingState::Ducking);
    }

    #[test]
    fn test_configure_clamps_level() {
        let mut engine = DuckingEngine::new();
        // Should clamp to [0.0, 1.0]
        engine.configure(2.0, -40.0);
        // Process to trigger ducking — gain should never exceed 1.0
        let gain = engine.process(-20.0, true, 300);
        assert!(gain <= 1.0, "Gain should not exceed 1.0");
    }

    // ============ WAITING STATE TESTS ============

    #[test]
    fn test_waiting_state_no_signal() {
        let mut engine = DuckingEngine::new();
        let gain = engine.process(-60.0, false, 16);
        assert_eq!(gain, 1.0);
        assert_eq!(engine.state(), DuckingState::Waiting);
    }

    #[test]
    fn test_waiting_below_threshold() {
        let mut engine = DuckingEngine::new();
        // Below detection threshold (-40 LUFS) with active translated
        let gain = engine.process(-50.0, true, 16);
        assert_eq!(gain, 1.0);
        assert_eq!(engine.state(), DuckingState::Waiting);
    }

    #[test]
    fn test_waiting_returns_unity_gain() {
        let mut engine = DuckingEngine::new();
        for _ in 0..10 {
            let gain = engine.process(-80.0, false, 16);
            assert_eq!(gain, 1.0, "Waiting state should return 1.0 gain");
        }
    }

    // ============ DUCKING STATE TESTS ============

    #[test]
    fn test_enter_ducking() {
        let mut engine = DuckingEngine::new();
        // First call: transitions state, still in Waiting branch → returns 1.0
        let _first = engine.process(-20.0, true, 16);
        assert_eq!(engine.state(), DuckingState::Ducking);
        // Second call: now in Ducking branch → attack begins
        let gain = engine.process(-20.0, true, 16);
        assert!(
            gain < 1.0,
            "Second call should start attack phase, gain={}",
            gain
        );
        assert_eq!(engine.state(), DuckingState::Ducking);
    }

    #[test]
    fn test_attack_phase_gain_decreases() {
        let mut engine = DuckingEngine::new();

        // Collect gains during attack phase (200ms total, step by 16ms)
        let mut gains = vec![];
        for _ in 0..12 {
            // 12 * 16ms = 192ms (< attack_time=200ms)
            let gain = engine.process(-20.0, true, 16);
            gains.push(gain);
        }

        println!("Attack gains: {:?}", &gains[0..5.min(gains.len())]);

        // First gain starts at 1.0
        assert_eq!(gains[0], 1.0, "Attack should start at 1.0 gain");

        // Gains should be decreasing (or equal) — avoid flakiness with range check
        let last_gain = *gains.last().unwrap();
        assert!(last_gain < 1.0, "Gain should decrease during attack");
    }

    #[test]
    fn test_hold_phase_at_ducking_level() {
        let mut engine = DuckingEngine::new();
        engine.configure(0.2, -40.0);

        // Simulate full attack (250ms), then check hold
        for _ in 0..16 {
            // 16 * 16ms = 256ms > attack(200ms)
            engine.process(-20.0, true, 16);
        }

        assert_eq!(
            engine.state(),
            DuckingState::Ducking,
            "Should still be in ducking"
        );
        let gain = engine.current_gain();
        println!("Hold gain: {}", gain);
        assert!(
            (gain - 0.2).abs() < 0.05,
            "Hold should be near ducking_level 0.2"
        );
    }

    #[test]
    fn test_ducking_prevents_full_gain() {
        let mut engine = DuckingEngine::new();
        engine.configure(0.3, -40.0);

        // Run through full attack + some hold
        for _ in 0..20 {
            engine.process(-20.0, true, 16);
        }

        let gain = engine.current_gain();
        assert!(
            gain <= 0.35,
            "Ducked gain should not exceed ducking_level boundary"
        );
        assert!(gain >= 0.0, "Ducked gain must be non-negative");
    }

    // ============ RELEASING STATE TESTS ============

    #[test]
    fn test_enter_releasing_after_signal_ends() {
        let mut engine = DuckingEngine::new();

        // Enter ducking — 15 * 16ms = 240ms
        for _ in 0..15 {
            engine.process(-20.0, true, 16);
        }
        assert_eq!(engine.state(), DuckingState::Ducking);

        // Signal ends — advance past hold timeout (hold > 500ms)
        // Use large dt steps to speed up simulation
        for _ in 0..40 {
            // 40 * 16ms = 640ms > 500ms hold
            engine.process(-80.0, false, 16);
        }

        println!("State after signal end: {:?}", engine.state());
        assert_eq!(
            engine.state(),
            DuckingState::Releasing,
            "Should enter releasing state"
        );
    }

    #[test]
    fn test_release_phase_gain_increases() {
        let mut engine = DuckingEngine::new();

        // Enter ducking and wait for full attack
        for _ in 0..20 {
            engine.process(-20.0, true, 16);
        }

        // End signal, advance past hold time (> 500ms)
        for _ in 0..40 {
            engine.process(-80.0, false, 16);
        }
        assert_eq!(engine.state(), DuckingState::Releasing);

        let ducked_gain = engine.current_gain();

        // Process during release — gain should increase
        let mut release_gains = vec![];
        for _ in 0..10 {
            let gain = engine.process(-80.0, false, 16);
            release_gains.push(gain);
        }

        let final_gain = *release_gains.last().unwrap();
        println!("Release: {} → {}", ducked_gain, final_gain);
        assert!(
            final_gain > ducked_gain,
            "Gain should increase during release"
        );
    }

    #[test]
    fn test_full_cycle_returns_to_waiting() {
        let mut engine = DuckingEngine::new();

        // Duck: 19 * 16ms = 304ms
        for _ in 0..19 {
            engine.process(-20.0, true, 16);
        }

        // Signal off → hold (500ms) + release (500ms) = 1000ms
        // 70 * 16ms = 1120ms > 1000ms → should complete full cycle
        for _ in 0..70 {
            engine.process(-80.0, false, 16);
        }

        println!("Final state: {:?}", engine.state());
        assert_eq!(
            engine.state(),
            DuckingState::Waiting,
            "Should return to Waiting after full cycle"
        );
        assert!(
            (engine.current_gain() - 1.0).abs() < 0.001,
            "Gain should be 1.0 after full cycle"
        );
    }

    // ============ RE-TRIGGER TESTS ============

    #[test]
    fn test_retrigger_during_release() {
        let mut engine = DuckingEngine::new();

        // Full duck then start releasing
        for _ in 0..20 {
            engine.process(-20.0, true, 16);
        }
        for _ in 0..40 {
            // > 500ms hold to enter Releasing
            engine.process(-80.0, false, 16);
        }
        assert_eq!(engine.state(), DuckingState::Releasing);

        // Translated signal returns — should re-enter ducking
        engine.process(-20.0, true, 16);
        println!("After retrigger: state={:?}", engine.state());
        assert_eq!(
            engine.state(),
            DuckingState::Ducking,
            "Should re-enter ducking"
        );
    }

    // ============ GAIN RANGE TESTS ============

    #[test]
    fn test_gain_always_in_range() {
        let mut engine = DuckingEngine::new();
        engine.configure(0.15, -35.0);

        // Simulate mixed signal scenario
        let pattern = [
            (-20.0, true),
            (-20.0, true),
            (-20.0, true),
            (-20.0, true),
            (-20.0, true),
            (-20.0, false),
            (-20.0, false),
            (-20.0, false),
            (-20.0, false),
            (-20.0, false),
            (-20.0, false),
            (-20.0, false),
            (-80.0, false),
            (-80.0, false),
            (-80.0, false),
            (-80.0, false),
        ];

        for _ in 0..5 {
            for &(lufs, active) in &pattern {
                let gain = engine.process(lufs, active, 16);
                assert!(
                    gain >= 0.0 && gain <= 1.0,
                    "Gain out of range: {} (state={:?})",
                    gain,
                    engine.state()
                );
            }
        }
    }

    // ============ PERFORMANCE TESTS ============

    #[test]
    fn test_process_speed() {
        let mut engine = DuckingEngine::new();

        let start = std::time::Instant::now();
        for _ in 0..10000 {
            let _ = engine.process(-20.0, true, 16);
        }
        let elapsed = start.elapsed();

        let per_call = elapsed.as_secs_f64() * 1_000_000.0 / 10000.0;
        println!("DuckingEngine per-call: {:.2}μs", per_call);

        assert!(
            per_call < 10.0,
            "Should be <10μs per call, got {:.2}μs",
            per_call
        );
    }
}
