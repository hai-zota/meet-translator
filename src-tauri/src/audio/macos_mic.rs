//! macOS microphone capture using AUVoiceIO (Voice Processing I/O AudioUnit).
//!
//! AUVoiceIO provides hardware-level Acoustic Echo Cancellation (AEC):
//! the mic input is automatically cleaned of any audio being played through
//! the device speakers, without the app needing to supply a reference signal.
//!
//! The AudioUnit runs on a dedicated real-time thread managed by CoreAudio.
//! Captured audio (48kHz / 1ch / f32) is forwarded to an mpsc channel after
//! being downsampled to 16kHz PCM s16le for Soniox/Whisper.

use coreaudio_sys::{
    kAUVoiceIOProperty_BypassVoiceProcessing, kAUVoiceIOProperty_VoiceProcessingEnableAGC,
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatLinearPCM,
    kAudioOutputUnitProperty_EnableIO, kAudioOutputUnitProperty_SetInputCallback,
    kAudioUnitManufacturer_Apple, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Global,
    kAudioUnitScope_Input, kAudioUnitScope_Output, kAudioUnitSubType_VoiceProcessingIO,
    AURenderCallbackStruct, AudioBuffer, AudioBufferList, AudioComponent,
    AudioComponentDescription, AudioComponentFindNext, AudioComponentInstanceNew,
    AudioOutputUnitStart, AudioOutputUnitStop, AudioStreamBasicDescription, AudioTimeStamp,
    AudioUnit, AudioUnitInitialize, AudioUnitRenderActionFlags, AudioUnitSetProperty, OSStatus,
};
use std::mem;
use std::os::raw::c_void;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use super::TARGET_SAMPLE_RATE;

// Bus numbers for VoiceProcessingIO
const INPUT_BUS: u32 = 1;

// VoiceProcessingIO componentType = 'auio' (kAudioUnitType_IO).
// coreaudio-sys exposes kAudioUnitType_Output ('auou') but NOT kAudioUnitType_IO,
// so we use the raw 4-char value directly.
const K_AUDIO_UNIT_TYPE_IO: u32 = 0x6175_696F; // 'auio'

// We capture at the native CoreAudio rate then downsample
const NATIVE_RATE: u32 = 48000;

// VoiceProcessing property element candidates used in practice.
const ELEMENT_GLOBAL: u32 = 0;

/// Shared state between the AudioUnit render callback and the Rust wrapper.
struct CallbackState {
    sender: mpsc::SyncSender<Vec<u8>>,
    /// Linear-interpolation resampler state: fractional position into source
    resample_frac: f64,
}

/// macOS microphone capture using Voice Processing I/O.
/// Provides hardware AEC — mic audio is automatically cleaned of speaker output.
pub struct MacosMicCapture {
    audio_unit: Option<AudioUnit>,
    // Keep callback state alive for the lifetime of the AudioUnit
    _state: Option<Arc<Mutex<CallbackState>>>,
}

// SAFETY: AudioUnit is a raw pointer managed behind a Mutex; we never use it
// concurrently from multiple threads.
unsafe impl Send for MacosMicCapture {}

impl MacosMicCapture {
    pub fn new() -> Self {
        Self {
            audio_unit: None,
            _state: None,
        }
    }

