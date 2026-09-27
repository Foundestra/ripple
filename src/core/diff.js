// Parses unified diffs (git diff / .patch) and GitHub "PR files" payloads into
// one normalized shape:
//   { path, previousPath, status, additions, deletions, hunks: [{ header, lines: [{ type, text }] }] }
// line.type is one of '+', '-', ' '.

export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = { path: m ? m[2] : '', previousPath: m ? m[1] : '', status: 'modified', additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'removed';
    else if (line.startsWith('rename from ')) file.status = 'renamed';
    else if (line.startsWith('--- ') && !hunk) continue;
    else if (line.startsWith('+++ ') && !hunk) {
      const p = line.slice(4).replace(/^b\//, '');
      if (p !== '/dev/null') file.path = p;
    } else if (line.startsWith('@@')) {
      hunk = { header: parseHunkHeader(line), lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      const type = line[0];
      if (type === '+' || type === '-' || type === ' ') {
        hunk.lines.push({ type, text: line.slice(1) });
        if (type === '+') file.additions++;
        if (type === '-') file.deletions++;
      }
    }
  }
  return files;
}

function parseHunkHeader(line) {
  const m = line.match(/^@@ [^@]+ @@ ?(.*)$/);
  return m ? m[1].trim() : '';
}

// GitHub GET /repos/{o}/{r}/pulls/{n}/files returns per-file `patch` strings
// that contain hunks only (no diff --git header).
export function fromGitHubFiles(ghFiles) {
  return ghFiles.map((f) => {
    const hunks = [];
    let hunk = null;
    for (const line of (f.patch || '').split('\n')) {
      if (line.startsWith('@@')) {
        hunk = { header: parseHunkHeader(line), lines: [] };
        hunks.push(hunk);
      } else if (hunk && (line[0] === '+' || line[0] === '-' || line[0] === ' ')) {
        hunk.lines.push({ type: line[0], text: line.slice(1) });
      }
    }
    return {
      path: f.filename,
      previousPath: f.previous_filename || f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      hunks,
    };
  });
}
