'use strict';

// Installed only in the runner's isolated browser, never in the candidate bundle.
function installSyntheticBrowser(session) {
  if (window.top !== window || location.origin !== 'https://alphasourceai-com.onrender.com') return;
  if (location.pathname !== '/interview/live') return;
  sessionStorage.setItem('alphasource_interview_live_state', JSON.stringify(session));
  const runtime = { events: [], lastStop: 0, speaking: false, candidateSpeaking: false, call: null,
    recorder: null, chunks: [], recordingBytes: 0, recordingError: false, audio: null };
  window.__qaSynthetic = runtime;
  const context = new AudioContext();
  const microphone = context.createMediaStreamDestination();
  let activeSource = null;
  runtime.stopPlayback = () => {
    if (!activeSource) return;
    const source = activeSource;
    activeSource = null;
    try { source.stop(); } catch {}
    source.disconnect();
  };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const tracks = [];
    if (constraints?.audio) tracks.push(microphone.stream.getAudioTracks()[0].clone());
    return new MediaStream(tracks);
  };
  runtime.play = async (base64) => {
    if (activeSource) throw new Error('synthetic_audio_overlap');
    let resumeTimer;
    try {
      await Promise.race([context.resume(), new Promise((_, reject) => {
        resumeTimer = setTimeout(() => reject(new Error('synthetic_audio_resume_stalled')), 5000);
      })]);
    } finally { clearTimeout(resumeTimer); }
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    if (!bytes.length || bytes.length % 2 || bytes.length > 24000 * 2 * 30) throw new Error('synthetic_audio_invalid');
    // OpenAI PCM is mono, signed 16-bit little-endian at 24 kHz.
    const buffer = context.createBuffer(1, bytes.length / 2, 24000);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(microphone);
    source.connect(context.destination);
    activeSource = source;
    source.onended = () => { if (activeSource === source) runtime.stopPlayback(); };
    const startedAt = Date.now();
    source.start();
    // The driver waits for received speech; a missing onended callback is not a verdict.
    return { started_at: startedAt, duration_seconds: buffer.duration };
  };
  runtime.finishRecording = async () => {
    if (!runtime.recorder) return null;
    if (runtime.recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        runtime.recorder.addEventListener('stop', resolve, { once: true });
        runtime.recorder.stop();
      });
    }
    if (runtime.recordingError) return null;
    if (!runtime.audio) {
      const bytes = new Uint8Array(await new Blob(runtime.chunks, { type: 'audio/webm' }).arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      runtime.audio = btoa(binary);
    }
    return runtime.audio;
  };
  const attachRecording = (call) => {
    if (runtime.recorder) return;
    const participants = Object.values(call.participants?.() || {});
    const remote = participants.find((item) => !item.local &&
      (item.tracks?.audio?.persistentTrack || item.tracks?.audio?.track)?.readyState === 'live');
    const track = remote?.tracks?.audio?.persistentTrack || remote?.tracks?.audio?.track;
    if (!track) return;
    try {
      const recorder = new MediaRecorder(new MediaStream([track]), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
      recorder.ondataavailable = (event) => {
        runtime.recordingBytes += event.data.size;
        if (runtime.recordingBytes > 6 * 1024 * 1024) {
          runtime.recordingError = true;
          runtime.chunks = [];
          if (recorder.state !== 'inactive') recorder.stop();
        } else if (!runtime.recordingError) runtime.chunks.push(event.data);
      };
      recorder.onerror = () => { runtime.recordingError = true; };
      runtime.recorder = recorder;
      recorder.start(1000);
    } catch { runtime.recordingError = true; }
  };
  let sdk;
  Object.defineProperty(window, 'DailyIframe', {
    configurable: true,
    get: () => sdk,
    set: (value) => {
      sdk = value;
      if (!value?.createCallObject) return;
      const original = value.createCallObject;
      value.createCallObject = function (...args) {
        // Daily acquires media in its own context, so bind the synthetic track explicitly.
        const call = original.call(this, { ...args[0], audioSource: microphone.stream.getAudioTracks()[0],
          videoSource: false, startVideoOff: true,
          receiveSettings: { base: { video: { layer: 0 } } } });
        runtime.call = call;
        call.on('app-message', (event) => {
          const data = event?.data || {};
          const type = String(data.event_type || data.eventType || data.type || '').toLowerCase();
          const role = String(data.properties?.role || data.role || '').toLowerCase();
          const speech = String(data.properties?.speech || data.properties?.text || data.speech || data.text || '').slice(0, 2000);
          if (runtime.events.length < 200 && type) runtime.events.push({ type, role, speech, at: Date.now() });
          const started = /started[._-]speaking$/.test(type);
          const stopped = /stopped[._-]speaking$/.test(type);
          const candidate = ['candidate', 'user', 'participant'].includes(role) || /(?:^|[._-])user[._-]/.test(type);
          if (candidate && started) runtime.candidateSpeaking = true;
          if (candidate && stopped) runtime.candidateSpeaking = false;
          const pal = ['replica', 'pal', 'assistant', 'agent'].includes(role) || /(?:^|[._-])(?:replica|pal|assistant|agent)[._-]/.test(type);
          if (pal && started) runtime.speaking = true;
          const rolelessStop = type === 'conversation.stopped_speaking' && !role && runtime.speaking && !runtime.candidateSpeaking;
          if ((pal || rolelessStop) && stopped) { runtime.speaking = false; runtime.lastStop = Date.now(); }
        });
        for (const event of ['participant-updated', 'track-started', 'participant-joined']) {
          call.on(event, () => attachRecording(call));
        }
        return call;
      };
    },
  });
}

module.exports = { installSyntheticBrowser };
