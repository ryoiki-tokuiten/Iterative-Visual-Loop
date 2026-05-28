
export const applySearchAndReplace = (code: string, searchStr: string, replaceStr: string): { newCode: string; success: boolean; msg: string } => {
  if (!code.includes(searchStr)) {
    return { newCode: code, success: false, msg: `Search string not found. Make sure you are copying the exact text from the file, including whitespace and indentation.` };
  }
  // Check for multiple occurrences
  const count = code.split(searchStr).length - 1;
  if (count > 1) {
    return { newCode: code, success: false, msg: `Search string found ${count} times. Provide a longer, more unique search string that matches exactly once.` };
  }
  const newCode = code.replace(searchStr, replaceStr);
  return { newCode, success: true, msg: 'Edit applied.' };
};

export const readFile = (code: string, start?: number, end?: number): string => {
  const lines = code.split('\n');
  const s = start ? Math.max(0, start - 1) : 0;
  const e = end ? Math.min(lines.length, end) : lines.length;

  // Return with line numbers
  return lines.slice(s, e).map((line, idx) => `${s + idx + 1} | ${line}`).join('\n');
};

/**
 * Format code with line numbers for context injection
 * This helps the editor know exact line numbers for insert_after/insert_before operations
 */
export const formatCodeWithLineNumbers = (code: string): string => {
  const lines = code.split('\n');
  const padding = String(lines.length).length;
  return lines.map((line, idx) => `${String(idx + 1).padStart(padding, ' ')} | ${line}`).join('\n');
};

export const applyMultiEdit = (code: string, operations: any[]): { newCode: string; success: boolean; msg: string } => {
  if (!operations || operations.length === 0) {
    return { newCode: code, success: false, msg: "No operations provided." };
  }

  let currentCode = code;
  const successes: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const searchStr = op.search_str || op.old || op.find || '';
    const replaceStr = op.replace_str || op.new || op.replacement || '';

    if (!searchStr && !replaceStr) {
      failures.push(`Step ${i + 1}: Both search and replace strings are empty.`);
      continue;
    }
    if (!searchStr) {
      failures.push(`Step ${i + 1}: No search string provided.`);
      continue;
    }

    const res = applySearchAndReplace(currentCode, searchStr, replaceStr);
    if (!res.success) {
      failures.push(`Step ${i + 1} Failed: ${res.msg}`);
    } else {
      currentCode = res.newCode;
      successes.push(`Step ${i + 1} Succeeded`);
    }
  }

  const total = operations.length;
  const succeededCount = successes.length;
  const failedCount = failures.length;

  if (succeededCount === 0) {
    return {
      newCode: code,
      success: false,
      msg: `All ${total} edit(s) failed!\n\nDetails:\n${failures.join('\n')}`
    };
  }

  if (failedCount === 0) {
    return {
      newCode: currentCode,
      success: true,
      msg: `Success: All ${total} edit(s) applied successfully.`
    };
  }

  // Partial success
  return {
    newCode: currentCode,
    success: true, // Return true so that the successfully matched edits are committed and run!
    msg: `PARTIAL SUCCESS: Successfully applied ${succeededCount} out of ${total} edits.\n\n` +
         `=== SUCCESSFULLY APPLIED ===\n${successes.join('\n')}\n\n` +
         `=== FAILED (NOT APPLIED) ===\n${failures.join('\n')}\n\n` +
         `Note: The successfully matched edits have been saved and applied to the active file. Please review the failed steps above and re-apply only those steps using exact matching text.`
  };
};
