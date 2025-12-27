
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";
import { MODEL_TEXT, PROMPTS } from "../constants";

// Helper to init client with fresh key
const getAiClient = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Agent 1: Code Agent ---
export async function runCodeAgent(
  originalImg: string
): Promise<string> {
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
}

// --- Agent 2: Gap Finder / Verifier (History Aware) ---
export async function runGapFinder(
  history: any[]
): Promise<string> {
  const ai = getAiClient();
  
  try {
      const response = await ai.models.generateContent({
        model: MODEL_TEXT,
        contents: history,
        config: {
          systemInstruction: PROMPTS.GAP_FINDER
        }
      });
      return response.text || "No critique generated.";
  } catch (e) {
      console.warn(`Gap Finder failed to critique.`, e);
      return "Critique generation failed.";
  }
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
    const ai = getAiClient();
    const result = await ai.models.generateContent({
        model: MODEL_TEXT,
        contents: history,
        config: {
            tools: [{ functionDeclarations: editorTools }] 
        }
    });

    return result;
}
