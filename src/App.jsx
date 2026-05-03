import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, Plus, Trash2, Activity } from 'lucide-react';
import './index.css';

// ---------------------------------------------------------------------------
// Pre-render metronome clicks into a WAV blob played by an <audio> element.
// iOS keeps <audio> alive in the background, so the clicks keep playing even
// when the screen is off or the user switches apps.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100;
const TARGET_DURATION_SEC = 60; // generate up to 10 min of audio

/** Build a timing map: array of { time, beat, measure, bpm } */
function buildTimingMap(baseBpm, beatsPerMeasure, rules, preRollMeasures) {
  const map = [];
  let currentBpm = baseBpm;
  let time = 0;
  const startMeasure = preRollMeasures > 0 ? -(preRollMeasures - 1) : 1;
  let measure = startMeasure;

  while (time < TARGET_DURATION_SEC) {
    // Apply rule at measure start
    if (measure > 0) {
      const rule = rules.find(r => r.measure === measure);
      if (rule) currentBpm = rule.newBpm;
    }
    const secPerBeat = 60.0 / currentBpm;
    for (let beat = 0; beat < beatsPerMeasure; beat++) {
      if (time >= TARGET_DURATION_SEC) break;
      map.push({ time, beat, measure, bpm: currentBpm });
      time += secPerBeat;
    }
    measure++;
  }
  return { map, totalDuration: time };
}

/** Use OfflineAudioContext to render all clicks into an AudioBuffer */
async function renderClicks(timingMap, totalDuration) {
  const length = Math.ceil(totalDuration * SAMPLE_RATE);
  const offCtx = new OfflineAudioContext(1, length, SAMPLE_RATE);

  for (const entry of timingMap) {
    const t = entry.time;
    const isPreRoll = entry.measure <= 0;
    const isAccent = entry.beat === 0;

    const osc = offCtx.createOscillator();
    const env = offCtx.createGain();
    osc.type = 'sine';

    if (isPreRoll) {
      osc.frequency.value = isAccent ? 3000 : 2400;
      env.gain.setValueAtTime(0.001, t);
      env.gain.exponentialRampToValueAtTime(0.6, t + 0.001);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.connect(env); env.connect(offCtx.destination);
      osc.start(t); osc.stop(t + 0.2);
    } else {
      osc.frequency.value = isAccent ? 1200 : 800;
      env.gain.setValueAtTime(0.001, t);
      env.gain.exponentialRampToValueAtTime(1.0, t + 0.001);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.connect(env); env.connect(offCtx.destination);
      osc.start(t); osc.stop(t + 0.06);
    }
  }

  return offCtx.startRendering();
}

