// Звуки синтезируются прямо в браузере (Web Audio API), поэтому вопросов с авторскими правами нет.
const Sfx = (() => {
  let ctx = null;
  let muted = false;

  function init() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function tone(freq, start, dur, type, vol) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function melody(notes, step, dur, type, vol) {
    notes.forEach((f, i) => tone(f, i * step, dur, type, vol));
  }

  return {
    init,
    toggle() { muted = !muted; return muted; },
    start()  { melody([523, 659, 784], 0.1, 0.18); },
    tick()   { tone(880, 0, 0.07, 'square', 0.05); },
    vote()   { melody([392, 523, 659], 0.12, 0.2); },
    result() { melody([523, 659, 784, 1047], 0.12, 0.25); },
    final()  { melody([523, 523, 523, 659, 784, 659, 784, 1047], 0.16, 0.3, 'triangle', 0.18); }
  };
})();
