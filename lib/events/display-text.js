'use strict';

function sanitizeDisplayText(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let fenceCharacter = '';
  let fenceLength = 0;
  let inComment = false;

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (!inComment && fence) {
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = '';
        fenceLength = 0;
      }
      output.push(line);
      continue;
    }

    if (fenceCharacter) {
      output.push(line);
      continue;
    }

    let remaining = line;
    let visible = '';
    while (remaining) {
      if (inComment) {
        const end = remaining.indexOf('-->');
        if (end < 0) {
          remaining = '';
          break;
        }
        inComment = false;
        remaining = remaining.slice(end + 3);
        continue;
      }

      const start = remaining.indexOf('<!--');
      if (start < 0) {
        visible += remaining;
        remaining = '';
        break;
      }
      visible += remaining.slice(0, start);
      inComment = true;
      remaining = remaining.slice(start + 4);
    }
    output.push(visible);
  }

  return output.join('\n').trim();
}

const CODEX_UI_DIRECTIVES = new Set([
  'code-comment',
  'created-thread',
  'git-commit',
  'git-create-branch',
  'git-create-pr',
  'git-push',
  'git-stage',
]);

function sanitizeAssistantDisplayText(value) {
  const lines = sanitizeDisplayText(value).split('\n');
  const output = [];
  let fenceCharacter = '';
  let fenceLength = 0;

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = '';
        fenceLength = 0;
      }
      output.push(line);
      continue;
    }

    const directive = !fenceCharacter && line.match(/^\s*::([a-z][a-z0-9-]*)\{[^\r\n]*\}\s*$/);
    if (directive && CODEX_UI_DIRECTIVES.has(directive[1])) continue;
    output.push(line);
  }

  return output.join('\n').trim();
}

module.exports = {
  sanitizeAssistantDisplayText,
  sanitizeDisplayText,
};
