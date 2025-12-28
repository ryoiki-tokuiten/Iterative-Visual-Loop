
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";
import { MODEL_TEXT, PROMPTS } from "../constants";

// ═══════════════════════════════════════════════════════════════════════════════
//                    RATE LIMITER & RETRY MECHANISM
// ═══════════════════════════════════════════════════════════════════════════════
// Designed for Gemini free tier: 5 RPM (requests per minute)

const RATE_LIMIT_CONFIG = {
  maxRequestsPerMinute: 5,
  minDelayBetweenRequests: 12000, // 12 seconds between requests (5 RPM = 1 request per 12 seconds)
  maxRetries: 5,
  baseBackoffMs: 15000, // Start with 15 second backoff
  maxBackoffMs: 120000, // Max 2 minute backoff
  backoffMultiplier: 2, // Exponential backoff factor
};

// Track request timestamps for rate limiting
let requestTimestamps: number[] = [];
let lastRequestTime = 0;

/**
 * Wait for rate limit window to allow next request
 */
async function waitForRateLimit(): Promise<void> {
  const now = Date.now();

  // Clean up old timestamps (older than 1 minute)
  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);

  // If we've hit the rate limit, wait until the oldest request expires
  if (requestTimestamps.length >= RATE_LIMIT_CONFIG.maxRequestsPerMinute) {
    const oldestTimestamp = requestTimestamps[0];
    const waitTime = 60000 - (now - oldestTimestamp) + 1000; // +1s buffer
    if (waitTime > 0) {
      console.log(`[Rate Limit] Hit ${RATE_LIMIT_CONFIG.maxRequestsPerMinute} RPM limit. Waiting ${(waitTime / 1000).toFixed(1)}s...`);
      await sleep(waitTime);
    }
  }

  // Also ensure minimum delay between consecutive requests
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_CONFIG.minDelayBetweenRequests) {
    const delayNeeded = RATE_LIMIT_CONFIG.minDelayBetweenRequests - timeSinceLastRequest;
    console.log(`[Rate Limit] Spacing requests. Waiting ${(delayNeeded / 1000).toFixed(1)}s...`);
    await sleep(delayNeeded);
  }
}

/**
 * Record a request was made
 */
function recordRequest(): void {
  const now = Date.now();
  requestTimestamps.push(now);
  lastRequestTime = now;
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable (rate limit, server error, etc.)
 */
function isRetryableError(error: any): boolean {
  const message = error?.message?.toLowerCase() || '';
  const status = error?.status || error?.httpStatus || 0;

  // Rate limit errors
  if (status === 429 || message.includes('rate limit') || message.includes('quota') || message.includes('resource exhausted')) {
    return true;
  }

  // Server errors (5xx)
  if (status >= 500 && status < 600) {
    return true;
  }

  // Network errors
  if (message.includes('network') || message.includes('timeout') || message.includes('econnreset')) {
    return true;
  }

  // Gemini specific errors
  if (message.includes('temporarily') || message.includes('overloaded') || message.includes('try again')) {
    return true;
  }

  return false;
}

/**
 * Calculate backoff time with jitter
 */
function calculateBackoff(attempt: number): number {
  const exponentialBackoff = RATE_LIMIT_CONFIG.baseBackoffMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt);
  const jitter = Math.random() * 5000; // 0-5s jitter
  return Math.min(exponentialBackoff + jitter, RATE_LIMIT_CONFIG.maxBackoffMs);
}

/**
 * Wrapper for API calls with retry and rate limiting
 */
async function withRetry<T>(
  apiCall: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= RATE_LIMIT_CONFIG.maxRetries; attempt++) {
    try {
      // Wait for rate limit before making request
      await waitForRateLimit();

      console.log(`[API] ${operationName} - Attempt ${attempt + 1}/${RATE_LIMIT_CONFIG.maxRetries + 1}`);

      // Make the API call
      const result = await apiCall();

      // Record successful request
      recordRequest();

      console.log(`[API] ${operationName} - Success`);
      return result;

    } catch (error: any) {
      lastError = error;

      console.warn(`[API] ${operationName} - Error on attempt ${attempt + 1}:`, error?.message || error);

      // If it's a retryable error and we have retries left
      if (isRetryableError(error) && attempt < RATE_LIMIT_CONFIG.maxRetries) {
        const backoffTime = calculateBackoff(attempt);
        console.log(`[API] ${operationName} - Retrying in ${(backoffTime / 1000).toFixed(1)}s (attempt ${attempt + 2}/${RATE_LIMIT_CONFIG.maxRetries + 1})...`);
        await sleep(backoffTime);
        continue;
      }

      // Non-retryable error or out of retries
      throw error;
    }
  }

  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                            GEMINI API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

