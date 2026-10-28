/* Guitar Buddy - audio analysis engine (no dependencies).
   Works in the browser (window.GuitarAnalyzer) and in Node (module.exports) for testing. */
(function (root) {
  'use strict';

  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MIDI_LO = 40; // E2, lowest guitar note
  const MIDI_HI = 84; // C6

  const chordKey = (root, minor) => NOTES[root] + (minor ? 'm' : '');

  // ---- chord templates: index = (minor ? 12 : 0) + root ----
  const CHORDS = [];
  for (let m = 0; m < 2; m++) {
    for (let r = 0; r < 12; r++) {
      const tpl = new Float32Array(12);
      tpl[r] = 1;
      tpl[(r + (m ? 3 : 4)) % 12] = 1;
      tpl[(r + 7) % 12] = 1;
      const n = Math.sqrt(3);
      for (let i = 0; i < 12; i++) tpl[i] /= n;
      CHORDS.push({ root: r, minor: !!m, tpl });
    }
  }

  // ---- audio helpers ----
  function toMono(buffer) {
    const n = buffer.length, ch = buffer.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  function decimate(x, factor) {
    if (factor <= 1) return x;
    const n = Math.floor(x.length / factor);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const b = i * factor;
      for (let k = 0; k < factor; k++) s += x[b + k];
      out[i] = s / factor;
    }
    return out;
  }

  // ---- chord detection: chromagram (Goertzel) + Viterbi smoothing ----
  async function analyze(mono, sr, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const maxSeconds = opts.maxSeconds || 480;
    const N = 8192;
    const hopS = 0.5;
    const hop = Math.round(sr * hopS);
    const total = Math.min(mono.length, Math.floor(maxSeconds * sr));
    const T = Math.max(1, Math.ceil(total / hop));

    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

    const coeffs = [], pcs = [];
    for (let m = MIDI_LO; m <= MIDI_HI; m++) {
      const f = 440 * Math.pow(2, (m - 69) / 12);
      coeffs.push(2 * Math.cos((2 * Math.PI * f) / sr));
      pcs.push(m % 12);
    }

    const sims = new Array(T);
    const chromaFrames = new Array(T);
    const rms = new Float32Array(T);
    const buf = new Float32Array(N);

    for (let t = 0; t < T; t++) {
      const c = t * hop;
      const start = c - (N >> 1);
      for (let i = 0; i < N; i++) {
        const j = start + i;
        buf[i] = j >= 0 && j < total ? mono[j] * win[i] : 0;
      }
      const chroma = new Float32Array(12);
      for (let k = 0; k < coeffs.length; k++) {
        const co = coeffs[k];
        let s1 = 0, s2 = 0;
        for (let i = 0; i < N; i++) {
          const s0 = buf[i] + co * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const p = s1 * s1 + s2 * s2 - co * s1 * s2;
        chroma[pcs[k]] += Math.pow(Math.max(0, p), 0.3);
      }
      let norm = 0;
      for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
      norm = Math.sqrt(norm);
      const sim = new Float32Array(24);
      if (norm > 0) {
        for (let s = 0; s < 24; s++) {
          let d = 0;
          const tpl = CHORDS[s].tpl;
          for (let i = 0; i < 12; i++) d += (chroma[i] / norm) * tpl[i];
          sim[s] = d;
        }
      }
      sims[t] = sim;
      let mxc = 0;
      for (let i = 0; i < 12; i++) if (chroma[i] > mxc) mxc = chroma[i];
      const cf = new Float32Array(12);
      if (mxc > 0) for (let i = 0; i < 12; i++) cf[i] = chroma[i] / mxc;
      chromaFrames[t] = cf;

      const a = Math.max(0, c - (hop >> 1)), b = Math.min(total, c + (hop >> 1));
      let e = 0;
      for (let i = a; i < b; i++) e += mono[i] * mono[i];
      rms[t] = b > a ? Math.sqrt(e / (b - a)) : 0;

      if (t % 6 === 0) {
        onProgress(t / T);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    onProgress(1);

    // Viterbi: prefer staying on the same chord (switch penalty)
    const pen = 0.12;
    const bp = new Array(T);
    let dp = Float32Array.from(sims[0]);
    for (let t = 1; t < T; t++) {
      let bi = 0;
      for (let s = 1; s < 24; s++) if (dp[s] > dp[bi]) bi = s;
      const nd = new Float32Array(24), b = new Uint8Array(24);
      for (let s = 0; s < 24; s++) {
        const stay = dp[s], sw = dp[bi] - pen;
        if (stay >= sw) { nd[s] = stay + sims[t][s]; b[s] = s; }
        else { nd[s] = sw + sims[t][s]; b[s] = bi; }
      }
      dp = nd;
      bp[t] = b;
    }
    const path = new Array(T);
    let s = 0;
    for (let k = 1; k < 24; k++) if (dp[k] > dp[s]) s = k;
    path[T - 1] = s;
    for (let t = T - 1; t >= 1; t--) { s = bp[t][s]; path[t - 1] = s; }

    // silence / unclear frames -> no chord
    let maxRms = 0;
    for (let t = 0; t < T; t++) if (rms[t] > maxRms) maxRms = rms[t];
    const dur = mono.length / sr;
    const label = new Array(T);
    for (let t = 0; t < T; t++) {
      const silent = rms[t] < 0.06 * maxRms || rms[t] < 1e-4;
      label[t] = silent || sims[t][path[t]] < 0.5 ? -1 : path[t];
    }

    const segments = [];
    let t = 0;
    while (t < T) {
      if (label[t] < 0) { t++; continue; }
      let u = t;
      while (u + 1 < T && label[u + 1] === label[t]) u++;
      const st = Math.max(0, t * hopS - hopS / 2);
      const en = Math.min(dur, u * hopS + hopS / 2);
      if (en - st >= 0.2) {
        const ch = CHORDS[label[t]];
        segments.push({ start: st, end: en, root: ch.root, minor: ch.minor, name: chordKey(ch.root, ch.minor) });
      }
      t = u + 1;
    }
    const energy = new Float32Array(T);
    for (let q = 0; q < T; q++) energy[q] = maxRms > 0 ? rms[q] / maxRms : 0;
    return { segments, duration: dur, hopS, chroma: chromaFrames, energy };
  }

  // ---- match a 12-bin chroma vector to the closest major/minor chord ----
  function matchChord(chroma) {
    let n = 0;
    for (let i = 0; i < 12; i++) n += chroma[i] * chroma[i];
    n = Math.sqrt(n);
    if (!n) return null;
    let best = 0, bs = -1;
    for (let s = 0; s < 24; s++) {
      let d = 0;
      const tpl = CHORDS[s].tpl;
      for (let i = 0; i < 12; i++) d += (chroma[i] / n) * tpl[i];
      if (d > bs) { bs = d; best = s; }
    }
    const ch = CHORDS[best];
    return { root: ch.root, minor: ch.minor, name: chordKey(ch.root, ch.minor), sim: bs };
  }

  // ---- live spectrum (dB per FFT bin) -> chroma ----
  function chromaFromSpectrum(db, sr, fftSize) {
    const out = new Float32Array(12);
    const lo = Math.ceil((75 * fftSize) / sr), hi = Math.floor((1200 * fftSize) / sr);
    for (let k = lo; k <= hi; k++) {
      const d = db[k];
      if (!(d > -110)) continue;
      const midi = 69 + 12 * Math.log2((k * sr) / fftSize / 440);
      const m = Math.round(midi);
      if (Math.abs(midi - m) > 0.35) continue;
      out[((m % 12) + 12) % 12] += Math.pow(Math.pow(10, d / 20), 0.6);
    }
    return out;
  }

  // ---- key from chord usage (Krumhansl-Schmuckler profiles) ----
  const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function estimateKey(segments) {
    const w = new Float32Array(12);
    for (const s of segments) {
      const d = s.end - s.start;
      w[s.root] += d * 1.2;
      w[(s.root + (s.minor ? 3 : 4)) % 12] += d;
      w[(s.root + 7) % 12] += d * 0.9;
    }
    const corr = (a, b) => {
      const ma = a.reduce((x, y) => x + y, 0) / 12, mb = b.reduce((x, y) => x + y, 0) / 12;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
      return da && db ? num / Math.sqrt(da * db) : 0;
    };
    let best = { root: 0, minor: false, conf: -2 };
    for (let r = 0; r < 12; r++) {
      for (const minor of [false, true]) {
        const prof = minor ? KS_MIN : KS_MAJ;
        const rot = Array.from({ length: 12 }, (_, i) => prof[(i - r + 12) % 12]);
        const c = corr(Array.from(w), rot);
        if (c > best.conf) best = { root: r, minor, conf: c };
      }
    }
    return { root: best.root, minor: best.minor, conf: best.conf, name: NOTES[best.root] + (best.minor ? ' minor' : ' major') };
  }

  // ---- tempo: autocorrelation of the onset envelope ----
  function estimateBpm(mono, sr) {
    const blk = Math.max(1, Math.round(sr * 0.023));
    const dt = blk / sr;
    const nb = Math.min(Math.floor(mono.length / blk), Math.floor(120 / dt));
    if (nb < 100) return null;
    const env = new Float32Array(nb);
    for (let i = 0; i < nb; i++) {
      let e = 0;
      for (let k = 0; k < blk; k++) { const v = mono[i * blk + k]; e += v * v; }
      env[i] = Math.sqrt(e / blk);
    }
    const onset = new Float32Array(nb);
    for (let i = 1; i < nb; i++) onset[i] = Math.max(0, env[i] - env[i - 1]);
    const lagMin = Math.round(60 / 180 / dt), lagMax = Math.round(60 / 70 / dt);
    const acf = lag => {
      let s = 0;
      for (let i = 0; i + lag < nb; i++) s += onset[i] * onset[i + lag];
      return s / (nb - lag);
    };
    let best = 0, bestLag = 0;
    for (let L = lagMin; L <= lagMax; L++) {
      const sc = acf(L) + 0.5 * acf(2 * L) + 0.25 * acf(4 * L);
      if (sc > best) { best = sc; bestLag = L; }
    }
    return bestLag ? Math.round(60 / (bestLag * dt)) : null;
  }

  // ---- chord shapes (frets low E -> high e, -1 = don't play) ----
  const OPEN = {
    C: { frets: [-1, 3, 2, 0, 1, 0] },
    D: { frets: [-1, -1, 0, 2, 3, 2] },
    E: { frets: [0, 2, 2, 1, 0, 0] },
    G: { frets: [3, 2, 0, 0, 0, 3] },
    A: { frets: [-1, 0, 2, 2, 2, 0] },
    Am: { frets: [-1, 0, 2, 2, 1, 0] },
    Dm: { frets: [-1, -1, 0, 2, 3, 1] },
    Em: { frets: [0, 2, 2, 0, 0, 0] },
    F: { frets: [-1, -1, 3, 2, 1, 1], barre: { fret: 1, from: 4, to: 5 } }
  };

  function shapeFor(root, minor) {
    const name = chordKey(root, minor);
    if (OPEN[name]) return { name, frets: OPEN[name].frets.slice(), barre: OPEN[name].barre || null };
    const eFret = (root - 4 + 12) % 12; // root on the low E string
    const aFret = (root - 9 + 12) % 12; // root on the A string
    if (eFret <= aFret) {
      const f = eFret;
      return {
        name,
        frets: minor ? [f, f + 2, f + 2, f, f, f] : [f, f + 2, f + 2, f + 1, f, f],
        barre: { fret: f, from: 0, to: 5 }
      };
    }
    const f = aFret;
    return {
      name,
      frets: minor ? [-1, f, f + 2, f + 2, f + 1, f] : [-1, f, f + 2, f + 2, f + 2, f],
      barre: { fret: f, from: 1, to: 5 }
    };
  }

  // ---- capo: pick the fret that turns the song into the easiest open shapes ----
  const OPEN_WEIGHT = { C: 1, D: 1, E: 1, G: 1, A: 1, Am: 1, Dm: 1, Em: 1, F: 0.6 };
  function suggestCapo(segments) {
    const total = segments.reduce((a, s) => a + (s.end - s.start), 0) || 1;
    let best = { capo: 0, score: -1 };
    for (let capo = 0; capo <= 7; capo++) {
      let score = 0;
      for (const s of segments) {
        const k = chordKey((s.root - capo + 12) % 12, s.minor);
        score += (s.end - s.start) * (OPEN_WEIGHT[k] || 0);
      }
      if (best.score < 0 || score > best.score * 1.05 + 1e-9) best = { capo, score };
    }
    return { capo: best.capo, coverage: best.score / total };
  }

  const api = { NOTES, chordKey, toMono, decimate, analyze, estimateBpm, shapeFor, suggestCapo,
    matchChord, chromaFromSpectrum, estimateKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuitarAnalyzer = api;
})(typeof window !== 'undefined' ? window : globalThis);