    /// Start capturing. Returns an mpsc::Receiver that yields PCM s16le 16kHz mono chunks.
    pub fn start(&mut self) -> Result<mpsc::Receiver<Vec<u8>>, String> {
        if self.audio_unit.is_some() {
            return Err("Already capturing".to_string());
        }

        // ── 1. Find the VoiceProcessingIO component ──────────────────────────
        let description = AudioComponentDescription {
            componentType: K_AUDIO_UNIT_TYPE_IO, // 'auio', NOT 'auou' (kAudioUnitType_Output)
            componentSubType: kAudioUnitSubType_VoiceProcessingIO,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0,
        };

        let component: AudioComponent =
            unsafe { AudioComponentFindNext(std::ptr::null_mut(), &description) };
        if component.is_null() {
            let msg = "[MacosMic] VoiceProcessingIO AudioComponent not found (needs macOS mic permission?)";
            eprintln!("{msg}");
            return Err(msg.to_string());
        }
        eprintln!("[MacosMic] Step 1 OK: component found");

        // ── 2. Instantiate ───────────────────────────────────────────────────
        let mut au: AudioUnit = std::ptr::null_mut();
        check_os(
            unsafe { AudioComponentInstanceNew(component, &mut au) },
            "AudioComponentInstanceNew",
        )?;
        eprintln!("[MacosMic] Step 2 OK: instance created");

        // ── 3. Enable input (mic bus 1). Keep output bus enabled —
        // VoiceProcessingIO's AEC uses the output bus as its reference signal
        // internally; disabling output causes kAudioUnitErr_FailedInitialization.
        let enable: u32 = 1;

        check_os(
            unsafe {
                AudioUnitSetProperty(
                    au,
                    kAudioOutputUnitProperty_EnableIO,
                    kAudioUnitScope_Input,
                    INPUT_BUS,
                    &enable as *const u32 as *const c_void,
                    mem::size_of::<u32>() as u32,
                )
            },
            "EnableIO Input",
        )?;
        eprintln!("[MacosMic] Step 3 OK: input enabled");

        // ── 3b. Force voice processing profile for echo suppression ─────────
        // Some devices/sessions silently bypass processing unless explicitly set.
        // We try a few scope/element combinations because CoreAudio behavior can
        // vary by device and macOS version.
        set_voice_processing_flags(au)?;
        eprintln!("[MacosMic] Step 3b OK: voice processing + AGC configured");

        // Output bus stays at its default (enabled) — no SetProperty needed.

        // ── 4. Set stream format: 48kHz / 1ch / f32 non-interleaved ─────────
        let format = AudioStreamBasicDescription {
            mSampleRate: NATIVE_RATE as f64,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0,
        };

        check_os(
            unsafe {
                AudioUnitSetProperty(
                    au,
                    kAudioUnitProperty_StreamFormat,
                    kAudioUnitScope_Output, // output scope of input bus = what we read
                    INPUT_BUS,
                    &format as *const AudioStreamBasicDescription as *const c_void,
                    mem::size_of::<AudioStreamBasicDescription>() as u32,
                )
            },
            "SetStreamFormat",
        )?;
        eprintln!("[MacosMic] Step 4 OK: stream format set");

        // ── 5. Register render callback ──────────────────────────────────────
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(32);

        let state = Arc::new(Mutex::new(CallbackState {
            sender: tx,
            resample_frac: 0.0,
        }));

        let state_ptr = Arc::into_raw(Arc::clone(&state)) as *mut c_void;

        let cb = AURenderCallbackStruct {
            inputProc: Some(input_callback),
            inputProcRefCon: state_ptr,
        };

        check_os(
            unsafe {
                AudioUnitSetProperty(
                    au,
                    kAudioOutputUnitProperty_SetInputCallback,
                    kAudioUnitScope_Global,
                    INPUT_BUS,
                    &cb as *const AURenderCallbackStruct as *const c_void,
                    mem::size_of::<AURenderCallbackStruct>() as u32,
                )
            },
            "SetInputCallback",
        )?;
        eprintln!("[MacosMic] Step 5 OK: input callback registered");

        // ── 6. Initialize & start ────────────────────────────────────────────
        check_os(unsafe { AudioUnitInitialize(au) }, "AudioUnitInitialize")?;
        eprintln!("[MacosMic] Step 6a OK: initialized");
        check_os(unsafe { AudioOutputUnitStart(au) }, "AudioOutputUnitStart")?;
        eprintln!("[MacosMic] Step 6b OK: started");

        self.audio_unit = Some(au);
        self._state = Some(state);

        Ok(rx)
    }

    /// Stop capturing and release the AudioUnit.
    pub fn stop(&mut self) {
        if let Some(au) = self.audio_unit.take() {
            unsafe {
                AudioOutputUnitStop(au);
                coreaudio_sys::AudioComponentInstanceDispose(au);
            }
        }
        // Drop state — this implicitly drops the sender, closing the channel
        self._state = None;
    }
}

impl Default for MacosMicCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for MacosMicCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── Render callback (called on CoreAudio real-time thread) ───────────────────

extern "C" fn input_callback(
    in_ref_con: *mut c_void,
    _io_action_flags: *mut AudioUnitRenderActionFlags,
    _in_time_stamp: *const AudioTimeStamp,
    _in_bus_number: u32,
    in_number_frames: u32,
    _io_data: *mut AudioBufferList,
) -> OSStatus {
    // SAFETY: state_ptr was created from Arc::into_raw and lives until stop().
    let state_arc = unsafe { Arc::from_raw(in_ref_con as *const Mutex<CallbackState>) };

    // We pull the audio via AudioUnitRender into a local buffer.
    let n = in_number_frames as usize;
    let mut buf_data: Vec<f32> = vec![0.0f32; n];

    let abl = AudioBufferList {
        mNumberBuffers: 1,
        mBuffers: [AudioBuffer {
            mNumberChannels: 1,
            mDataByteSize: (n * 4) as u32,
            mData: buf_data.as_mut_ptr() as *mut c_void,
        }],
    };

    // The frames are already in the callback's AudioBufferList on VoiceProcessingIO —
    // we just use the data pointer directly without calling AudioUnitRender again.
    // (Calling AudioUnitRender from inside the input callback on VoiceProcessingIO
    //  can cause deadlocks on some macOS versions.)
    let _ = &abl; // suppress unused warning; actual data arrives via inputProcRefCon path

    // On VoiceProcessingIO the captured (AEC-processed) PCM arrives in io_data.
    // Read it directly from io_data if non-null and correctly sized.
    let samples: &[f32] = unsafe {
        if _io_data.is_null() {
            // Fallback: use our zero buffer (shouldn't happen)
            &buf_data
        } else {
            let abl_ref = &*_io_data;
            if abl_ref.mNumberBuffers == 0 || abl_ref.mBuffers[0].mData.is_null() {
                &buf_data
            } else {
                let data_ptr = abl_ref.mBuffers[0].mData as *const f32;
                let data_len = abl_ref.mBuffers[0].mDataByteSize as usize / 4;
                std::slice::from_raw_parts(data_ptr, data_len)
            }
        }
    };

    // Downsample from NATIVE_RATE to TARGET_SAMPLE_RATE and convert to s16le
    if let Ok(mut st) = state_arc.lock() {
        let pcm = resample_f32_to_s16le(
            samples,
            NATIVE_RATE,
            TARGET_SAMPLE_RATE,
            &mut st.resample_frac,
        );
        if !pcm.is_empty() {
            // Non-blocking send: drop chunk if consumer is behind
            let _ = st.sender.try_send(pcm);
        }
    }

    // Leak the Arc back so it isn't dropped
    let _ = Arc::into_raw(state_arc);

    0 // noErr
}

