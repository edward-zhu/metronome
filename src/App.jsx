import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, Plus, Trash2, Activity } from 'lucide-react';
import './index.css';

// ---------------------------------------------------------------------------
// Direct PCM generation — much faster than OfflineAudioContext.
// We only compute sine samples for actual clicks; the rest is zero-filled.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100;
const LOOP_MEASURES = 32; // Generate many measures per WAV to minimize loop-gap frequency

/** Write a WAV header into a DataView */
function writeWavHeader(view, numSamples, sampleRate) {
  const dataSize = numSamples * 2;
  const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, dataSize, true);
}

/** Stamp a click (sine burst with exponential decay) into an Int16 PCM buffer */
function stampClick(pcm, startSample, freq, amplitude, decayRate, durationSec) {
  const clickLen = Math.min(Math.ceil(SAMPLE_RATE * durationSec), pcm.length - startSample);
  const twoPiF = 2 * Math.PI * freq / SAMPLE_RATE;
  for (let i = 0; i < clickLen; i++) {
    const t = i / SAMPLE_RATE;
    const val = Math.sin(twoPiF * i) * amplitude * Math.exp(-t * decayRate);
    const sample = val < 0 ? val * 0x8000 : val * 0x7FFF;
    pcm[startSample + i] = Math.max(-32768, Math.min(32767, pcm[startSample + i] + (sample | 0)));
  }
}

/**
 * Build a timing map and generate a WAV blob URL.
 *
 * Strategy:
 *   - No rules → render 1 measure, loop=true  (tiny, instant)
 *   - With rules → render pre-roll + all rules + 8 extra measures
 *   - With pre-roll (no rules) → render pre-roll + 1 regular measure,
 *     then on `ended` switch to a looped single-measure WAV
 */
function generateMeasures(baseBpm, beatsPerMeasure, rules, startMeasure, endMeasure) {
  const timingMap = [];
  let currentBpm = baseBpm;
  let time = 0;

  for (let measure = startMeasure; measure <= endMeasure; measure++) {
    if (measure > 0) {
      const rule = rules.find(r => r.measure === measure);
      if (rule) currentBpm = rule.newBpm;
    }
    const secPerBeat = 60.0 / currentBpm;
    for (let beat = 0; beat < beatsPerMeasure; beat++) {
      timingMap.push({ time, beat, measure, bpm: currentBpm });
      time += secPerBeat;
    }
  }

  // Generate PCM
  const totalSamples = Math.ceil(time * SAMPLE_RATE);
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);
  const pcm = new Int16Array(buffer, 44);

  writeWavHeader(view, totalSamples, SAMPLE_RATE);

  for (const entry of timingMap) {
    const startSample = Math.round(entry.time * SAMPLE_RATE);
    const isPreRoll = entry.measure <= 0;
    const isAccent = entry.beat === 0;

    if (isPreRoll) {
      stampClick(pcm, startSample, isAccent ? 3000 : 2400, 0.5, 30, 0.2);
    } else {
      stampClick(pcm, startSample, isAccent ? 1200 : 800, 0.9, 80, 0.06);
    }
  }

  const wavUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return { wavUrl, timingMap, totalDuration: time, finalBpm: timingMap.length > 0 ? timingMap[timingMap.length - 1].bpm : baseBpm };
}

