(function () {
  'use strict';
  const GA = window.GuitarAnalyzer;
  const AC = window.AudioContext || window.webkitAudioContext;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmtTime = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const setStatus = (el, msg, err) => { el.textContent = msg || ''; el.classList.toggle('err', !!err); };
  const micOpts = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ================= sound out (plucked-string synth) =================
  const OPEN_MIDI = [40, 45, 50, 55, 59, 64];
  const midiFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  let outCtx = null;
  const pluckCache = new Map();
  function getOut() {
    if (!outCtx) outCtx = new AC();
    if (outCtx.state === 'suspended') outCtx.resume();
    return outCtx;
  }
  function pluckBuffer(ctx, freq) {
    const key = Math.round(freq * 10) + '|' + ctx.sampleRate;
    if (pluckCache.has(key)) return pluckCache.get(key);
    const sr = ctx.sampleRate, len = Math.floor(sr * 1.8);
    const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    const N = Math.max(2, Math.round(sr / freq)), ring = new Float32Array(N);
    for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    let p = 0;
    for (let i = 0; i < len; i++) {
      d[i] = ring[p];
      const nx = (p + 1) % N;
      ring[p] = 0.4985 * (ring[p] + ring[nx]);
      p = nx;
    }
    pluckCache.set(key, buf);
    return buf;
  }
  function playFreq(freq, delay, vol) {
    const ctx = getOut();
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = pluckBuffer(ctx, freq);
    g.gain.value = vol == null ? 0.5 : vol;
    src.connect(g); g.connect(ctx.destination);
    src.start(ctx.currentTime + (delay || 0));
  }
  function playChord(shape) {
    let i = 0;
    shape.frets.forEach((f, s) => { if (f < 0) return; playFreq(midiFreq(OPEN_MIDI[s] + f), i * 0.05, 0.32); i++; });
  }
  let audioReady = false;
  document.addEventListener('pointerdown', () => { audioReady = true; }, { once: true });

  // ================= chord diagram =================
  function chordSVG(shape) {
    const frets = shape.frets, barre = shape.barre;
    const pos = frets.filter(f => f > 0);
    const maxF = pos.length ? Math.max(...pos) : 0, minF = pos.length ? Math.min(...pos) : 1;
    const base = maxF > 4 ? minF : 1;
    const X0 = 26, DX = 12, Y0 = 30, DY = 17, x = i => X0 + i * DX;
    let n = 0;
    let s = `<svg viewBox="0 0 110 ${Y0 + 5 * DY + 8}" class="chord-svg" role="img" aria-label="${shape.name} chord diagram">`;
    s += `<rect class="fb" x="${X0}" y="${Y0}" width="${5 * DX}" height="${5 * DY}" rx="3"/>`;
    if (base === 1) s += `<rect class="nut" x="${X0 - 1}" y="${Y0 - 3}" width="${5 * DX + 2}" height="4" rx="1.5"/>`;
    else s += `<text class="fretnum" x="${X0 - 8}" y="${Y0 + DY / 2 + 3}" text-anchor="end">${base}fr</text>`;
    for (let r = 0; r <= 5; r++) s += `<line x1="${X0}" y1="${Y0 + r * DY}" x2="${x(5)}" y2="${Y0 + r * DY}"/>`;
    for (let i = 0; i < 6; i++) s += `<line x1="${x(i)}" y1="${Y0}" x2="${x(i)}" y2="${Y0 + 5 * DY}"/>`;
    if (barre) {
      const cy = Y0 + (barre.fret - base) * DY + DY / 2;
      s += `<rect class="dot" style="--i:${n++}" x="${x(barre.from) - 5.5}" y="${cy - 5.5}" width="${x(barre.to) - x(barre.from) + 11}" height="11" rx="5.5"/>`;
    }
    frets.forEach((f, i) => {
      if (f === -1) s += `<text class="mute" x="${x(i)}" y="${Y0 - 8}" text-anchor="middle">×</text>`;
      else if (f === 0) s += `<circle class="open" cx="${x(i)}" cy="${Y0 - 12}" r="3.5"/>`;
      else s += `<circle class="dot" style="--i:${n++}" cx="${x(i)}" cy="${Y0 + (f - base) * DY + DY / 2}" r="5.5"/>`;
    });
    return s + '</svg>';
  }

  // ================= tabs =================
  const player = $('#player');
  let camStream = null, recorder = null;
  function movePill() {
    const a = $('.tab.active'), p = $('#pill');
    if (a) { p.style.left = a.offsetLeft + 'px'; p.style.width = a.offsetWidth + 'px'; }
  }
  function showTab(name) {
    $$('.tab').forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    $$('main > section').forEach(s => { s.hidden = s.id !== 'tab-' + name; });
    movePill();
    if (name !== 'tuner') stopTuner();
    if (name !== 'camera' && !(recorder && recorder.state === 'recording')) stopCamera();
    if (name !== 'analyze') { player.pause(); stopMetro(); }
    if (name === 'analyze') requestAnimationFrame(drawTimelines);
    if (name === 'camera') requestAnimationFrame(drawGuide);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  window.addEventListener('load', movePill);
  window.addEventListener('resize', () => { movePill(); drawGuide(); drawTimelines(); });
  movePill();

  // ================= hero strings (interactive, animated) =================
  (function heroStrings() {
    const svg = $('#hero-strings'), NS = 'http://www.w3.org/2000/svg';
    const paths = [], amps = new Float32Array(6);
    const cols = ['#ffd08a', '#ffc46b', '#ffb347', '#ff9a6e', '#ff7a8a', '#ff5e8a'];
    for (let i = 0; i < 6; i++) {
      const y = 6 + i * 9.2;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('stroke', cols[i]); p.setAttribute('stroke-width', (3.2 - i * 0.4).toFixed(1));
      svg.appendChild(p); paths.push(p);
      const h = document.createElementNS(NS, 'path');
      h.setAttribute('class', 'hit'); h.setAttribute('d', `M0 ${y} L300 ${y}`);
      const pluck = loud => {
        amps[i] = 7;
        if (loud && audioReady) playFreq(midiFreq(OPEN_MIDI[5 - i]), 0, 0.45);
      };
      h.addEventListener('pointerenter', () => pluck(true));
      h.addEventListener('pointerdown', () => { audioReady = true; pluck(true); });
      svg.appendChild(h);
    }
    if (reduceMotion) { paths.forEach((p, i) => p.setAttribute('d', `M0 ${6 + i * 9.2} L300 ${6 + i * 9.2}`)); return; }
    setInterval(() => { amps[Math.floor(Math.random() * 6)] = 6; }, 2400);
    (function loop(t) {
      for (let i = 0; i < 6; i++) {
        const y = 6 + i * 9.2;
        amps[i] = amps[i] > 0.04 ? amps[i] * 0.975 : 0;
        const off = amps[i] * Math.sin((t / 1000) * (30 - i * 2.5) * Math.PI);
        paths[i].setAttribute('d', `M0 ${y} Q150 ${(y + off * 2).toFixed(2)} 300 ${y}`);
      }
      requestAnimationFrame(loop);
    })(0);
  })();

  // ================= learn =================
  const LEARN = [
    [4, true, '2 (A fret 2), 3 (D fret 2). Strum all 6.'],
    [9, true, '1 (B fret 1), 2 (D fret 2), 3 (G fret 2). Skip thickest.'],
    [0, false, '1 (B fret 1), 2 (D fret 2), 3 (A fret 3). Skip thickest.'],
    [7, false, '2 (A fret 2), 3 (low E fret 3), 4 (high e fret 3).'],
    [2, false, '1 (G fret 2), 2 (e fret 2), 3 (B fret 3). Top 4 strings.'],
    [4, false, '1 (G fret 1), 2 (A fret 2), 3 (D fret 2). Strum all 6.'],
    [9, false, '1, 2, 3 side by side on fret 2 of D, G, B.'],
    [2, true, '1 (e fret 1), 2 (G fret 2), 3 (B fret 3). Top 4 strings.']
  ];
  function chordCard(sh, tip) {
    return `<figure class="chord-card" data-shape='${JSON.stringify(sh)}'><span class="play">▶ hear</span>${chordSVG(sh)}<figcaption><b>${sh.name}</b>${tip ? `<span>${tip}</span>` : ''}</figcaption></figure>`;
  }
  function wireCards(root) {
    root.addEventListener('click', e => {
      const c = e.target.closest('.chord-card'); if (!c) return;
      playChord(JSON.parse(c.dataset.shape));
      c.classList.remove('ring'); void c.offsetWidth; c.classList.add('ring');
    });
  }
  $('#learn-chords').innerHTML = LEARN.map(([r, m, tip]) => chordCard(GA.shapeFor(r, m), tip)).join('');
  wireCards($('#learn-chords'));
  wireCards($('#learn-shapes'));

  // practice routine
  const ROUTINE = [['Tune up (Tuner tab)', 120], ['Warm up: stretch fingers, pluck open strings', 120], ['Chord shapes: Em and Am', 180], ['Switch Em ↔ Am slowly', 180], ['Strum down 1-2-3-4', 120]];
  const rt = { timer: null, i: 0, left: 0 };
  const rtTotal = ROUTINE.reduce((a, r) => a + r[1], 0);
  function renderRoutine() {
    $('#routine').innerHTML = ROUTINE.map((r, i) =>
      `<li class="${rt.timer ? (i < rt.i ? 'done' : i === rt.i ? 'now' : '') : ''}"><span>${r[0]}</span><b>${fmtTime(r[1])}</b></li>`).join('');
  }
  function stopRoutine(done) {
    clearInterval(rt.timer); rt.timer = null;
    $('#routine-btn').textContent = '▶ Start routine';
    if (done) { $('#routine-time').textContent = '🎉 Done, great job!'; playChord(GA.shapeFor(7, false)); }
    else { $('#routine-time').textContent = ''; $('#routine-bar').style.width = '0'; }
    renderRoutine();
  }
  $('#routine-btn').addEventListener('click', () => {
    if (rt.timer) { stopRoutine(false); return; }
    rt.i = 0; rt.left = ROUTINE[0][1];
    let elapsed = 0;
    $('#routine-btn').textContent = '⏹ Stop';
    const tick = () => {
      $('#routine-time').textContent = `${ROUTINE[rt.i][0]} · ${fmtTime(rt.left)} left`;
      $('#routine-bar').style.width = (elapsed / rtTotal * 100) + '%';
    };
    renderRoutine(); tick();
    rt.timer = setInterval(() => {
      rt.left--; elapsed++;
      if (rt.left <= 0) {
        rt.i++;
        if (rt.i >= ROUTINE.length) { $('#routine-bar').style.width = '100%'; stopRoutine(true); return; }
        rt.left = ROUTINE[rt.i][1]; renderRoutine();
        playFreq(880, 0, 0.3);
      }
      tick();
    }, 1000);
  });
  renderRoutine();

  // ================= canvas helpers =================
  function prep(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv._k = ''; }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, w, h, dpr };
  }
  function drawSpectrum(cv, db, sr, fftSize) {
    const p = prep(cv); if (!p) return;
    const { c, w, h } = p, bars = 64;
    if (!cv._v || cv._v.length !== bars) cv._v = new Float32Array(bars);
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, '#3ee0c2'); g.addColorStop(0.5, '#ffb347'); g.addColorStop(1, '#ff5e8a');
    c.fillStyle = g;
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      let v = 0;
      if (db) {
        const f0 = 70 * Math.pow(5000 / 70, i / bars), f1 = 70 * Math.pow(5000 / 70, (i + 1) / bars);
        const k0 = Math.floor(f0 * fftSize / sr), k1 = Math.max(k0 + 1, Math.ceil(f1 * fftSize / sr));
        let m = -200;
        for (let k = k0; k < k1; k++) if (db[k] > m) m = db[k];
        v = clamp((m + 100) / 62, 0, 1);
      }
      cv._v[i] = Math.max(v, cv._v[i] * 0.86);
      const bh = Math.max(2, cv._v[i] * (h - 6));
      const x = i * bw + 1;
      c.beginPath();
      if (c.roundRect) c.roundRect(x, h - bh, bw - 2, bh, 3); else c.rect(x, h - bh, bw - 2, bh);
      c.fill();
    }
  }

  // ================= camera =================
  const camVideo = $('#cam-video'), camWrap = $('#camwrap'), overlay = $('#cam-overlay'), camStatus = $('#cam-status');
  let recChunks = [], recBlob = null, recTimer = null, recStart = 0, recUrl = null;

  function drawGuide() {
    const p = prep(overlay); if (!p) return;
    const { c, w, h } = p;
    c.clearRect(0, 0, w, h);
    if (!$('#cam-guide').checked || !camStream) return;
    c.lineWidth = 2.5; c.strokeStyle = 'rgba(255,179,71,.9)'; c.fillStyle = 'rgba(255,230,190,.95)';
    c.font = '600 13px Inter, system-ui, sans-serif';
    c.setLineDash([9, 7]);
    c.beginPath(); c.moveTo(w * 0.04, h * 0.8); c.lineTo(w * 0.8, h * 0.26); c.stroke();
    c.setLineDash([]);
    c.fillText('Line up the guitar neck here', w * 0.06, h * 0.72);
    const box = (x, y, bw, bh, label) => {
      c.strokeStyle = 'rgba(62,224,194,.9)';
      c.beginPath(); if (c.roundRect) c.roundRect(x, y, bw, bh, 12); else c.rect(x, y, bw, bh); c.stroke();
      c.fillText(label, x + 10, y + 20);
    };
    box(w * 0.56, h * 0.1, w * 0.38, h * 0.32, 'Fretting hand');
    box(w * 0.16, h * 0.62, w * 0.34, h * 0.3, 'Strumming hand');
  }
  $('#cam-guide').addEventListener('change', drawGuide);
  $('#cam-mirror').addEventListener('change', e => camVideo.classList.toggle('mirror', e.target.checked));

  async function startCamera(deviceId) {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(camStatus, 'This browser cannot access the camera here. Use Chrome or Edge, from the folder or localhost.', true); return;
    }
    setStatus(camStatus, 'Waiting for permission…');
    const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' };
    let note = '';
    try { camStream = await navigator.mediaDevices.getUserMedia({ video, audio: micOpts }); }
    catch (e1) {
      try { camStream = await navigator.mediaDevices.getUserMedia({ video }); note = ' (No microphone, so no live listening or sound in recordings.)'; }
      catch (e2) {
        const msgs = {
          NotAllowedError: 'Camera is blocked. Click the camera icon in the address bar, choose Allow, then press Start again.',
          NotFoundError: 'No camera found on this computer.',
          NotReadableError: 'Another app is using the camera. Close it and try again.'
        };
        setStatus(camStatus, msgs[e2.name] || ('Could not start the camera: ' + e2.message), true); return;
      }
    }
    camVideo.srcObject = camStream;
    await camVideo.play().catch(() => {});
    camWrap.classList.add('on');
    $('#cam-placeholder').hidden = true;
    $('#cam-start').disabled = true; $('#cam-stop').disabled = false;
    $('#cam-snap').disabled = false; $('#cam-rec').disabled = !window.MediaRecorder;
    setStatus(camStatus, 'Camera is on.' + note);
    drawGuide();
    startLive(camStream);
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const sel = $('#cam-device');
      if (devs.length > 1) {
        const cur = camStream.getVideoTracks()[0].getSettings().deviceId;
        sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === cur ? 'selected' : ''}>${d.label || 'Camera ' + (i + 1)}</option>`).join('');
        sel.hidden = false;
      }
    } catch (e) { /* optional */ }
  }
  function stopCamera() {
    if (recorder && recorder.state === 'recording') recorder.stop();
    stopLive();
    if (camStream) camStream.getTracks().forEach(t => t.stop());
    camStream = null; camVideo.srcObject = null;
    camWrap.classList.remove('on');
    $('#cam-placeholder').hidden = false;
    $('#cam-start').disabled = false; $('#cam-stop').disabled = true;
    $('#cam-snap').disabled = true; $('#cam-rec').disabled = true;
    drawGuide();
  }
  $('#cam-start').addEventListener('click', () => startCamera());
  $('#cam-stop').addEventListener('click', () => { stopCamera(); setStatus(camStatus, 'Camera is off.'); });
  $('#cam-device').addEventListener('change', e => startCamera(e.target.value));

  $('#cam-snap').addEventListener('click', () => {
    const c = document.createElement('canvas');
    c.width = camVideo.videoWidth; c.height = camVideo.videoHeight;
    const g = c.getContext('2d');
    if ($('#cam-mirror').checked) { g.translate(c.width, 0); g.scale(-1, 1); }
    g.drawImage(camVideo, 0, 0);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png'); a.download = 'guitar-photo.png'; a.click();
  });

  $('#cam-rec').addEventListener('click', () => {
    const btn = $('#cam-rec');
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    if (!camStream) return;
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
    try { recorder = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined); }
    catch (e) { setStatus(camStatus, 'Recording is not supported here: ' + e.message, true); return; }
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      clearInterval(recTimer); $('#cam-timer').textContent = '';
      btn.textContent = '⏺ Record'; btn.classList.remove('on');
      recBlob = new Blob(recChunks, { type: recorder.mimeType || 'video/webm' });
      if (recUrl) URL.revokeObjectURL(recUrl);
      recUrl = URL.createObjectURL(recBlob);
      $('#rec-preview').src = recUrl;
      $('#rec-save').href = recUrl;
      $('#rec-save').download = recBlob.type.includes('mp4') ? 'my-guitar.mp4' : 'my-guitar.webm';
      $('#rec-box').hidden = false;
      $('#use-recording').disabled = false;
      const hasAudio = camStream && camStream.getAudioTracks().length > 0;
      setStatus(camStatus, hasAudio ? 'Recording saved below.' : 'Recording saved, but it has no sound, so it cannot be analyzed.', !hasAudio);
    };
    recorder.start();
    recStart = Date.now();
    btn.textContent = '⏹ Stop'; btn.classList.add('on');
    recTimer = setInterval(() => { $('#cam-timer').textContent = '● ' + fmtTime((Date.now() - recStart) / 1000); }, 250);
    setStatus(camStatus, 'Recording… play your guitar!');
  });
  $('#rec-analyze').addEventListener('click', () => { if (recBlob) { showTab('analyze'); loadMedia(recBlob, 'my recording'); } });

  // ---- live listening + chord checker ----
  const TARGETS = [[4, true], [9, true], [0, false], [7, false], [2, false], [4, false], [9, false], [2, true]];
  const live = { ctx: null, an: null, raf: 0, chroma: new Float32Array(12), f: null, t: null, last: null, lastAt: 0, shown: '', target: null, matchSince: 0, credited: false, streak: 0 };
  $('#target-pills').innerHTML = TARGETS.map(([r, m], i) => `<button class="pillb" data-i="${i}">${GA.chordKey(r, m)}</button>`).join('');
  $('#target-pills').addEventListener('click', e => {
    const b = e.target.closest('.pillb'); if (!b) return;
    $$('#target-pills .pillb').forEach(x => x.classList.toggle('sel', x === b));
    const [r, m] = TARGETS[+b.dataset.i];
    live.target = GA.shapeFor(r, m); live.credited = false; live.matchSince = 0;
    renderTarget();
    playChord(live.target);
  });
  function renderTarget(msg, ok) {
    const t = $('#target');
    t.classList.toggle('ok', !!ok);
    if (!live.target) { t.innerHTML = '<div class="muted small">Choose a chord above</div>'; return; }
    t.innerHTML = `${chordSVG(live.target)}<div class="bigchord">${live.target.name}</div><div class="${ok ? '' : 'muted'} small" style="${ok ? 'color:var(--good);font-weight:700' : ''}">${msg || (camStream ? 'Strum it now…' : 'Start the camera to be checked live')}</div>`;
  }
  function startLive(stream) {
    stopLive();
    const at = stream.getAudioTracks();
    if (!at.length) { $('#live-note').textContent = 'No microphone, so live listening is off.'; return; }
    live.ctx = new AC();
    const src = live.ctx.createMediaStreamSource(new MediaStream(at));
    live.an = live.ctx.createAnalyser();
    live.an.fftSize = 16384; live.an.smoothingTimeConstant = 0.55;
    live.f = new Float32Array(live.an.frequencyBinCount);
    live.t = new Float32Array(live.an.fftSize);
    src.connect(live.an);
    live.chroma.fill(0);
    $('#live-note').textContent = 'Listening… strum a chord';
    if (live.target) renderTarget();
    liveLoop();
  }
  function stopLive() {
    cancelAnimationFrame(live.raf);
    if (live.ctx) live.ctx.close().catch(() => {});
    live.ctx = live.an = null; live.shown = '';
    $('#live-level').style.width = '0';
    $('#live-chord').textContent = '–'; $('#live-chord').classList.add('idle');
    $('#live-diagram').innerHTML = '';
    drawSpectrum($('#live-spec'), null, 1, 1);
  }
  function liveLoop() {
    live.raf = requestAnimationFrame(liveLoop);
    const an = live.an, sr = live.ctx.sampleRate;
    an.getFloatFrequencyData(live.f); an.getFloatTimeDomainData(live.t);
    const n = 4096, off = live.t.length - n;
    let e = 0;
    for (let i = 0; i < n; i++) { const v = live.t[off + i]; e += v * v; }
    const rms = Math.sqrt(e / n);
    $('#live-level').style.width = clamp((20 * Math.log10(rms + 1e-6) + 60) / 60, 0, 1) * 100 + '%';
    drawSpectrum($('#live-spec'), live.f, sr, an.fftSize);

    const inst = GA.chromaFromSpectrum(live.f, sr, an.fftSize);
    let mx = 0; for (let i = 0; i < 12; i++) if (inst[i] > mx) mx = inst[i];
    for (let i = 0; i < 12; i++) live.chroma[i] = live.chroma[i] * 0.7 + (mx ? inst[i] / mx : 0) * 0.3;

    const now = performance.now();
    let chord = null;
    if (rms > 0.012) { const m = GA.matchChord(live.chroma); if (m && m.sim > 0.78) chord = m; }
    if (chord) { live.last = chord; live.lastAt = now; }
    const shown = live.last && now - live.lastAt < 500 ? live.last : null;
    const key = shown ? shown.name : '';
    if (key !== live.shown) {
      live.shown = key;
      const ce = $('#live-chord');
      ce.textContent = key || '–'; ce.classList.toggle('idle', !key);
      $('#live-diagram').innerHTML = key ? chordSVG(GA.shapeFor(shown.root, shown.minor)) : '';
      $('#live-note').textContent = key ? 'Chord heard' : (rms > 0.012 ? 'Hmm, not a clear chord' : 'Listening… strum a chord');
    }
    // chord checker
    if (live.target) {
      const hit = shown && shown.name === live.target.name;
      if (hit) {
        if (!live.matchSince) live.matchSince = now;
        if (now - live.matchSince > 300 && !live.credited) {
          live.credited = true; live.streak++;
          $('#streak').textContent = live.streak;
          renderTarget('✓ Yes! That is ' + live.target.name, true);
        }
      } else if (live.matchSince || live.credited) {
        if (!shown || shown.name !== live.target.name) {
          live.matchSince = 0;
          if (live.credited) { live.credited = false; renderTarget(shown ? `I hear ${shown.name}. Try ${live.target.name} again` : 'Strum it now…'); }
        }
      }
    }
  }

  // ================= tuner =================
  const STRINGS = [
    { n: 'E', midi: 40, f: 82.41, l: '6th' }, { n: 'A', midi: 45, f: 110.0, l: '5th' }, { n: 'D', midi: 50, f: 146.83, l: '4th' },
    { n: 'G', midi: 55, f: 196.0, l: '3rd' }, { n: 'B', midi: 59, f: 246.94, l: '2nd' }, { n: 'e', midi: 64, f: 329.63, l: '1st' }
  ];
  $('#tuner-strings').innerHTML = STRINGS.map((s, i) => `<button data-i="${i}"><b>${s.n}</b><small>${s.l} · ${s.f.toFixed(0)} Hz</small></button>`).join('');
  $('#tuner-strings').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    playFreq(STRINGS[b.dataset.i].f, 0, 0.7);
    b.classList.remove('vib'); void b.offsetWidth; b.classList.add('vib');
  });
  // gauge drawing
  (function buildGauge() {
    const pt = (deg, r) => [150 + r * Math.sin(deg * Math.PI / 180), 150 - r * Math.cos(deg * Math.PI / 180)];
    const a0 = pt(-8 / 50 * 85, 120), a1 = pt(8 / 50 * 85, 120);
    $('#gzone').setAttribute('d', `M ${a0[0]} ${a0[1]} A 120 120 0 0 1 ${a1[0]} ${a1[1]}`);
    let t = '';
    for (let c = -50; c <= 50; c += 10) {
      const d = c / 50 * 85, big = c % 50 === 0 || c === 0;
      const p = pt(d, big ? 96 : 102), q = pt(d, 110);
      t += `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="rgba(255,255,255,${c === 0 ? .8 : .3})" stroke-width="${c === 0 ? 3 : 1.5}"/>`;
    }
    $('#ticks').innerHTML = t;
  })();

  function detectPitch(buf, sr) {
    const n = buf.length, half = n >> 1;
    let e = 0;
    for (let i = 0; i < n; i++) e += buf[i] * buf[i];
    if (Math.sqrt(e / n) < 0.01) return -1;
    const minLag = Math.floor(sr / 1000), maxLag = Math.min(half - 1, Math.ceil(sr / 70));
    const d = new Float32Array(maxLag + 2);
    for (let tau = 1; tau <= maxLag; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + tau]; sum += x * x; }
      d[tau] = sum;
    }
    const cm = new Float32Array(maxLag + 2);
    let run = 0; cm[0] = 1;
    for (let tau = 1; tau <= maxLag; tau++) { run += d[tau]; cm[tau] = run ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = Math.max(2, minLag); t <= maxLag; t++) {
      if (cm[t] < 0.15) { while (t + 1 <= maxLag && cm[t + 1] < cm[t]) t++; tau = t; break; }
    }
    if (tau < 0) return -1;
    let t0 = tau;
    if (tau > 1 && tau < maxLag) {
      const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a + c - 2 * b;
      if (den) t0 = tau + (a - c) / (2 * den);
    }
    return sr / t0;
  }

  const tuner = { ctx: null, stream: null, an: null, timer: null, buf: null, freq: 0, lastGood: 0 };
  async function startTuner() {
    stopTuner();
    const st = $('#tuner-status');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus(st, 'Microphone not available in this browser.', true); return; }
    try { tuner.stream = await navigator.mediaDevices.getUserMedia({ audio: micOpts }); }
    catch (e) { setStatus(st, e.name === 'NotAllowedError' ? 'Microphone is blocked. Click the lock icon in the address bar and Allow.' : 'Could not open microphone: ' + e.message, true); return; }
    tuner.ctx = new AC();
    const src = tuner.ctx.createMediaStreamSource(tuner.stream);
    tuner.an = tuner.ctx.createAnalyser(); tuner.an.fftSize = 4096;
    tuner.buf = new Float32Array(tuner.an.fftSize);
    src.connect(tuner.an);
    $('#tuner-start').disabled = true; $('#tuner-stop').disabled = false;
    setStatus(st, 'Listening… pluck one string.');
    tuner.freq = 0;
    tuner.timer = setInterval(tunerTick, 70);
  }
  function stopTuner() {
    clearInterval(tuner.timer); tuner.timer = null;
    if (tuner.stream) tuner.stream.getTracks().forEach(t => t.stop());
    if (tuner.ctx) tuner.ctx.close().catch(() => {});
    tuner.stream = tuner.ctx = null;
    $('#tuner-start').disabled = false; $('#tuner-stop').disabled = true;
    $$('#tuner-strings button').forEach(b => b.classList.remove('hit'));
    $('#needle').style.transform = 'rotate(0deg)';
    $('#gauge').classList.remove('ok');
  }
  function tunerTick() {
    tuner.an.getFloatTimeDomainData(tuner.buf);
    let f = detectPitch(tuner.buf, tuner.ctx.sampleRate);
    const now = Date.now();
    if (f > 0) {
      tuner.freq = tuner.freq && Math.abs(Math.log2(f / tuner.freq)) < 0.08 ? tuner.freq * 0.6 + f * 0.4 : f;
      tuner.lastGood = now;
    } else if (now - tuner.lastGood > 800) tuner.freq = 0;
    const noteEl = $('#tuner-note'), msg = $('#tuner-msg'), needle = $('#needle'), gauge = $('#gauge');
    if (!tuner.freq) {
      noteEl.textContent = '–'; $('#tuner-hz').textContent = 'Listening…'; msg.textContent = '';
      needle.style.transform = 'rotate(0deg)'; gauge.classList.remove('ok');
      $$('#tuner-strings button').forEach(b => b.classList.remove('hit'));
      return;
    }
    f = tuner.freq;
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    noteEl.textContent = GA.NOTES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
    $('#tuner-hz').textContent = f.toFixed(1) + ' Hz';
    let bi = 0, bd = Infinity;
    STRINGS.forEach((s, i) => { const dd = Math.abs(Math.log2(f / s.f)); if (dd < bd) { bd = dd; bi = i; } });
    const cents = 1200 * Math.log2(f / STRINGS[bi].f), ok = Math.abs(cents) < 8;
    $$('#tuner-strings button').forEach((b, i) => b.classList.toggle('hit', i === bi && ok));
    needle.style.transform = `rotate(${clamp(cents, -50, 50) / 50 * 85}deg)`;
    gauge.classList.toggle('ok', ok);
    const nm = `${STRINGS[bi].n} string (${STRINGS[bi].l})`;
    msg.style.color = ok ? 'var(--good)' : 'var(--text)';
    msg.textContent = ok ? `✅ ${nm} is in tune!` : cents < 0 ? `${nm}: too low → tighten the peg a little` : `${nm}: too high → loosen the peg a little`;
  }
  $('#tuner-start').addEventListener('click', startTuner);
  $('#tuner-stop').addEventListener('click', stopTuner);

  // ================= analyze =================
  const st = { url: null, res: null, segs: [], capo: 0, useCapo: false, bpm: null, dur: 0, peaks: null, key: '', idx: -1, token: 0, keyInfo: null };
  const anStatus = $('#an-status'), anProg = $('#an-progress');
  const capoEff = () => (st.useCapo ? st.capo : 0);
  const shapeOf = seg => GA.shapeFor((seg.root - capoEff() + 12) % 12, seg.minor);

  async function loadMedia(blob, label) {
    $('#results').hidden = true;
    st.segs = []; st.key = ''; st.idx = -1; st.res = null;
    player.pause(); stopMetro();
    setStatus(anStatus, 'Reading file…');
    anProg.hidden = false; anProg.value = 0;
    if (st.url) URL.revokeObjectURL(st.url);
    st.url = URL.createObjectURL(blob);
    player.src = st.url;
    player.classList.toggle('audio-only', (blob.type || '').startsWith('audio'));
    const fail = m => { setStatus(anStatus, m, true); anProg.hidden = true; };
    let arr;
    try { arr = await blob.arrayBuffer(); } catch (e) { return fail('Could not read that file.'); }
    let ctx;
    try { ctx = new AC({ sampleRate: 11025 }); } catch (e) { ctx = new AC(); }
    setStatus(anStatus, 'Decoding sound…');
    let buf;
    try { buf = await ctx.decodeAudioData(arr); }
    catch (e) { ctx.close(); return fail('Could not read sound from this file. Try an mp3, wav, m4a or mp4 file.'); }
    ctx.close();
    let mono = GA.toMono(buf);
    const factor = Math.max(1, Math.round(buf.sampleRate / 11025));
    const sr = buf.sampleRate / factor;
    mono = GA.decimate(mono, factor);
    if (mono.length / sr < 3) return fail('That file is too short to analyze (need at least 3 seconds).');

    const res = await GA.analyze(mono, sr, {
      onProgress: p => { anProg.value = p; setStatus(anStatus, `Listening for notes and chords… ${Math.round(p * 100)}%  (${label})`); }
    });
    setStatus(anStatus, 'Estimating tempo and key…');
    await new Promise(r => setTimeout(r, 30));
    st.res = res; st.segs = res.segments; st.dur = res.duration;
    st.bpm = GA.estimateBpm(mono, sr);
    st.keyInfo = st.segs.length ? GA.estimateKey(st.segs) : null;
    const capo = GA.suggestCapo(st.segs);
    st.capo = capo.capo; st.useCapo = capo.capo > 0;
    const B = 1200, per = Math.max(1, Math.floor(mono.length / B));
    st.peaks = new Float32Array(B);
    let mx = 1e-9;
    for (let i = 0; i < B; i++) {
      let m = 0;
      for (let k = 0; k < per; k++) { const v = Math.abs(mono[i * per + k] || 0); if (v > m) m = v; }
      st.peaks[i] = m; if (m > mx) mx = m;
    }
    for (let i = 0; i < B; i++) st.peaks[i] /= mx;
    st.token++;

    anProg.hidden = true;
    if (!st.segs.length) { setStatus(anStatus, 'I could not find clear chords in this file. Try a recording with a clearer guitar and less background noise.', true); return; }
    setStatus(anStatus, `Done! Found ${st.segs.length} chord changes in ${fmtTime(st.dur)}. Scroll down and press play ▶`);
    $('#results').hidden = false;
    $('#capo-row').hidden = st.capo === 0;
    $('#capo-toggle').checked = st.useCapo;
    player.defaultPlaybackRate = player.playbackRate = parseFloat($('#speed').value);
    renderResults();
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function findLoop(names) {
    let best = null;
    for (let L = 2; L <= 6; L++) {
      const map = new Map();
      for (let i = 0; i + L <= names.length; i++) { const k = names.slice(i, i + L).join(' '); map.set(k, (map.get(k) || 0) + 1); }
      for (const [k, c] of map) {
        if (c < 2) continue;
        const score = c * L - (L > 4 ? 1 : 0);
        if (!best || score > best.score + 0.5) best = { seq: k.split(' '), count: c, score };
      }
    }
    return best;
  }

  function renderResults() {
    const cap = capoEff();
    const names = st.segs.map(s => shapeOf(s).name);
    const uniq = new Set(names);
    const minutes = st.dur / 60, cpm = st.segs.length / Math.max(0.05, minutes);
    // usage
    const dur = new Map(), shapes = new Map();
    st.segs.forEach(s => { const sh = shapeOf(s); dur.set(sh.name, (dur.get(sh.name) || 0) + s.end - s.start); if (!shapes.has(sh.name)) shapes.set(sh.name, sh); });
    const ranked = [...dur.entries()].sort((a, b) => b[1] - a[1]);
    const totalDur = ranked.reduce((a, r) => a + r[1], 0) || 1;
    const shown = ranked.slice(0, 8).map(r => shapes.get(r[0]));
    // difficulty
    const barres = [...shapes.values()].filter(s => s.barre && s.barre.from < 4 && s.barre.to === 5).length;
    const score = uniq.size * 0.45 + barres * 1.1 + cpm / 18;
    const lvl = score < 2.5 ? 'Beginner' : score < 4.5 ? 'Easy' : score < 6.5 ? 'Medium' : 'Hard';
    const filled = clamp(Math.round(score / 2), 1, 5);
    const key = st.keyInfo;
    const cards = [
      ['Length', fmtTime(st.dur), ''],
      ['Tempo', st.bpm ? `<span class="beat-dot" style="--beat:${(60 / st.bpm).toFixed(3)}s"></span>${st.bpm} <span class="em">BPM</span>` : '?', ''],
      ['Key', key ? key.name : '?', ''],
      ['Capo', cap ? 'Fret ' + cap : 'None', ''],
      ['Chords', uniq.size, ''],
      ['Changes', `${cpm.toFixed(0)}<span class="em">/min</span>`, ''],
      ['Difficulty', `${lvl}<span class="dmeter">${[0, 1, 2, 3, 4].map(i => `<i class="${i < filled ? 'f' : ''}"></i>`).join('')}</span>`, '']
    ];
    $('#cards').innerHTML = cards.map((c, i) => `<div class="stat" style="animation-delay:${i * 60}ms"><small>${c[0]}</small><b>${c[1]}</b></div>`).join('');

    $('#chips').innerHTML = st.segs.map((s, i) => `<button class="chip" data-i="${i}"><b>${shapeOf(s).name}</b><small>${fmtTime(s.start)}</small></button>`).join('');

    const loop = findLoop(names);
    $('#loopbox').innerHTML = loop
      ? `<div class="muted small" style="margin-bottom:6px">Repeating pattern (×${loop.count}):</div><div class="loopbox">${loop.seq.map((n, i) => `${i ? '<span class="ar">→</span>' : ''}<span class="lc">${n}</span>`).join('')}</div>`
      : '';
    $('#usage').innerHTML = ranked.slice(0, 8).map(([n, d], i) => {
      const pct = d / totalDur * 100;
      return `<div class="usage"><b>${n}</b><div class="track"><i style="--w:${pct.toFixed(1)}%;--d:${i * 80}ms"></i></div><span class="muted">${Math.round(pct)}%</span></div>`;
    }).join('');

    $('#learn-shapes').innerHTML = shown.map(sh => chordCard(sh, '')).join('');
    const hard = shown.filter(s => s.barre && s.barre.from < 4 && s.barre.to === 5).map(s => s.name);
    const steps = [
      'Tune your guitar first (<b>Tuner</b> tab).',
      cap ? `Put your <b>capo on fret ${cap}</b>. The shapes shown are for the capo: same sound as the song, easier fingers.` : 'No capo needed for this song.',
      `The song is in <b>${key ? key.name : '?'}</b>. Learn these shapes: <b>${shown.map(s => s.name).join(', ')}</b>${ranked.length > 8 ? ` (+${ranked.length - 8} rarer)` : ''}. Practice switching between the two most-used ones first.` +
        (hard.length ? ` <i>${hard.join(', ')} ${hard.length > 1 ? 'are barre chords' : 'is a barre chord'} (index finger across all strings). Hard at first: skip for now and keep strumming.</i>` : ''),
      st.bpm ? `Tempo is about <b>${st.bpm} BPM</b>. Strum <b>down once per beat</b> (1-2-3-4).${st.bpm > 130 ? ' Too fast? Strum once every 2 beats.' : ''} Use the 🥁 metronome to practice without the song.` : 'Tap your foot with the music and strum down on each beat.',
      loop ? `Most of the song repeats <b>${loop.seq.join(' → ')}</b>. Master this loop and you can play most of it.` : 'Follow the chord changes on the timeline.',
      'Set speed to <b>0.5×</b> and press play. When <b>PLAY NOW</b> changes, change your fingers. <b>NEXT</b> warns you early.',
      'Missed a change? Keep strumming. Speed up to 0.75×, then 1× when it feels easy.'
    ];
    $('#steps').innerHTML = steps.map(s => `<li>${s}</li>`).join('');
    st.key = ''; st.idx = -1;
    updateNow();
    requestAnimationFrame(drawTimelines);
  }

  function showChord(el, seg) {
    if (!seg) { el.innerHTML = '<div class="big-empty">–</div>'; return; }
    const sh = shapeOf(seg);
    el.innerHTML = `<div class="swap">${chordSVG(sh)}<div class="big-name">${sh.name}</div>${capoEff() ? `<div class="sub">sounds like ${seg.name}</div>` : ''}</div>`;
  }

  function updateNow() {
    if (!st.segs.length) return;
    const t = player.currentTime || 0;
    let cur = -1, nxt = -1;
    for (let i = 0; i < st.segs.length; i++) {
      const s = st.segs[i];
      if (t >= s.start && t < s.end) cur = i;
      if (nxt < 0 && s.start > t) nxt = i;
    }
    const key = cur + '|' + nxt + '|' + capoEff();
    if (key !== st.key) {
      st.key = key;
      showChord($('#now'), st.segs[cur]);
      showChord($('#next'), st.segs[nxt]);
      if (cur !== st.idx) {
        st.idx = cur;
        $$('#chips .chip').forEach((c, i) => c.classList.toggle('active', i === cur));
        const act = $('#chips .chip.active'), box = $('#chips');
        if (act) box.scrollTo({ left: act.offsetLeft - box.clientWidth / 2 + act.offsetWidth / 2, behavior: 'smooth' });
      }
    }
    drawTimelines();
  }

  // ---- timelines: waveform+chords, chromagram, energy (cached static layer + live playhead) ----
  function heat(v) {
    // dark violet -> magenta -> amber
    v = clamp(v, 0, 1);
    const stops = [[14, 12, 30], [124, 92, 255], [255, 94, 138], [255, 208, 138]];
    const p = v * 3, i = Math.min(2, Math.floor(p)), f = p - i;
    const a = stops[i], b = stops[i + 1];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  }
  function staticWave(c, w, h) {
    const dur = st.dur || 1;
    c.font = '700 12px Inter, system-ui, sans-serif';
    st.segs.forEach(s => {
      const x0 = s.start / dur * w, x1 = s.end / dur * w;
      c.fillStyle = `hsla(${s.root * 30},75%,58%,${s.minor ? 0.2 : 0.32})`;
      c.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      c.fillStyle = `hsla(${s.root * 30},85%,65%,.9)`;
      c.fillRect(x0, 0, 2, h);
      if (x1 - x0 > 26) { c.fillStyle = 'rgba(255,255,255,.9)'; c.fillText(shapeOf(s).name, x0 + 5, 15); }
    });
    c.fillStyle = 'rgba(238,240,247,.8)';
    const B = st.peaks.length;
    for (let x = 0; x < w; x += 2) {
      const p = st.peaks[Math.min(B - 1, Math.floor(x / w * B))];
      const bh = Math.max(1, p * (h - 34));
      c.fillRect(x, h / 2 + 8 - bh / 2, 1.5, bh);
    }
    c.fillStyle = 'rgba(255,255,255,.45)'; c.font = '600 10px Inter, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const tx = i / 4 * w;
      c.fillText(fmtTime(i / 4 * dur), Math.min(w - 26, Math.max(2, tx - (i === 4 ? 0 : 0))), h - 3);
    }
  }
  function staticChroma(c, w, h) {
    const fr = st.res.chroma, T = fr.length, cw = w / T, rh = h / 12;
    for (let t = 0; t < T; t++) {
      for (let p = 0; p < 12; p++) {
        c.fillStyle = heat(Math.pow(fr[t][p], 2.2));
        c.fillRect(t * cw, h - (p + 1) * rh, cw + 0.6, rh + 0.6);
      }
    }
    c.font = '700 10px Inter, sans-serif'; c.fillStyle = 'rgba(255,255,255,.75)';
    for (let p = 0; p < 12; p++) c.fillText(GA.NOTES[p], 4, h - p * rh - rh / 2 + 3);
  }
  function staticEnergy(c, w, h) {
    const e = st.res.energy, T = e.length;
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,94,138,.85)'); g.addColorStop(1, 'rgba(124,92,255,.15)');
    c.fillStyle = g;
    c.beginPath(); c.moveTo(0, h);
    for (let t = 0; t < T; t++) c.lineTo(t / (T - 1 || 1) * w, h - 4 - Math.pow(e[t], 0.8) * (h - 10));
    c.lineTo(w, h); c.closePath(); c.fill();
  }
  const LAYERS = { wave: staticWave, chroma: staticChroma, energy: staticEnergy };
  function drawTimelines() {
    if (!st.res || !st.peaks || $('#results').hidden || $('#tab-analyze').hidden) return;
    const t = player.currentTime || 0;
    Object.keys(LAYERS).forEach(id => {
      const cv = document.getElementById(id), p = prep(cv);
      if (!p) return;
      const { c, w, h, dpr } = p, k = [w, h, dpr, capoEff(), st.token].join('|');
      if (cv._k !== k) {
        const off = cv._off || (cv._off = document.createElement('canvas'));
        off.width = cv.width; off.height = cv.height;
        const oc = off.getContext('2d'); oc.setTransform(dpr, 0, 0, dpr, 0, 0);
        LAYERS[id](oc, w, h);
        cv._k = k;
      }
      c.clearRect(0, 0, w, h);
      c.drawImage(cv._off, 0, 0, w, h);
      const px = clamp(t / (st.dur || 1), 0, 1) * w;
      c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(0, 0, px, h);
      c.fillStyle = '#ffb347'; c.shadowColor = '#ffb347'; c.shadowBlur = 8;
      c.fillRect(px - 1, 0, 2, h);
      c.shadowBlur = 0;
    });
  }
  ['wave', 'chroma', 'energy'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      player.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * st.dur;
      updateNow();
    });
  });
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    player.currentTime = st.segs[+b.dataset.i].start + 0.01;
    player.play().catch(() => {});
  });
  $('#speed').addEventListener('change', e => { player.defaultPlaybackRate = player.playbackRate = parseFloat(e.target.value); });
  player.addEventListener('loadedmetadata', () => { player.playbackRate = parseFloat($('#speed').value); });
  $('#capo-toggle').addEventListener('change', e => { st.useCapo = e.target.checked; renderResults(); });

  // ---- live visualizer on the player ----
  const viz = { ctx: null, an: null, f: null, raf: 0 };
  function ensureViz() {
    if (viz.ctx) { if (viz.ctx.state === 'suspended') viz.ctx.resume(); return; }
    try {
      viz.ctx = new AC();
      const src = viz.ctx.createMediaElementSource(player);
      viz.an = viz.ctx.createAnalyser(); viz.an.fftSize = 4096; viz.an.smoothingTimeConstant = 0.78;
      viz.f = new Float32Array(viz.an.frequencyBinCount);
      src.connect(viz.an); viz.an.connect(viz.ctx.destination);
    } catch (e) { viz.ctx = null; }
  }
  function vizLoop() {
    updateNow();
    if (viz.an) { viz.an.getFloatFrequencyData(viz.f); drawSpectrum($('#viz'), viz.f, viz.ctx.sampleRate, viz.an.fftSize); }
    if (!player.paused && !player.ended) viz.raf = requestAnimationFrame(vizLoop);
    else { drawSpectrum($('#viz'), null, 1, 1); }
  }
  player.addEventListener('play', () => { ensureViz(); cancelAnimationFrame(viz.raf); viz.raf = requestAnimationFrame(vizLoop); });
  ['pause', 'ended', 'seeked', 'timeupdate'].forEach(ev => player.addEventListener(ev, updateNow));
  $('#viz').getContext && drawSpectrum($('#viz'), null, 1, 1);

  // ---- metronome ----
  const metro = { on: false, timer: 0, beat: 0 };
  function metroTick() {
    const ctx = getOut(), o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.frequency.value = metro.beat % 4 === 0 ? 1600 : 1050;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.09);
    $$('#beats i').forEach((d, i) => d.classList.toggle('on', i === metro.beat % 4));
    metro.beat++;
  }
  function stopMetro() {
    clearInterval(metro.timer); metro.on = false; metro.beat = 0;
    $('#metro-btn').textContent = '🥁 Metronome';
    $$('#beats i').forEach(d => d.classList.remove('on'));
  }
  $('#metro-btn').addEventListener('click', () => {
    if (metro.on) { stopMetro(); return; }
    metro.on = true; metro.beat = 0;
    $('#metro-btn').textContent = '⏹ Stop metronome';
    const ms = 60000 / (st.bpm || 90) / parseFloat($('#speed').value);
    metroTick(); metro.timer = setInterval(metroTick, ms);
  });

  // ---- file input + drag & drop ----
  const drop = $('#drop');
  $('#file-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadMedia(f, f.name); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0]; if (!f) return;
    if (!/^(audio|video)\//.test(f.type) && !/\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm|mkv)$/i.test(f.name)) { setStatus(anStatus, 'Please drop an audio or video file.', true); return; }
    loadMedia(f, f.name);
  });
  $('#use-recording').addEventListener('click', () => { if (recBlob) loadMedia(recBlob, 'my recording'); });

  const h = location.hash.slice(1);
  if (['learn', 'camera', 'tuner', 'analyze'].includes(h)) showTab(h);
})();
