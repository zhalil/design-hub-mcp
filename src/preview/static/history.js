// Undo/redo stack. A step is { undo, redo, label }; closures may be async.
export function createHistory(limit = 100) {
  let past = [];
  let future = [];
  return {
    push(step) { past.push(step); if (past.length > limit) past.shift(); future = []; },
    async undo() { const s = past.pop(); if (!s) return null; await s.undo(); future.push(s); return s.label; },
    async redo() { const s = future.pop(); if (!s) return null; await s.redo(); past.push(s); return s.label; },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() { past = []; future = []; },
  };
}
