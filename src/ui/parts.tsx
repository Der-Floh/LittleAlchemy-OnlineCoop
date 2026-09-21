// Rich text for the activity feed and toasts, e.g. "Bob: water + fire → steam NEW".

import { Fragment } from 'preact';
import { colorFor } from './colors.ts';
import type { Part } from './state.ts';

export function Parts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === 'string') return part;
        if ('who' in part) {
          return (
            <span key={i} class="who" style={{ color: colorFor(part.who.color) }}>
              {part.who.name}
            </span>
          );
        }
        return (
          <Fragment key={i}>
            <span class={part.bold ? 'what' : ''}>{part.el}</span>
            {part.isNew && <span class="new">new</span>}
          </Fragment>
        );
      })}
    </>
  );
}
