// Other players' cursors: an arrow in their colour with their name, and the
// element they're dragging out of the library, if any. Positions come from
// Cursors (cursors.ts), already in this screen's pixels.

import { colorFor } from './colors.ts';
import type { Ui } from './state.ts';

const ARROW = 'M1 1 L1 17 L5.5 13 L8.5 20.5 L11.5 19.2 L8.6 11.8 L14.5 11.8 Z';

export function CursorLayer({ ui }: { ui: Ui }) {
  return (
    <div class="cursors" aria-hidden="true">
      {ui.cursors.value.map((cursor) => {
        const color = colorFor(cursor.color);
        return (
          <div
            key={cursor.id}
            class="cursor"
            data-player={cursor.id}
            hidden={cursor.hidden}
            style={{ transform: `translate(${cursor.left}px, ${cursor.top}px)` }}
          >
            <svg width="18" height="22" viewBox="0 0 18 22">
              <path d={ARROW} fill={color} stroke="#fff" stroke-width="1.5" stroke-linejoin="round" />
            </svg>
            <span class="name" style={{ background: color }}>
              {cursor.name}
            </span>
            <img class="ghost" alt="" hidden={!cursor.ghost} src={cursor.ghost ?? undefined} />
          </div>
        );
      })}
    </div>
  );
}
