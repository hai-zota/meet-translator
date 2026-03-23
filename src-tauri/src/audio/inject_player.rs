use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy)]
pub enum InjectChannel {
    Original,
    Translated,
}

pub enum InjectCommand {
    Play {
        device_name: String,
        pcm_data: Vec<u8>,
        sample_rate: u32,
        channel: InjectChannel,
    },
    Shutdown,
}

pub struct InjectPlayer {
    tx: mpsc::Sender<InjectCommand>,
}

impl InjectPlayer {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<InjectCommand>();

        std::thread::Builder::new()
            .name("inject-player".into())
            .spawn(move || {
                let mut active_output: Option<ActiveOutput> = None;

                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        InjectCommand::Play {
                            device_name,
                            pcm_data,
                            sample_rate,
                            channel,
                        } => {
                            let needs_rebuild = active_output
                                .as_ref()
                                .map(|output| output.device_name != device_name)
                                .unwrap_or(true);

                            if needs_rebuild {
                                match ActiveOutput::new(&device_name) {
                                    Ok(output) => active_output = Some(output),
                                    Err(err) => {
                                        active_output = None;
                                        eprintln!("[InjectPlayer] output init error: {}", err);
                                        continue;
                                    }
                                }
                            }

                            if let Some(output) = active_output.as_mut() {
                                if let Err(err) =
                                    output.enqueue_pcm(&pcm_data, sample_rate, channel)
                                {
                                    eprintln!("[InjectPlayer] playback error: {}", err);
                                    active_output = None;
                                }
                            }
                        }
                        InjectCommand::Shutdown => break,
                    }
                }
            })
            .expect("spawn inject-player thread");

        Self { tx }
    }

    pub fn play_pcm(
        &self,
        device_name: String,
        mut pcm_data: Vec<u8>,
        sample_rate: u32,
        channel: InjectChannel,
    ) -> Result<(), String> {
        if pcm_data.is_empty() {
            return Ok(());
        }
        if pcm_data.len() % 2 != 0 {
            pcm_data.pop();
            if pcm_data.is_empty() {
                return Ok(());
            }
        }

        self.tx
            .send(InjectCommand::Play {
                device_name,
                pcm_data,
                sample_rate,
                channel,
            })
            .map_err(|_| "Inject player thread stopped".to_string())
    }

    pub fn play_original_pcm(
        &self,
        device_name: String,
        pcm_data: Vec<u8>,
        sample_rate: u32,
    ) -> Result<(), String> {
        self.play_pcm(device_name, pcm_data, sample_rate, InjectChannel::Original)
    }

    pub fn play_translated_pcm(
        &self,
        device_name: String,
        pcm_data: Vec<u8>,
        sample_rate: u32,
    ) -> Result<(), String> {
        self.play_pcm(
            device_name,
            pcm_data,
            sample_rate,
            InjectChannel::Translated,
        )
    }
}

impl Drop for InjectPlayer {
    fn drop(&mut self) {
        let _ = self.tx.send(InjectCommand::Shutdown);
    }
}

pub struct InjectPlayerState {
    pub player: Mutex<InjectPlayer>,
}

struct ActiveOutput {
    device_name: String,
    out_rate: u32,
    out_channels: u16,
    max_buffered_samples: usize,
    queues: Arc<Mutex<MixQueues>>,
    _stream: cpal::Stream,
}

struct MixQueues {
    original: VecDeque<f32>,
    translated: VecDeque<f32>,
    duck_gain: f32,
    translated_env: f32,
}

