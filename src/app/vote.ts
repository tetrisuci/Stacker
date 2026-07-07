// Optimistic vote arithmetic, kept pure so the buttons can apply a click
// immediately and reconcile (or revert) when the server answers.

export interface VoteState {
  ups: number;
  downs: number;
  myVote: number; // -1 | 0 | 1
}

/** Clicking the button you already voted toggles it off. */
export function nextVote(myVote: number, clicked: 1 | -1): -1 | 0 | 1 {
  return myVote === clicked ? 0 : clicked;
}

/** The counts as the server will see them after this user's vote becomes
 * `next`: remove the current vote's contribution, add the new one. */
export function applyVote(state: VoteState, next: -1 | 0 | 1): VoteState {
  let { ups, downs } = state;
  if (state.myVote === 1) ups -= 1;
  if (state.myVote === -1) downs -= 1;
  if (next === 1) ups += 1;
  if (next === -1) downs += 1;
  return { ups, downs, myVote: next };
}
