"use client";
// Generic undo/redo history stack — a small generalization of the editor's
// original single-slot "snapshot before an AI edit" mechanism (a plain array
// of full-state snapshots, not a command/patch system: the codebase already
// proves the flat-snapshot approach works fine at this state size, and
// generalizing it is far lower-risk than a rewrite).
import { useRef, useState, useCallback } from "react";

export function useHistory<T>() {
  const undoStack = useRef<T[]>([]);
  const redoStack = useRef<T[]>([]);
  // Mirrors of the stack lengths purely to trigger a re-render so
  // canUndo/canRedo-driven UI (buttons, keyboard hints) stays in sync —
  // the stacks themselves live in refs so pushing doesn't itself re-render.
  const [sizes, setSizes] = useState({ undo: 0, redo: 0 });
  const sync = useCallback(() => {
    setSizes({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, []);

  const push = useCallback((snapshot: T) => {
    undoStack.current.push(snapshot);
    redoStack.current = [];
    sync();
  }, [sync]);

  // `current` is the live state to stash on the OTHER stack before restoring
  // the popped snapshot, so redo/undo can round-trip losslessly.
  const undo = useCallback((current: T): T | null => {
    const prev = undoStack.current.pop();
    if (prev === undefined) return null;
    redoStack.current.push(current);
    sync();
    return prev;
  }, [sync]);

  const redo = useCallback((current: T): T | null => {
    const next = redoStack.current.pop();
    if (next === undefined) return null;
    undoStack.current.push(current);
    sync();
    return next;
  }, [sync]);

  const reset = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    sync();
  }, [sync]);

  return {
    push, undo, redo, reset,
    canUndo: sizes.undo > 0,
    canRedo: sizes.redo > 0,
  };
}
