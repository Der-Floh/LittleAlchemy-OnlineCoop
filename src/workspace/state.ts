// The shared canvas as data: which elements are where, who placed them, and
// who is currently holding (dragging) which one.
//
// The host applies batches *authoritatively*: a batch is all-or-nothing, and
// it's refused if it touches an element someone else is holding, deletes or
// moves an element that no longer exists (e.g. another player just used it
// in a combination), re-adds an existing id, or overflows the canvas. The
// offending player then gets a snapshot and their screen snaps back.
// Clients apply the host's relayed batches *leniently*: the host already
// decided, so they apply whatever can be applied, in order.

import { MAX_ELEMENTS, type Op, type SnapshotElement, type Hold } from './ops.ts';

export type CanvasElement = { el: number; x: number; y: number; owner: string };
export type RefusalReason = 'exists' | 'full' | 'missing' | 'held' | 'bad-op';
export type BatchResult = { ok: true } | { ok: false; reason: RefusalReason };
export type StateSnapshot = { elements: SnapshotElement[]; holds?: Hold[] };

export class WorkspaceState {
    elements = new Map<string, CanvasElement>(); // oid -> element
    holds = new Map<string, string>(); // oid -> playerId

    get size(): number {
        return this.elements.size;
    }

    get(oid: string): CanvasElement | null {
        return this.elements.get(oid) ?? null;
    }

    holderOf(oid: string): string | null {
        return this.holds.get(oid) ?? null;
    }

    clone(): WorkspaceState {
        const copy = new WorkspaceState();
        for (const [oid, e] of this.elements) copy.elements.set(oid, { ...e });
        for (const [oid, who] of this.holds) copy.holds.set(oid, who);
        return copy;
    }

    // Authoritative batches are atomic; lenient ones skip what can't be applied.
    applyBatch(ops: readonly Op[], sender: string, { authoritative = false } = {}): BatchResult {
        if (authoritative) {
            const draft = this.clone();
            for (const op of ops) {
                const reason = draft.apply(op, sender, true);
                if (reason) return { ok: false, reason };
            }
            this.elements = draft.elements;
            this.holds = draft.holds;
            return { ok: true };
        }
        for (const op of ops) this.apply(op, sender, false);
        return { ok: true };
    }

    // Applies one op; returns a reason if it's not allowed (strict mode).
    private apply(op: Op, sender: string, strict: boolean): RefusalReason | null {
        const oid = op[1];
        const element = this.elements.get(oid);
        const holder = this.holds.get(oid);
        const heldByOther = holder !== undefined && holder !== sender;
        switch (op[0]) {
            case 'a':
                if (element && strict) return 'exists';
                if (!element && this.elements.size >= MAX_ELEMENTS) return strict ? 'full' : null;
                this.elements.set(oid, { el: op[2], x: op[3], y: op[4], owner: sender });
                return null;
            case 'd':
                if (!element) return strict ? 'missing' : null;
                if (heldByOther && strict) return 'held';
                this.elements.delete(oid);
                this.holds.delete(oid);
                return null;
            case 'm':
                if (!element) return strict ? 'missing' : null;
                if (heldByOther && strict) return 'held';
                element.x = op[2];
                element.y = op[3];
                return null;
            case 'h':
                if (!element) return strict ? 'missing' : null;
                if (heldByOther && strict) return 'held';
                this.holds.set(oid, sender);
                return null;
            case 'r':
                if (holder === sender) this.holds.delete(oid);
                return null;
            default:
                return strict ? 'bad-op' : null;
        }
    }

    // A player left: their grabs end where the elements are.
    releaseAll(playerId: string): string[] {
        const released: string[] = [];
        for (const [oid, who] of this.holds) {
            if (who === playerId) {
                this.holds.delete(oid);
                released.push(oid);
            }
        }
        return released;
    }

    ownedBy(playerId: string): string[] {
        const oids: string[] = [];
        for (const [oid, e] of this.elements) if (e.owner === playerId) oids.push(oid);
        return oids;
    }

    snapshot(): { elements: SnapshotElement[]; holds: Hold[] } {
        return {
            elements: [...this.elements].map(([oid, e]) => [oid, e.el, e.x, e.y, e.owner]),
            holds: [...this.holds],
        };
    }

    static fromSnapshot(snap: StateSnapshot): WorkspaceState {
        const state = new WorkspaceState();
        for (const [oid, el, x, y, owner] of snap.elements) state.elements.set(oid, { el, x, y, owner });
        for (const [oid, who] of snap.holds ?? []) if (state.elements.has(oid)) state.holds.set(oid, who);
        return state;
    }

    // Order-independent fingerprint, to detect a client that drifted from the
    // host. Part of the protocol: every version must compute the same value.
    hash(): string {
        const rows = [...this.elements]
            .map(([oid, e]) => oid + ':' + e.el + ':' + Math.round(e.x * 1000) + ':' + Math.round(e.y * 1000))
            .sort();
        let h = 0x811c9dc5;
        for (const row of rows) {
            for (let i = 0; i < row.length; i++) {
                h ^= row.charCodeAt(i);
                h = Math.imul(h, 0x01000193) >>> 0;
            }
            h ^= 0x2c;
        }
        return rows.length + '-' + h.toString(36);
    }
}