impl ActiveOutput {
    fn new(device_name: &str) -> Result<Self, String> {
        let device = find_output_device(device_name)?;
        let supported = device
            .default_output_config()
            .map_err(|e| format!("Failed to get output config: {}", e))?;

        let out_rate = supported.sample_rate().0.max(1);
        let out_channels = supported.channels().max(1);
        // Larger queue smooths bursty TTS chunk arrivals from frontend and
        // reduces underflow crackle on virtual devices like BlackHole.
        let max_buffered_samples = out_rate as usize * out_channels as usize * 12;
        let queues = Arc::new(Mutex::new(MixQueues {
            original: VecDeque::with_capacity(max_buffered_samples.min(65536)),
            translated: VecDeque::with_capacity(max_buffered_samples.min(65536)),
            duck_gain: 1.0,
            translated_env: 0.0,
        }));

        let err_fn = |err| {
            eprintln!("[InjectPlayer] output stream error: {}", err);
        };
        let stream_config: cpal::StreamConfig = supported.clone().into();

        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => {
                let queues = Arc::clone(&queues);
                device
                    .build_output_stream(
                        &stream_config,
                        move |output: &mut [f32], _| {
                            write_samples_f32(output, &queues);
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| format!("Failed to build f32 output stream: {}", e))?
            }
            cpal::SampleFormat::I16 => {
                let queues = Arc::clone(&queues);
                device
                    .build_output_stream(
                        &stream_config,
                        move |output: &mut [i16], _| {
                            write_samples_i16(output, &queues);
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| format!("Failed to build i16 output stream: {}", e))?
            }
            cpal::SampleFormat::U16 => {
                let queues = Arc::clone(&queues);
                device
                    .build_output_stream(
                        &stream_config,
                        move |output: &mut [u16], _| {
                            write_samples_u16(output, &queues);
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| format!("Failed to build u16 output stream: {}", e))?
            }
            _ => return Err("Unsupported output sample format".to_string()),
        };

        stream
            .play()
            .map_err(|e| format!("Failed to play output stream: {}", e))?;

        Ok(Self {
            device_name: device_name.to_string(),
            out_rate,
            out_channels,
            max_buffered_samples,
            queues,
            _stream: stream,
        })
    }

    fn enqueue_pcm(
        &mut self,
        pcm_data: &[u8],
        input_rate: u32,
        channel: InjectChannel,
    ) -> Result<(), String> {
        let input_i16: Vec<i16> = pcm_data
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();

        if input_i16.is_empty() {
            return Ok(());
        }

        let output_f32 = resample_mono_i16_to_interleaved_f32(
            &input_i16,
            input_rate.max(1),
            self.out_rate,
            self.out_channels,
        );

        let mut queues = self
            .queues
            .lock()
            .map_err(|_| "Inject mix queue lock poisoned".to_string())?;

        let target = match channel {
            InjectChannel::Original => &mut queues.original,
            InjectChannel::Translated => &mut queues.translated,
        };

        let overflow = target
            .len()
            .saturating_add(output_f32.len())
            .saturating_sub(self.max_buffered_samples);
        if overflow > 0 {
            target.drain(..overflow);
        }

        target.extend(output_f32);
        Ok(())
    }
}

fn find_output_device(device_name: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let requested = device_name.to_lowercase();
    let mut devices = host
        .output_devices()
        .map_err(|e| format!("Failed to enumerate output devices: {}", e))?;

    let mut all_names: Vec<String> = Vec::new();
    let mut matched_exact: Option<cpal::Device> = None;
    let mut matched_contains: Option<cpal::Device> = None;

    for d in devices.by_ref() {
        let name = d.name().unwrap_or_else(|_| "<unknown>".to_string());
        all_names.push(name.clone());
        let normalized = name.to_lowercase();
        if matched_exact.is_none() && normalized == requested {
            matched_exact = Some(d);
            continue;
        }
        if matched_contains.is_none() && normalized.contains(&requested) {
            matched_contains = Some(d);
        }
    }

    matched_exact.or(matched_contains).ok_or_else(|| {
        format!(
            "Output device not found: {}. Available outputs: {}",
            device_name,
            all_names.join(", ")
        )
    })
}

fn resample_mono_i16_to_interleaved_f32(
    input: &[i16],
    in_rate: u32,
    out_rate: u32,
    out_channels: u16,
) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }

    if input.len() == 1 {
        let sample = input[0] as f32 / 32768.0;
        return vec![sample; out_channels as usize];
    }

    let out_frames =
        ((input.len() as f64) * (out_rate as f64) / (in_rate as f64)).max(1.0) as usize;
    let mut out = Vec::with_capacity(out_frames * out_channels as usize);

    for frame_idx in 0..out_frames {
        let src_pos = (frame_idx as f64) * (in_rate as f64) / (out_rate as f64);
        let base_idx = src_pos.floor() as usize;
        let next_idx = (base_idx + 1).min(input.len() - 1);
        let frac = (src_pos - base_idx as f64) as f32;

        let a = input[base_idx] as f32 / 32768.0;
        let b = input[next_idx] as f32 / 32768.0;
        let sample = a + ((b - a) * frac);

        for _ in 0..out_channels {
            out.push(sample);
        }
    }

    out
}

fn pop_mixed_sample(queues: &mut MixQueues) -> f32 {
    let translated = queues.translated.pop_front().unwrap_or(0.0);
    let original = queues.original.pop_front().unwrap_or(0.0);
    let translated_queue_has_more = !queues.translated.is_empty();

    // Envelope avoids per-sample flicker at zero-crossings while translated is still flowing.
    let abs_translated = translated.abs();
    if translated_queue_has_more {
        queues.translated_env = (queues.translated_env * 0.98) + (abs_translated * 0.02);
    } else {
        // Hard reset as soon as translated stream is drained.
        queues.translated_env = 0.0;
    }

    let translated_active =
        translated_queue_has_more && (abs_translated > 0.003 || queues.translated_env > 0.0035);
    let target_gain = if translated_active { 0.30 } else { 1.0 };

    // Requirement:
    // - translated starts -> fade original down to 30%
    // - translated ends   -> return original to 100% immediately
    if translated_active {
        queues.duck_gain = (queues.duck_gain - 0.00012).max(target_gain);
    } else {
        queues.duck_gain = 1.0;
    }

    let mixed = translated + (original * queues.duck_gain);
    mixed.tanh().clamp(-1.0, 1.0)
}

fn write_samples_f32(output: &mut [f32], queues: &Arc<Mutex<MixQueues>>) {
    let mut guard = match queues.lock() {
        Ok(guard) => guard,
        Err(_) => {
            output.fill(0.0);
            return;
        }
    };

    for sample in output.iter_mut() {
        *sample = pop_mixed_sample(&mut guard);
    }
}

fn write_samples_i16(output: &mut [i16], queues: &Arc<Mutex<MixQueues>>) {
    let mut guard = match queues.lock() {
        Ok(guard) => guard,
        Err(_) => {
            output.fill(0);
            return;
        }
    };

    for sample in output.iter_mut() {
        let v = pop_mixed_sample(&mut guard);
        *sample = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
    }
}

fn write_samples_u16(output: &mut [u16], queues: &Arc<Mutex<MixQueues>>) {
    let mut guard = match queues.lock() {
        Ok(guard) => guard,
        Err(_) => {
            output.fill(u16::MAX / 2);
            return;
        }
    };

    for sample in output.iter_mut() {
        let v = pop_mixed_sample(&mut guard);
        *sample = ((v.clamp(-1.0, 1.0) * 0.5 + 0.5) * (u16::MAX as f32)) as u16;
    }
}
