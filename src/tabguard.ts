// Allows only one active co-op tab per browser profile. Little Alchemy keeps
// its save in localStorage, so two open game tabs overwrite each other's
// progress; two co-op connections from the same player would be confusing too.

import { nanoid } from 'nanoid';

const CHANNEL = 'la-coop-tabs';

type TabMessage = { t: 'probe' | 'active' | 'takeover'; id: string };

export class TabGuard {
    readonly id = nanoid();
    active = false;
    private readonly onYield: () => void;
    private sawActive = false;
    private readonly channel: BroadcastChannel | null;

    constructor({ onYield = () => {} }: { onYield?: () => void } = {}) {
        this.onYield = onYield;
        this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
        if (this.channel) this.channel.onmessage = (event: MessageEvent<Partial<TabMessage> | null>) => this.onMessage(event.data ?? {});
    }

    private onMessage(msg: Partial<TabMessage>): void {
        if (msg.id === this.id) return;
        if (msg.t === 'probe' && this.active) this.post('active');
        else if (msg.t === 'active') this.sawActive = true;
        else if (msg.t === 'takeover' && this.active) {
            this.active = false;
            this.onYield();
        }
    }

    private post(t: TabMessage['t']): void {
        this.channel?.postMessage({ t, id: this.id } satisfies TabMessage);
    }

    // Resolves to true if this tab may run co-op.
    async start(waitMs = 300): Promise<boolean> {
        if (!this.channel) {
            this.active = true;
            return true;
        }
        this.post('probe');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.active = !this.sawActive;
        return this.active;
    }

    takeOver(): void {
        this.post('takeover');
        this.active = true;
    }
}