// Helper to init client with fresh key
const getAiClient = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Agent 1: Code Agent ---
export async function runCodeAgent(
  originalImg: string
): Promise<string> {
  return withRetry(async () => {
    const ai = getAiClient();

    const parts: any[] = [
      { text: PROMPTS.CODE_AGENT },
      { text: "Original Reference Image:" },
      { inlineData: { mimeType: 'image/png', data: originalImg } }
    ];

    const response = await ai.models.generateContent({
      model: MODEL_TEXT,
      contents: { parts },
      config: {
        thinkingConfig: { thinkingBudget: 16384 }
      }
    });

    let text = response.text || "";
    const match = text.match(/```html([\s\S]*?)```/);
    if (match) return match[1];
    const match2 = text.match(/```([\s\S]*?)```/);
    if (match2) return match2[1];

    return text;
  }, "CodeAgent");
}

// --- Agent 2: Gap Finder / Verifier (History Aware) ---
export async function runGapFinder(
  history: any[]
): Promise<string> {
  return withRetry(async () => {
    const ai = getAiClient();

    const response = await ai.models.generateContent({
      model: MODEL_TEXT,
      contents: history,
      config: {
        systemInstruction: PROMPTS.GAP_FINDER
      }
    });
    return response.text || "No critique generated.";
  }, "GapFinder");
}

// --- Agent 3: Editor Agent Tools ---
const editorTools: FunctionDeclaration[] = [
  {
    name: 'multi_edit',
    description: 'Execute multiple file edits (delete, replace, remove_text, insert) in a single sequential pass.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        operations: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              action: { type: Type.STRING, enum: ['replace', 'delete', 'remove_text', 'insert_before', 'insert_after'] },
              search_str: { type: Type.STRING },
              replace_str: { type: Type.STRING },
              start_line: { type: Type.INTEGER },
              end_line: { type: Type.INTEGER },
              line_number: { type: Type.INTEGER },
              text: { type: Type.STRING }
            },
            required: ['action']
          }
        }
      },
      required: ['operations']
    }
  },
  {
    name: 'read_file',
    description: 'Read the full file or a specific range of lines.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_line: { type: Type.INTEGER },
        end_line: { type: Type.INTEGER }
      }
    }
  },
  {
    name: 'todo_list',
    description: 'Manage the to-do list with statuses.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        add_items: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of todo strings to add" },
        update_items: {
          type: Type.ARRAY,
          description: "Update multiple items status at once",
          items: {
            type: Type.OBJECT,
            properties: {
              index: { type: Type.INTEGER },
              status: { type: Type.STRING, enum: ['pending', 'in_progress', 'done'] }
            }
          }
        },
        clear: { type: Type.BOOLEAN }
      }
    }
  },
  {
    name: 'take_screenshot',
    description: 'Capture the current state of the voxel scene. Use this AFTER every edit to verify your work.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'verify_changes',
    description: 'Submit work for final review. BLOCKED if todo items are pending.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'exit',
    description: 'Exit the editing loop. Only use this if verify_changes returned STATUS: DEPLOYABLE.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  }
];

export async function runEditorStepRaw(
  history: any[]
): Promise<any> {
  return withRetry(async () => {
    const ai = getAiClient();
    const result = await ai.models.generateContent({
      model: MODEL_TEXT,
      contents: history,
      config: {
        tools: [{ functionDeclarations: editorTools }],
        thinkingConfig: {
          thinkingBudget: 62000,
          includeThoughts: true  // Include thought summaries in response
        }
      }
    });

    return result;
  }, "EditorStep");
}

// Streaming version - yields chunks of text as they come in
export async function* runEditorStepStreaming(
  history: any[]
): AsyncGenerator<{ type: 'thought' | 'text' | 'functionCall' | 'done', content: any }> {
  await waitForRateLimit();
  recordRequest();

  const ai = getAiClient();
  const stream = await ai.models.generateContentStream({
    model: MODEL_TEXT,
    contents: history,
    config: {
      tools: [{ functionDeclarations: editorTools }],
      thinkingConfig: {
        thinkingBudget: 62000,
        includeThoughts: true
      }
    }
  });

  let fullResponse: any = null;

  for await (const chunk of stream) {
    fullResponse = chunk; // Keep track of latest response

    // Check for thoughts in this chunk
    const parts = chunk.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.thought && typeof part.thought === 'string') {
        yield { type: 'thought', content: part.thought };
      }
      if (part.text && typeof part.text === 'string') {
        yield { type: 'text', content: part.text };
      }
      if (part.functionCall) {
        yield { type: 'functionCall', content: part.functionCall };
      }
    }
  }

  yield { type: 'done', content: fullResponse };
}

// Export config for UI display
export const getRateLimitConfig = () => RATE_LIMIT_CONFIG;
