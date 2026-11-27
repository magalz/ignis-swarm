export const REVIEW_STATE_TTL_MS = 10 * 60 * 1000;

export function normalizeWorkspaceKey(dir) {
  return dir;
}

export function reviewStatePath() {
  return "";
}

export function recordReviewState() {
  return undefined;
}

export function readReviewState() {
  return null;
}

export function reviewGateDecision() {
  return { allow: false, missing: [], errors: [] };
}
