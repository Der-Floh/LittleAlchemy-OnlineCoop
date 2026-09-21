// Allows only one active co-op tab per browser profile. Little Alchemy keeps
// its save in localStorage, so two open game tabs overwrite each other's
// progress; two co-op connections from the same player would be confusing too.

const CHANNEL = 'la-coop-tabs';

export class TabGuard {
  constructor({ onYield = () => {} } = {}) {
    this.id = Math.random().toString(36).slice(2);
    this.active = false;
    this._onYield = onYield;
    this._sawActive = false;
    this._channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
    if (this._channel) this._channel.onmessage = (event) => this._onMessage(event.data || {});
  }

  _onMessage(msg) {
    if (msg.id === this.id) return;
    if (msg.t === 'probe' && this.active) this._post({ t: 'active' });
    else if (msg.t === 'active') this._sawActive = true;
    else if (msg.t === 'takeover' && this.active) {
      this.active = false;
      this._onYield();
    }
  }

  _post(msg) {
    if (this._channel) this._channel.postMessage({ ...msg, id: this.id });
  }

  // Resolves to true if this tab may run co-op.
  async start(waitMs = 300) {
    if (!this._channel) {
      this.active = true;
      return true;
    }
    this._post({ t: 'probe' });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.active = !this._sawActive;
    return this.active;
  }

  takeOver() {
    this._post({ t: 'takeover' });
    this.active = true;
  }
}
