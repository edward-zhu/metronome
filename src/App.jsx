import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, Plus, Trash2, Activity } from 'lucide-react';
import './index.css';

const workerCode = `
  let timerID = null;
  self.onmessage = function(e) {
    if (e.data === 'start') {
      timerID = setInterval(function() {
        postMessage('tick');
      }, 25);
    } else if (e.data === 'stop') {
      clearInterval(timerID);
      timerID = null;
    }
  };
`;
const silentAudioUri = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

function App() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [baseBpm, setBaseBpm] = useState(() => {
    const saved = localStorage.getItem('chronoBeat_baseBpm');
    return saved !== null ? parseInt(saved, 10) : 120;
  });
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(() => {
    const saved = localStorage.getItem('chronoBeat_beatsPerMeasure');
    return saved !== null ? parseInt(saved, 10) : 4;
  });
  const [preRollMeasures, setPreRollMeasures] = useState(() => {
    const saved = localStorage.getItem('chronoBeat_preRollMeasures');
    return saved !== null ? parseInt(saved, 10) : 0;
  });
  const [rules, setRules] = useState(() => {
    const saved = localStorage.getItem('chronoBeat_rules');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { return []; }
    }
    return [];
  });

  useEffect(() => { localStorage.setItem('chronoBeat_baseBpm', baseBpm.toString()); }, [baseBpm]);
  useEffect(() => { localStorage.setItem('chronoBeat_beatsPerMeasure', beatsPerMeasure.toString()); }, [beatsPerMeasure]);
  useEffect(() => { localStorage.setItem('chronoBeat_preRollMeasures', preRollMeasures.toString()); }, [preRollMeasures]);
  useEffect(() => { localStorage.setItem('chronoBeat_rules', JSON.stringify(rules)); }, [rules]);

  const [displayMeasure, setDisplayMeasure] = useState(1);
  const [displayBeat, setDisplayBeat] = useState(1);
  const [displayBpm, setDisplayBpm] = useState(baseBpm);

  // Audio Context and scheduling references
  const audioCtxRef = useRef(null);
  const nextNoteTimeRef = useRef(0);
  const currentBeatRef = useRef(0);
  const currentMeasureRef = useRef(1);
  const currentBpmRef = useRef(baseBpm);

  const workerRef = useRef(null);
  const silentAudioRef = useRef(null);
  const schedulerRef = useRef(null);

  useEffect(() => {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    workerRef.current = new Worker(URL.createObjectURL(blob));

    const audio = new Audio(silentAudioUri);
    audio.loop = true;
    audio.playsInline = true;
    silentAudioRef.current = audio;

    return () => {
      workerRef.current.terminate();
      audio.pause();
    };
  }, []);

  const initAudio = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
  };

  const scheduleNote = (beatNumber, time, measureNumber, bpmAtThisNote) => {
    // Visual update
    const timeToNote = time - audioCtxRef.current.currentTime;
    setTimeout(() => {
      setDisplayBeat(beatNumber + 1);
      setDisplayMeasure(measureNumber);
      setDisplayBpm(bpmAtThisNote);
    }, Math.max(0, timeToNote * 1000));

    // Audio synthesis
    const osc = audioCtxRef.current.createOscillator();
    const envelope = audioCtxRef.current.createGain();

    const isPreRoll = measureNumber <= 0;

    if (isPreRoll) {
      // Bell-like thinner sound for pre-roll
      osc.type = 'sine';
      osc.frequency.value = beatNumber === 0 ? 3000 : 2400; // High pitch
      envelope.gain.value = 0.5; // Slightly quieter, thinner
      envelope.gain.exponentialRampToValueAtTime(1, time + 0.001);
      envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.15); // Longer decay

      osc.connect(envelope);
      envelope.connect(audioCtxRef.current.destination);

      osc.start(time);
      osc.stop(time + 0.2);
    } else {
      // Standard sharp click for normal measures
      osc.type = 'sine';
      osc.frequency.value = beatNumber === 0 ? 1200 : 800; // Accent on first beat
      envelope.gain.value = 1;
      envelope.gain.exponentialRampToValueAtTime(1, time + 0.001);
      envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      osc.connect(envelope);
      envelope.connect(audioCtxRef.current.destination);

      osc.start(time);
      osc.stop(time + 0.06);
    }
  };

  const nextNote = () => {
    const secondsPerBeat = 60.0 / currentBpmRef.current;
    nextNoteTimeRef.current += secondsPerBeat;

    currentBeatRef.current++;
    if (currentBeatRef.current >= beatsPerMeasure) {
      currentBeatRef.current = 0;
      currentMeasureRef.current++;

      // Apply rules exactly at measure start, only if in actual measures
      if (currentMeasureRef.current > 0) {
        const rule = rules.find(r => r.measure === currentMeasureRef.current);
        if (rule) {
          currentBpmRef.current = rule.newBpm;
        }
      }
    }
  };

  const scheduler = () => {
    if (!isPlayingRef.current) return;

    while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + 0.1) {
      scheduleNote(currentBeatRef.current, nextNoteTimeRef.current, currentMeasureRef.current, currentBpmRef.current);
      nextNote();
    }
  };

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    schedulerRef.current = scheduler;

    if (workerRef.current) {
      workerRef.current.onmessage = (e) => {
        if (e.data === 'tick' && schedulerRef.current) {
          schedulerRef.current();
        }
      };
    }
  });

  const togglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      workerRef.current.postMessage('stop');
      silentAudioRef.current.pause();
    } else {
      initAudio();
      currentBeatRef.current = 0;
      currentMeasureRef.current = preRollMeasures > 0 ? -(preRollMeasures - 1) : 1;
      currentBpmRef.current = baseBpm;
      nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;

      setDisplayMeasure(currentMeasureRef.current);
      setDisplayBeat(1);
      setDisplayBpm(baseBpm);

      setIsPlaying(true);
      isPlayingRef.current = true;
      silentAudioRef.current.play().catch(e => console.log('Silent audio block', e));
      workerRef.current.postMessage('start');
    }
  };

  const addRule = () => {
    setRules([...rules, { measure: currentMeasureRef.current + 2, newBpm: 140 }]);
  };

  const updateRule = (index, field, value) => {
    const newRules = [...rules];
    newRules[index][field] = parseInt(value, 10) || 1;
    setRules(newRules);
  };

  const deleteRule = (index) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  useEffect(() => {
    if (!isPlaying) {
      setDisplayBpm(baseBpm);
      currentBpmRef.current = baseBpm;
    }
  }, [baseBpm, isPlaying]);

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
          <div
            key={i}
            className={`beat-dot ${displayBeat === i + 1 && isPlaying ? 'active' : ''} ${i === 0 ? 'first-beat' : ''}`}
          />
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
          <input
            type="range"
            className="slider"
            min="30" max="300"
            value={baseBpm}
            onChange={(e) => setBaseBpm(parseInt(e.target.value))}
            disabled={isPlaying}
          />
        </div>
      </div>

      <div className="flex-row control-group">
        <div className="flex-1">
          <label className="control-label">Time Signature</label>
          <select
            value={beatsPerMeasure}
            onChange={(e) => setBeatsPerMeasure(parseInt(e.target.value))}
            disabled={isPlaying}
          >
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
          <input
            type="number"
            min="0" max="10"
            value={preRollMeasures}
            onChange={(e) => setPreRollMeasures(parseInt(e.target.value) || 0)}
            disabled={isPlaying}
          />
        </div>
      </div>

      <button
        className={`btn btn-primary ${isPlaying ? 'active' : ''}`}
        onClick={togglePlay}
      >
        {isPlaying ? <Square size={24} /> : <Play size={24} fill="currentColor" />}
        {isPlaying ? 'STOP' : 'START METRONOME'}
      </button>

      <div className="rules-container">
        <div className="rules-header">
          <label className="control-label" style={{ margin: 0 }}><Activity size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '8px' }} /> Programming</label>
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
                <input
                  type="number"
                  min="2"
                  value={rule.measure}
                  onChange={(e) => updateRule(idx, 'measure', e.target.value)}
                  style={{ marginTop: '0.2rem', padding: '0.5rem' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Change to (BPM)</span>
                <input
                  type="number"
                  min="30" max="300"
                  value={rule.newBpm}
                  onChange={(e) => updateRule(idx, 'newBpm', e.target.value)}
                  style={{ marginTop: '0.2rem', padding: '0.5rem' }}
                />
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
