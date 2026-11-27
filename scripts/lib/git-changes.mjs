export function gitToplevel() {
  return { error: { code: "git_failed", message: "not implemented" } };
}

export function headSha() {
  return "";
}

export function collectChanges() {
  return { diff: "", bytes: 0, untracked: [], error: null };
}
