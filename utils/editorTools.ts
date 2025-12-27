
export const applySearchAndReplace = (code: string, searchStr: string, replaceStr: string): { newCode: string; success: boolean; msg: string } => {
  if (!code.includes(searchStr)) {
    return { newCode: code, success: false, msg: `Search string not found: "${searchStr.substring(0, 20)}..."` };
  }
  const newCode = code.replace(searchStr, replaceStr);
  return { newCode, success: true, msg: 'Replaced text successfully.' };
};

export const applyDeleteLines = (code: string, startLine: number, endLine: number): { newCode: string; success: boolean; msg: string } => {
  const lines = code.split('\n');
  if (startLine < 1 || endLine > lines.length || startLine > endLine) {
    return { newCode: code, success: false, msg: `Invalid line range: ${startLine}-${endLine}` };
  }
  // Adjust for 0-index array, remove lines
  lines.splice(startLine - 1, endLine - startLine + 1);
  return { newCode: lines.join('\n'), success: true, msg: `Deleted lines ${startLine} to ${endLine}.` };
};

export const applyInsert = (code: string, lineNum: number, text: string, position: 'before' | 'after'): { newCode: string; success: boolean; msg: string } => {
  const lines = code.split('\n');
  if (lineNum < 1 || lineNum > lines.length + 1) {
    return { newCode: code, success: false, msg: `Invalid line number: ${lineNum}` };
  }

  const index = position === 'before' ? lineNum - 1 : lineNum;
  lines.splice(index, 0, text);
  return { newCode: lines.join('\n'), success: true, msg: `Inserted text ${position} line ${lineNum}.` };
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
  let currentCode = code;
  const logs: string[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    let res = { newCode: currentCode, success: false, msg: 'Unknown op' };

    try {
      switch (op.action) {
        case 'replace':
          res = applySearchAndReplace(currentCode, op.search_str, op.replace_str);
          break;
        case 'remove_text':
          res = applySearchAndReplace(currentCode, op.search_str, "");
          break;
        case 'delete':
          res = applyDeleteLines(currentCode, op.start_line, op.end_line);
          break;
        case 'insert_before':
          res = applyInsert(currentCode, op.line_number, op.text, 'before');
          break;
        case 'insert_after':
          res = applyInsert(currentCode, op.line_number, op.text, 'after');
          break;
        default:
          res = { newCode: currentCode, success: false, msg: `Invalid action: ${op.action}` };
      }
    } catch (e: any) {
      res = { newCode: currentCode, success: false, msg: `Exception during op: ${e.message}` };
    }

    if (!res.success) {
      return {
        newCode: code, // Revert to original if any step fails to maintain integrity
        success: false,
        msg: `Batch failed at step ${i + 1} (${op.action}): ${res.msg}`
      };
    }

    currentCode = res.newCode;
    logs.push(res.msg);
  }

  return { newCode: currentCode, success: true, msg: `Batch executed (${operations.length} ops).` };
};