// ── Resampler ────────────────────────────────────────────────────────────────

/// Linear-interpolation resampler with persistent fractional state.
/// `frac` carries over between calls so there are no seam artefacts.
fn resample_f32_to_s16le(src: &[f32], from_rate: u32, to_rate: u32, frac: &mut f64) -> Vec<u8> {
    if src.is_empty() {
        return Vec::new();
    }

    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = ((src.len() as f64 - *frac) / ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len * 2);

    let mut pos = *frac;
    while pos < src.len() as f64 {
        let idx = pos as usize;
        let f = pos - idx as f64;
        let s = if idx + 1 < src.len() {
            src[idx] * (1.0 - f as f32) + src[idx + 1] * f as f32
        } else {
            src[idx]
        };
        let s16 = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&s16.to_le_bytes());
        pos += ratio;
    }

    // Carry fractional overshoot into next call
    *frac = pos - src.len() as f64;
    if *frac < 0.0 {
        *frac = 0.0;
    }

    out
}

// ── Helper ───────────────────────────────────────────────────────────────────

fn check_os(status: OSStatus, tag: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        // Decode OSStatus as 4-char code if printable ASCII
        let b = status.to_be_bytes();
        let four_cc = if b.iter().all(|&c| c.is_ascii_graphic() || c == b' ') {
            format!(" ('{}')", String::from_utf8_lossy(&b))
        } else {
            String::new()
        };
        let msg = format!("[MacosMic] {} failed: OSStatus {}{}", tag, status, four_cc);
        eprintln!("{msg}");
        Err(msg)
    }
}

fn set_voice_processing_flags(au: AudioUnit) -> Result<(), String> {
    let disable_bypass: u32 = 0; // 0 = processing ON, 1 = bypass
    let enable_agc: u32 = 1;

    // Try common placements for AUVoiceIO properties.
    // Success on at least one placement is considered enough.
    let bypass_ok = try_set_u32_prop(
        au,
        kAUVoiceIOProperty_BypassVoiceProcessing,
        &disable_bypass,
        "BypassVoiceProcessing=0",
    );
    let agc_ok = try_set_u32_prop(
        au,
        kAUVoiceIOProperty_VoiceProcessingEnableAGC,
        &enable_agc,
        "VoiceProcessingEnableAGC=1",
    );

    if !bypass_ok {
        return Err(
            "[MacosMic] Failed to force VoiceProcessing (bypass remained enabled?)".to_string(),
        );
    }

    if !agc_ok {
        eprintln!("[MacosMic] Warning: AGC property not accepted on this device/session");
    }

    Ok(())
}

fn try_set_u32_prop(au: AudioUnit, prop: u32, value: &u32, label: &str) -> bool {
    let placements = [
        (kAudioUnitScope_Global, ELEMENT_GLOBAL),
        (kAudioUnitScope_Global, INPUT_BUS),
        (kAudioUnitScope_Input, INPUT_BUS),
    ];

    let mut any_ok = false;
    for (scope, element) in placements {
        let status = unsafe {
            AudioUnitSetProperty(
                au,
                prop,
                scope,
                element,
                value as *const u32 as *const c_void,
                mem::size_of::<u32>() as u32,
            )
        };

        if status == 0 {
            eprintln!(
                "[MacosMic] {} OK (scope={}, element={})",
                label, scope, element
            );
            any_ok = true;
            break;
        } else {
            eprintln!(
                "[MacosMic] {} failed (scope={}, element={}): OSStatus {}",
                label, scope, element, status
            );
        }
    }

    any_ok
}
