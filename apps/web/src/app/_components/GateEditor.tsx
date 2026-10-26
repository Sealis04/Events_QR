"use client";

import { useState } from "react";

const GRIP = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="#8a93a3">
    <circle cx="4" cy="3" r="1.3" />
    <circle cx="10" cy="3" r="1.3" />
    <circle cx="4" cy="7" r="1.3" />
    <circle cx="10" cy="7" r="1.3" />
    <circle cx="4" cy="11" r="1.3" />
    <circle cx="10" cy="11" r="1.3" />
  </svg>
);

export const MAX_GATES = 16;

/**
 * Gates as tags: drag to reorder (or the move buttons, for keyboards), ✕ removes, the input adds.
 * `remap[i]` is the old position of the new gate i (-1 = a new gate), so the caller can carry the
 * per-ticket-type gate flags along. The first `locked` gates keep their place and cannot be removed.
 */
export function GateEditor({
  gates,
  locked = 0,
  error,
  onChange,
}: {
  gates: string[];
  locked?: number;
  error?: string;
  onChange: (next: string[], remap: number[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState<number>();
  const [problem, setProblem] = useState("");
  const identity = gates.map((_, i) => i);

  function move(from: number, to: number) {
    if (from === to || from < locked || to < locked || to < 0 || to >= gates.length) return;
    const order = [...identity];
    order.splice(to, 0, order.splice(from, 1)[0]!);
    onChange(
      order.map((i) => gates[i]!),
      order,
    );
  }
  function add() {
    const name = draft.trim();
    if (!name) return;
    if (gates.length >= MAX_GATES) return setProblem(`At most ${MAX_GATES} gates.`);
    if (gates.some((g) => g.toLowerCase() === name.toLowerCase()))
      return setProblem("There is already a gate with that name.");
    setProblem("");
    onChange([...gates, name], [...identity, -1]);
    setDraft("");
  }
  return (
    <div className="grid">
      <ul
        className="gate-tags"
        style={{ listStyle: "none", margin: 0, padding: 0 }}
        aria-label="Gates"
      >
        {gates.map((g, i) => {
          const isLocked = i < locked;
          return (
            <li
              key={`${g}-${i}`}
              className={`gate-tag${isLocked ? " locked" : ""}${dragging === i ? " dragging" : ""}`}
              data-testid="gate-tag"
              draggable={!isLocked}
              onDragStart={() => setDragging(i)}
              onDragEnd={() => setDragging(undefined)}
              onDragOver={(e) => {
                if (dragging !== undefined && i >= locked) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== undefined) move(dragging, i);
                setDragging(undefined);
              }}
            >
              {isLocked ? "🔒" : GRIP}
              <span>{g}</span>
              {!isLocked && (
                <>
                  <button
                    type="button"
                    aria-label={`Move ${g} earlier`}
                    disabled={i <= locked}
                    onClick={() => move(i, i - 1)}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${g} later`}
                    disabled={i === gates.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${g}`}
                    disabled={gates.length === 1}
                    onClick={() =>
                      onChange(
                        gates.filter((_, j) => j !== i),
                        identity.filter((j) => j !== i),
                      )
                    }
                  >
                    ✕
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div className="gate-add">
        <label htmlFor="new-gate" className="sr-only">
          New gate name
        </label>
        <input
          id="new-gate"
          value={draft}
          placeholder="Type a gate name, press Enter"
          aria-label="New gate name"
          disabled={gates.length >= MAX_GATES}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="secondary"
          onClick={add}
          disabled={gates.length >= MAX_GATES}
        >
          Add gate
        </button>
      </div>
      {(problem || error) && (
        <span className="field-error" role="alert">
          {problem || error}
        </span>
      )}
    </div>
  );
}