// ---------------------------------------------------------------------------
// React App
// ---------------------------------------------------------------------------
function App() {
  const [bpmEditing, setBpmEditing] = useState(false);
  const [bpmDraft, setBpmDraft] = useState('');
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

  const audioElRef = useRef(null);       // <audio> element
  const wavUrlRef = useRef(null);        // current WAV blob URL
  const loopWavUrlRef = useRef(null);    // single-measure loop WAV for after initial plays
  const timingMapRef = useRef([]);       // timing map for visual tracking
  const rafRef = useRef(null);
  const isPlayingRef = useRef(false);
  const wakeLockRef = useRef(null);
  const measureCounterRef = useRef(1);   // tracks total measures for visual display when looping
  const prevTimeRef = useRef(0);          // previous currentTime, used to detect loop wrap-around

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

  // ── Visual tracker ──
  const trackVisuals = useCallback(() => {
    if (!isPlayingRef.current || !audioElRef.current) return;

    const t = audioElRef.current.currentTime;
    const map = timingMapRef.current;
    if (map.length === 0) { rafRef.current = requestAnimationFrame(trackVisuals); return; }

    // Detect loop wrap-around: currentTime jumped backwards significantly
    if (prevTimeRef.current > 0.1 && t < prevTimeRef.current - 0.05) {
      measureCounterRef.current += LOOP_MEASURES;
    }
    prevTimeRef.current = t;

    // Binary search for the last entry whose time <= t
    let lo = 0, hi = map.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (map[mid].time <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const entry = map[idx];
    if (entry) {
      setDisplayBeat(entry.beat + 1);
      setDisplayMeasure(entry.measure + measureCounterRef.current);
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

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && isPlayingRef.current) requestWakeLock();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // ── Cleanup blob URLs ──
  const cleanupUrls = () => {
    if (wavUrlRef.current) { URL.revokeObjectURL(wavUrlRef.current); wavUrlRef.current = null; }
    if (loopWavUrlRef.current) { URL.revokeObjectURL(loopWavUrlRef.current); loopWavUrlRef.current = null; }
  };

  // ── Get or create <audio> element ──
  const getAudioEl = () => {
    if (!audioElRef.current) {
      audioElRef.current = new Audio();
      audioElRef.current.setAttribute('playsinline', '');
    }
    return audioElRef.current;
  };

  // ── Toggle Play/Stop ──
  const togglePlay = () => {
    if (isPlaying) {
      // STOP
      isPlayingRef.current = false;
      setIsPlaying(false);
      prevTimeRef.current = 0;
      const audio = audioElRef.current;
      if (audio) { audio.pause(); audio.currentTime = 0; audio.onended = null; }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      releaseWakeLock();
      cleanupUrls();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      return;
    }

    // START
    const startMeasure = preRollMeasures > 0 ? -(preRollMeasures - 1) : 1;
    const hasRules = rules.length > 0;
    const maxRuleMeasure = hasRules ? Math.max(...rules.map(r => r.measure)) : 0;

    // Determine how many measures to render for the initial WAV
    let endMeasure;
    let willLoop;
    if (!hasRules && preRollMeasures === 0) {
      // Simplest case: many measures in one WAV, loop forever
      endMeasure = LOOP_MEASURES;
      willLoop = true;
    } else if (!hasRules && preRollMeasures > 0) {
      // Pre-roll then many regular measures; after it ends, switch to looped WAV
      endMeasure = LOOP_MEASURES;
      willLoop = false;
    } else {
      // Has rules: render through all rules + many extra measures at final BPM
      endMeasure = maxRuleMeasure + LOOP_MEASURES;
      willLoop = false;
    }

    cleanupUrls();
    const result = generateMeasures(baseBpm, beatsPerMeasure, rules, startMeasure, endMeasure);
    wavUrlRef.current = result.wavUrl;
    timingMapRef.current = result.timingMap;
    measureCounterRef.current = 0; // no offset for initial playback
    prevTimeRef.current = 0;

    // Pre-generate the looped multi-measure WAV at final BPM for after initial ends
    const finalBpm = result.finalBpm;
    const loopResult = generateMeasures(finalBpm, beatsPerMeasure, [], 1, LOOP_MEASURES);
    loopWavUrlRef.current = loopResult.wavUrl;

    const audio = getAudioEl();
    audio.src = result.wavUrl;
    audio.loop = willLoop; // Use native loop for seamless playback; measure tracking via currentTime wrap detection

    // When initial (non-looped) WAV ends, switch to looping single-measure WAV
    audio.onended = () => {
      if (!isPlayingRef.current) return;
      // Transition to loop WAV; measure counter is incremented via wrap detection in trackVisuals
      measureCounterRef.current = endMeasure;
      prevTimeRef.current = 0;
      timingMapRef.current = loopResult.timingMap;
      audio.src = loopWavUrlRef.current;
      audio.loop = true;
      audio.play().catch(() => { });
    };

    audio.play().then(() => {
      isPlayingRef.current = true;
      setIsPlaying(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      requestWakeLock();
      rafRef.current = requestAnimationFrame(trackVisuals);
    }).catch(err => {
      console.error('Failed to start metronome:', err);
    });
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
        <div className="bpm-stepper">
          <button className="stepper-btn" onClick={() => setBaseBpm(Math.max(30, baseBpm - 5))} disabled={isPlaying}>-5</button>
          <button className="stepper-btn" onClick={() => setBaseBpm(Math.max(30, baseBpm - 1))} disabled={isPlaying}>-</button>
          {bpmEditing ? (
            <input
              className="bpm-inline-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoFocus
              value={bpmDraft}
              onChange={(e) => setBpmDraft(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={() => {
                const v = parseInt(bpmDraft, 10);
                if (v >= 30 && v <= 300) setBaseBpm(v);
                setBpmEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
              }}
            />
          ) : (
            <button className="bpm-value-btn" onClick={() => { if (!isPlaying) { setBpmDraft(String(baseBpm)); setBpmEditing(true); } }} disabled={isPlaying}>
              {baseBpm}
            </button>
          )}
          <button className="stepper-btn" onClick={() => setBaseBpm(Math.min(300, baseBpm + 1))} disabled={isPlaying}>+</button>
          <button className="stepper-btn" onClick={() => setBaseBpm(Math.min(300, baseBpm + 5))} disabled={isPlaying}>+5</button>
        </div>
        <div className="slider-container" style={{ marginTop: '0.75rem' }}>
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
          <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" max="10" value={preRollMeasures}
            onChange={(e) => setPreRollMeasures(parseInt(e.target.value) || 0)} disabled={isPlaying} />
        </div>
      </div>

      <button className={`btn btn-primary ${isPlaying ? 'active' : ''}`} onClick={togglePlay}>
        {isPlaying ? (
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
                <input type="number" inputMode="numeric" pattern="[0-9]*" min="2" value={rule.measure}
                  onChange={(e) => updateRule(idx, 'measure', e.target.value)}
                  style={{ marginTop: '0.2rem', padding: '0.5rem' }} />
              </div>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Change to (BPM)</span>
                <input type="number" inputMode="numeric" pattern="[0-9]*" min="30" max="300" value={rule.newBpm}
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