/** Convert an AudioBuffer to a WAV Blob URL */
function audioBufferToWavUrl(audioBuffer) {
  const numSamples = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const dataSize = numSamples * 2; // 16-bit
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

// ---------------------------------------------------------------------------
// React App
// ---------------------------------------------------------------------------
function App() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [baseBpm, setBaseBpm] = useState(() => {
    const s = localStorage.getItem('chronoBeat_baseBpm');
    return s !== null ? parseInt(s, 10) : 120;
  });
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(() => {
    const s = localStorage.getItem('chronoBeat_beatsPerMeasure');
    return s !== null ? parseInt(s, 10) : 4;
  });
  const [preRollMeasures, setPreRollMeasures] = useState(() => {
    const s = localStorage.getItem('chronoBeat_preRollMeasures');
    return s !== null ? parseInt(s, 10) : 0;
  });
  const [rules, setRules] = useState(() => {
    const s = localStorage.getItem('chronoBeat_rules');
    if (s) { try { return JSON.parse(s); } catch (_) { return []; } }
    return [];
  });

  useEffect(() => { localStorage.setItem('chronoBeat_baseBpm', baseBpm.toString()); }, [baseBpm]);
  useEffect(() => { localStorage.setItem('chronoBeat_beatsPerMeasure', beatsPerMeasure.toString()); }, [beatsPerMeasure]);
  useEffect(() => { localStorage.setItem('chronoBeat_preRollMeasures', preRollMeasures.toString()); }, [preRollMeasures]);
  useEffect(() => { localStorage.setItem('chronoBeat_rules', JSON.stringify(rules)); }, [rules]);

  const [displayMeasure, setDisplayMeasure] = useState(1);
  const [displayBeat, setDisplayBeat] = useState(1);
  const [displayBpm, setDisplayBpm] = useState(baseBpm);
  const [isRendering, setIsRendering] = useState(false);

  const audioElRef = useRef(null);       // <audio> element
  const wavUrlRef = useRef(null);        // current WAV blob URL
  const timingMapRef = useRef([]);       // timing map for visual tracking
  const rafRef = useRef(null);           // requestAnimationFrame id
  const isPlayingRef = useRef(false);
  const wakeLockRef = useRef(null);

  // ── MediaSession (lock-screen metadata) ──
  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'ChronoBeat', artist: 'Metronome', album: 'Running',
      });
      navigator.mediaSession.setActionHandler('play', () => { });
      navigator.mediaSession.setActionHandler('pause', () => { });
    }
  }, []);

  // ── Visual tracker: uses rAF + audio.currentTime to find current beat ──
  const trackVisuals = useCallback(() => {
    if (!isPlayingRef.current || !audioElRef.current) return;

    const t = audioElRef.current.currentTime;
    const map = timingMapRef.current;
    // Binary-ish search for the last entry whose time <= t
    let lo = 0, hi = map.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (map[mid].time <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const entry = map[idx];
    if (entry) {
      setDisplayBeat(entry.beat + 1);
      setDisplayMeasure(entry.measure);
      setDisplayBpm(entry.bpm);
    }
    rafRef.current = requestAnimationFrame(trackVisuals);
  }, []);

  // ── Wake Lock ──
  const requestWakeLock = async () => {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          if (isPlayingRef.current && document.visibilityState === 'visible') requestWakeLock();
        });
      } catch (_) { }
    }
  };
  const releaseWakeLock = () => {
    if (wakeLockRef.current) { wakeLockRef.current.release().catch(() => { }); wakeLockRef.current = null; }
  };

  // ── Re-acquire wake lock when returning to foreground ──
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && isPlayingRef.current) requestWakeLock();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // ── Toggle Play/Stop ──
  const togglePlay = async () => {
    if (isPlaying) {
      // STOP
      isPlayingRef.current = false;
      setIsPlaying(false);
      if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.currentTime = 0; }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      releaseWakeLock();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      // free memory
      if (wavUrlRef.current) { URL.revokeObjectURL(wavUrlRef.current); wavUrlRef.current = null; }
    } else {
      // START — render the full metronome audio, then play
      setIsRendering(true);
      try {
        const { map, totalDuration } = buildTimingMap(baseBpm, beatsPerMeasure, rules, preRollMeasures);
        timingMapRef.current = map;

        const audioBuffer = await renderClicks(map, totalDuration);
        const wavUrl = audioBufferToWavUrl(audioBuffer);

        // Clean up previous blob
        if (wavUrlRef.current) URL.revokeObjectURL(wavUrlRef.current);
        wavUrlRef.current = wavUrl;

        if (!audioElRef.current) {
          audioElRef.current = new Audio();
          audioElRef.current.setAttribute('playsinline', '');
        }
        audioElRef.current.src = wavUrl;
        audioElRef.current.loop = false;

        // When audio ends naturally (ran out of pre-rendered audio)
        audioElRef.current.onended = () => {
          if (isPlayingRef.current) {
            isPlayingRef.current = false;
            setIsPlaying(false);
            releaseWakeLock();
          }
        };

        await audioElRef.current.play();

        isPlayingRef.current = true;
        setIsPlaying(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        requestWakeLock();
        rafRef.current = requestAnimationFrame(trackVisuals);
      } catch (err) {
        console.error('Failed to start metronome:', err);
      } finally {
        setIsRendering(false);
      }
    }
  };

  // ── Rules management ──
  const addRule = () => setRules([...rules, { measure: 5, newBpm: 140 }]);
  const updateRule = (i, field, val) => {
    const r = [...rules]; r[i][field] = parseInt(val, 10) || 1; setRules(r);
  };
  const deleteRule = (i) => setRules(rules.filter((_, j) => j !== i));

  useEffect(() => {
    if (!isPlaying) { setDisplayBpm(baseBpm); }
  }, [baseBpm, isPlaying]);

  // ── Render ──
  return (
    <div className="glass-panel">
      <div className="header">
        <h1 className="title">ChronoBeat</h1>
        <div className="subtitle">Programmable Smart Metronome</div>
      </div>

      <div className="bpm-display">
        {displayBpm} <span style={{ fontSize: '1.5rem', color: 'var(--text-muted)' }}>BPM</span>
      </div>

      <div className="beat-indicators">
        {Array.from({ length: beatsPerMeasure }).map((_, i) => (
          <div key={i} className={`beat-dot ${displayBeat === i + 1 && isPlaying ? 'active' : ''} ${i === 0 ? 'first-beat' : ''}`} />
        ))}
      </div>

      <div className="status-display">
        <div className="status-item">
          <div className="status-label">Measure</div>
          <div className="status-value">{displayMeasure <= 0 ? `Pre ${preRollMeasures + displayMeasure}` : displayMeasure}</div>
        </div>
        <div className="status-item">
          <div className="status-label">Beat</div>
          <div className="status-value">{displayBeat} / {beatsPerMeasure}</div>
        </div>
      </div>

      <div className="control-group" style={{ marginTop: '2rem' }}>
        <label className="control-label">Base BPM</label>
        <div className="slider-container">
          <input type="range" className="slider" min="30" max="300" value={baseBpm}
            onChange={(e) => setBaseBpm(parseInt(e.target.value))} disabled={isPlaying} />
        </div>
      </div>

      <div className="flex-row control-group">
        <div className="flex-1">
          <label className="control-label">Time Signature</label>
          <select value={beatsPerMeasure} onChange={(e) => setBeatsPerMeasure(parseInt(e.target.value))} disabled={isPlaying}>
            <option value="2">2/4</option>
            <option value="3">3/4</option>
            <option value="4">4/4</option>
            <option value="5">5/4</option>
            <option value="6">6/8</option>
            <option value="7">7/8</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="control-label">Pre-roll Measures</label>
          <input type="number" min="0" max="10" value={preRollMeasures}
            onChange={(e) => setPreRollMeasures(parseInt(e.target.value) || 0)} disabled={isPlaying} />
        </div>
      </div>

      <button className={`btn btn-primary ${isPlaying ? 'active' : ''}`} onClick={togglePlay} disabled={isRendering}>
        {isRendering ? (
          <><span className="spinner" /> RENDERING...</>
        ) : isPlaying ? (
          <><Square size={24} /> STOP</>
        ) : (
          <><Play size={24} fill="currentColor" /> START METRONOME</>
        )}
      </button>

      <div className="rules-container">
        <div className="rules-header">
          <label className="control-label" style={{ margin: 0 }}>
            <Activity size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '8px' }} /> Programming
          </label>
          <button className="btn btn-secondary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }} onClick={addRule}>
            <Plus size={16} /> Add Change
          </button>
        </div>
        {rules.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1rem', fontStyle: 'italic', fontSize: '0.9rem' }}>
            No tempo changes programmed. The metronome will run at Base BPM.
          </div>
        ) : (
          rules.map((rule, idx) => (
            <div key={idx} className="rule-item">
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>At Measure</span>
                <input type="number" min="2" value={rule.measure}
                  onChange={(e) => updateRule(idx, 'measure', e.target.value)}
                  style={{ marginTop: '0.2rem', padding: '0.5rem' }} />
              </div>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Change to (BPM)</span>
                <input type="number" min="30" max="300" value={rule.newBpm}
                  onChange={(e) => updateRule(idx, 'newBpm', e.target.value)}
                  style={{ marginTop: '0.2rem', padding: '0.5rem' }} />
              </div>
              <button className="btn btn-danger" onClick={() => deleteRule(idx)} style={{ marginTop: '1.4rem' }}>
                <Trash2 size={20} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default App;
