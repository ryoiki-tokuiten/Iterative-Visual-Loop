
export enum AgentType {
  CODER = 'CodeAgent',
  EDITOR = 'TheEditorAgent',
  VERIFIER = 'VerifierAgent',
  SYSTEM = 'System'
}

export enum WorkflowStatus {
  IDLE = 'IDLE',
  CODING = 'CODING',
  RENDERING = 'RENDERING',
  CRITIQUING = 'CRITIQUING',
  EDITING = 'EDITING',
  VERIFYING = 'VERIFYING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export interface LogEntry {
  id: string;
  timestamp: number;
  agent: AgentType;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'code' | 'tool_call' | 'tool_result' | 'thought';
  details?: string;
  metadata?: any;
}

export interface GeneratedArtifact {
  id: string;
  type: 'screenshot';
  url: string; // Base64
  description: string;
  agent: AgentType;
}

export interface CodeVersion {
  id: number;
  timestamp: number;
  code: string;
  description: string;
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}
