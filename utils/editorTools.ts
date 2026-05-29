export const applySearchAndReplace = (
  code: string,
  operations: { search_block: string; replace_block: string }[]
): {
  newCode: string;
  success: boolean;
  msg: string;
  opResults?: { search_block: string; replace_block: string; success: boolean; error?: string }[];
} => {
  if (!operations || operations.length === 0) {
    return { newCode: code, success: false, msg: "No operations provided.", opResults: [] };
  }

  let currentCode = code;
  const successes: string[] = [];
  const failures: string[] = [];
  const opResults: { search_block: string; replace_block: string; success: boolean; error?: string }[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const searchBlock = op.search_block || '';
    const replaceBlock = op.replace_block || '';

    if (!searchBlock) {
      const errMsg = "No search block provided.";
      failures.push(`Step ${i + 1} Failed: ${errMsg}`);
      opResults.push({ search_block: searchBlock, replace_block: replaceBlock, success: false, error: errMsg });
      continue;
    }

    if (!currentCode.includes(searchBlock)) {
      const errMsg = "Search block not found. Ensure you copy-pasted the exact lines and spacing.";
      failures.push(`Step ${i + 1} Failed: ${errMsg}`);
      opResults.push({ search_block: searchBlock, replace_block: replaceBlock, success: false, error: errMsg });
      continue;
    }

    // Direct search and replace
    currentCode = currentCode.replace(searchBlock, replaceBlock);
    successes.push(`Step ${i + 1} Succeeded`);
    opResults.push({ search_block: searchBlock, replace_block: replaceBlock, success: true });
  }

  const total = operations.length;
  const succeededCount = successes.length;
  const failedCount = failures.length;

  if (succeededCount === 0) {
    return {
      newCode: code,
      success: false,
      msg: `All ${total} edit(s) failed!\n\nDetails:\n${failures.join('\n')}`,
      opResults
    };
  }

  if (failedCount === 0) {
    return {
      newCode: currentCode,
      success: true,
      msg: `Success: All ${total} edit(s) applied successfully.`,
      opResults
    };
  }

  // Partial success
  return {
    newCode: currentCode,
    success: true, // Commit successfully matched edits to visual preview
    msg: `PARTIAL SUCCESS: Successfully applied ${succeededCount} out of ${total} edits.\n\n` +
         `=== SUCCESSFULLY APPLIED ===\n${successes.join('\n')}\n\n` +
         `=== FAILED (NOT APPLIED) ===\n${failures.join('\n')}\n\n` +
         `Note: Successfully matched edits have been applied. Please review the failed steps above and re-apply only those steps using the exact matching text.`,
    opResults
  };
};

export const readFile = (code: string, start?: number, end?: number): string => {
  const lines = code.split('\n');
  const s = start ? Math.max(0, start - 1) : 0;
  const e = end ? Math.min(lines.length, end) : lines.length;

  // Return with line numbers
  return lines.slice(s, e).map((line, idx) => `${s + idx + 1} | ${line}`).join('\n');
};

/**
 * Format code with line numbers for context/reference
 */
export const formatCodeWithLineNumbers = (code: string): string => {
  const lines = code.split('\n');
  const padding = String(lines.length).length;
  return lines.map((line, idx) => `${String(idx + 1).padStart(padding, ' ')} | ${line}`).join('\n');
};
