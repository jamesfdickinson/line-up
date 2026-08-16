export class MatchClock {
  constructor({ elapsedMs = 0, running = false, onTick = () => {} } = {}) {
    this.baseElapsedMs = elapsedMs;
    this.running = running;
    this.anchor = running ? performance.now() : null;
    this.onTick = onTick;
    this.timer = null;
    if (running) this.#schedule();
  }

  get elapsedMs() {
    return Math.max(0, this.baseElapsedMs + (this.running ? performance.now() - this.anchor : 0));
  }

  start() {
    if (this.running) return;
    this.anchor = performance.now();
    this.running = true;
    this.#schedule();
  }

  pause() {
    if (!this.running) return;
    this.baseElapsedMs = this.elapsedMs;
    this.running = false;
    this.anchor = null;
    clearInterval(this.timer);
    this.timer = null;
    this.onTick(this.elapsedMs);
  }

  set(elapsedMs) {
    this.baseElapsedMs = Math.max(0, elapsedMs);
    if (this.running) this.anchor = performance.now();
    this.onTick(this.elapsedMs);
  }

  destroy() { clearInterval(this.timer); }

  #schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.onTick(this.elapsedMs), 250);
  }
}
