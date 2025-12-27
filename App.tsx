
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { 
  AgentType, 
  WorkflowStatus, 
  LogEntry, 
  GeneratedArtifact,
  CodeVersion,
  TodoItem
} from './types';
import { 
  runCodeAgent, 
  runGapFinder, 
  runEditorStepRaw 
} from './services/gemini';
import { applyMultiEdit, readFile } from './utils/editorTools';
import CodePreview, { CodePreviewHandle } from './components/CodePreview';
import DiffViewer from './components/DiffViewer';
import { ArtifactGallery } from './components/ArtifactGallery';
import { PROMPTS } from './constants';

// Icons
const Icons = {
  Play: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  Check: () => <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>,
  Terminal: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
  Eye: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>,
  Close: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>,
  History: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  List: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>,
  Code: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>,
  Diff: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
};

type SidebarTab = 'logs' | 'versions' | 'plan';
type ViewMode = 'preview' | 'code' | 'diff';

export default function App() {
  const [status, setStatus] = useState<WorkflowStatus>(WorkflowStatus.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<GeneratedArtifact[]>([]);
  
  // Code & Versioning
  const [currentCode, setCurrentCode] = useState<string>("");
  const [codeHistory, setCodeHistory] = useState<CodeVersion[]>([]);
  const [viewingVersionId, setViewingVersionId] = useState<number | null>(null);

  const [editorTodo, setEditorTodo] = useState<TodoItem[]>([]);
  const [apiKeyMissing, setApiKeyMissing] = useState(false);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<GeneratedArtifact | null>(null);
  const [activeTab, setActiveTab] = useState<SidebarTab>('logs');
  
  const [viewMode, setViewMode] = useState<ViewMode>('preview');

  const previewRef = useRef<CodePreviewHandle>(null);
  const latestRuntimeErrorRef = useRef<string | null>(null);
  
  // Ref to track if verification loop should continue
  const isLoopingRef = useRef(false);

  useEffect(() => {
    if (!process.env.API_KEY) {
      setApiKeyMissing(true);
    }
  }, []);

  const addLog = useCallback((agent: AgentType, message: string, type: LogEntry['type'] = 'info', details?: string, metadata?: any) => {
    setLogs(prev => [{
      id: Math.random().toString(36).substr(2, 9),
      timestamp: Date.now(),
      agent,
      message,
      type,
      details,
      metadata
    }, ...prev]);
  }, []);

  const handleRuntimeError = useCallback((msg: string) => {
      // Don't log duplicate errors constantly
      if (latestRuntimeErrorRef.current === msg) return;
      addLog(AgentType.SYSTEM, msg, 'error');
      latestRuntimeErrorRef.current = msg;
  }, [addLog]);

  const saveCodeVersion = (code: string, description: string) => {
    const newVersion: CodeVersion = {
      id: Date.now(),
      timestamp: Date.now(),
      code: code,
      description
    };
    setCodeHistory(prev => [newVersion, ...prev]);
    setCurrentCode(code);
    setViewingVersionId(newVersion.id); // View latest
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const base64 = (evt.target?.result as string).split(',')[1];
        setOriginalImage(base64);
        addLog(AgentType.SYSTEM, "Image loaded. Ready to start.", 'info');
      };
      reader.readAsDataURL(file);
    }
  };

  const startWorkflow = async () => {
    if (!originalImage || apiKeyMissing) return;
    
    try {
      setArtifacts([]);
      setLogs([]);
      setEditorTodo([]);
      setCodeHistory([]);
      setViewingVersionId(null);
      setActiveTab('logs');
      latestRuntimeErrorRef.current = null;
      isLoopingRef.current = true;

      // 1. Initial Code Generation
      setStatus(WorkflowStatus.CODING);
      addLog(AgentType.CODER, "Drafting initial High-Fidelity Voxel Scene...", 'info');
      
      const initialCode = await runCodeAgent(originalImage);
      
      saveCodeVersion(initialCode, "Initial Code Generation");
      addLog(AgentType.CODER, "Initial code generated.", 'success', initialCode);

      // Wait a bit for render
      setStatus(WorkflowStatus.RENDERING);
      await new Promise(r => setTimeout(r, 2000)); 

      // 2. Refinement Loop
      await runRefinementLoop(originalImage, initialCode);

    } catch (err: any) {
      console.error(err);
      setStatus(WorkflowStatus.ERROR);
      addLog(AgentType.SYSTEM, `Error: ${err.message}`, 'error');
    }
  };

  // --- HISTORY MANAGER FOR VERIFIER ---
  // Replaces previous HTML content blocks with placeholders to save context
  const manageVerifierHistory = (history: any[], newCode: string, newScreenshot: string | null) => {
      const newHistory = [...history];
      
      // 1. Sanitize previous turns: Remove full HTML
      newHistory.forEach(part => {
          if (part.role === 'user') {
              if (Array.isArray(part.parts)) {
                  part.parts.forEach((p: any) => {
                      if (p.text && p.text.startsWith('<!DOCTYPE html>')) {
                          p.text = '[Previous HTML Code removed to save context]';
                      }
                  });
              }
          }
      });

      // 2. Add New Turn
      const newTurnParts: any[] = [
          { text: "Here is the latest code and visual state." },
          { text: newCode } // Full HTML for current turn
      ];
      if (newScreenshot) {
          newTurnParts.push({ text: "Latest Multi-Angle Screenshot:" });
          newTurnParts.push({ inlineData: { mimeType: 'image/png', data: newScreenshot } });
      } else {
          newTurnParts.push({ text: "Screenshot failed to capture (possible runtime error)." });
      }

      newHistory.push({ role: 'user', parts: newTurnParts });
      return newHistory;
  };

  const runRefinementLoop = async (
      originalImg: string, 
      startCode: string
  ) => {
    let loopCode = startCode;
    let iteration = 0;
    const maxIterations = 20; 
    
    // Editor History (Standard Gemini Chat)
    let editorHistory: any[] = [
        { 
            role: 'user', 
            parts: [
                { text: PROMPTS.EDITOR_SYSTEM },
                { text: `Current Code (read only):\n${loopCode}` },
                { text: "Original Reference Image:" },
                { inlineData: { mimeType: 'image/png', data: originalImg } }
            ] 
        }
    ];

    // Verifier History (Manually Managed Array)
    let verifierHistory: any[] = [
        {
            role: 'user',
            parts: [
                { text: "Original Reference Image:" },
                { inlineData: { mimeType: 'image/png', data: originalImg } }
            ]
        }
    ];

    while (isLoopingRef.current && iteration < maxIterations) {
      iteration++;
      addLog(AgentType.SYSTEM, `Starting Refinement Iteration ${iteration}`, 'info');

      // A. Take Screenshot for Supervisor
      if (viewMode !== 'preview') setViewMode('preview');
      await new Promise(r => setTimeout(r, 2000)); // Render wait
      const screenshot = await previewRef.current?.takeScreenshot();

      // B. Verifier / Supervisor Step
      setStatus(WorkflowStatus.CRITIQUING);
      
      let critique = "";
      if (latestRuntimeErrorRef.current) {
          critique = `CRITICAL RUNTIME ERROR: ${latestRuntimeErrorRef.current}. Fix this immediately.`;
          addLog(AgentType.SYSTEM, "Runtime error detected, prioritizing fix.", 'error');
          latestRuntimeErrorRef.current = null;
      } else {
          addLog(AgentType.VERIFIER, "Supervisor is reviewing the scene details...", 'info');
          
          // Update Verifier History Efficiently
          verifierHistory = manageVerifierHistory(verifierHistory, loopCode, screenshot);
          
          critique = await runGapFinder(verifierHistory);
          
          // Add Response to History
          verifierHistory.push({ role: 'model', parts: [{ text: critique }] });
          addLog(AgentType.VERIFIER, "Directives Issued", 'info', critique);
      }

      // Check if Deployable
      if (critique.includes("STATUS: DEPLOYABLE")) {
          addLog(AgentType.VERIFIER, "Scene approved for deployment!", 'success');
          break;
      }

      // Pass critique to Editor
      editorHistory.push({ 
          role: 'user', 
          parts: [{ text: `SUPERVISOR DIRECTIVES (Iteration ${iteration}):\n${critique}\n\nStart by creating a todo_list.` }] 
      });

      // C. Editor Loop
      setStatus(WorkflowStatus.EDITING);
      setActiveTab('plan'); 
      let editorActive = true;
      let editorSteps = 0;

      while (editorActive && editorSteps < 20) {
        editorSteps++;
        
        // --- STRICT TURN MANAGEMENT ---
        const lastMsg = editorHistory[editorHistory.length - 1];
        if (lastMsg.role === 'model') {
             editorHistory.push({ 
                 role: 'user', 
                 parts: [{ text: "Continue. Remember: You cannot verify until todos are done. Use take_screenshot to check your work." }] 
             });
        }
        
        const response = await runEditorStepRaw(editorHistory);
        const candidate = response.candidates?.[0];
        
        if (!candidate) break;

        // Log Thoughts
        let modelText = "";
        candidate.content.parts.forEach((p: any) => { if (p.text) modelText += p.text + "\n"; });
        if (modelText.trim()) addLog(AgentType.EDITOR, "Thinking...", 'thought', modelText);

        editorHistory.push({ role: 'model', parts: candidate.content.parts });

        // Handle Tools
        const toolCalls = candidate.content.parts.filter((p: any) => p.functionCall);
        
        if (toolCalls.length > 0) {
            const fc = toolCalls[0].functionCall;
            const args = fc.args;
            addLog(AgentType.EDITOR, `Calling: ${fc.name}`, 'tool_call', undefined, args);
            
            let resultMsg = "Tool executed.";
            let toolFailed = false;

            if (fc.name === 'multi_edit') {
                const res = applyMultiEdit(loopCode, args.operations || []);
                loopCode = res.newCode;
                resultMsg = res.msg;
                toolFailed = !res.success;
                if (res.success) {
                    saveCodeVersion(loopCode, `Iter ${iteration}.${editorSteps}`);
                    await new Promise(r => setTimeout(r, 500)); // Quick wait for reload
                }
            } 
            else if (fc.name === 'read_file') {
                const content = readFile(loopCode, args.start_line, args.end_line);
                resultMsg = `Lines ${args.start_line || 1}-${args.end_line || 'End'}:\n${content.slice(-5000)}`;
            } 
            else if (fc.name === 'todo_list') {
                if (args.clear) setEditorTodo([]);
                if (args.add_items) {
                    setEditorTodo(prev => [...prev, ...args.add_items.map((t: string) => ({ id: Math.random().toString(), text: t, status: 'pending' }))]);
                    resultMsg = `Added ${args.add_items.length} items.`;
                }
                if (args.update_items) {
                    // Update State locally
                    let currentTodos = [...editorTodo]; // We need to access current state in the loop, but state updates are async
                    // We can't easily access the updated state inside this async function without refs or simpler logic
                    // For now, we will trust the React setter function update pattern
                    setEditorTodo(prev => {
                        const next = [...prev];
                        args.update_items.forEach((u: any) => {
                            if (u.index >= 0 && u.index < next.length) next[u.index].status = u.status;
                        });
                        return next;
                    });
                    resultMsg = "Updated todo items.";
                }
            } 
            else if (fc.name === 'take_screenshot') {
                if (viewMode !== 'preview') setViewMode('preview');
                await new Promise(r => setTimeout(r, 2000));
                
                if (latestRuntimeErrorRef.current) {
                    resultMsg = `ERROR: Runtime Error prevents screenshot: ${latestRuntimeErrorRef.current}`;
                    toolFailed = true;
                    latestRuntimeErrorRef.current = null;
                } else {
                    const shot = await previewRef.current?.takeScreenshot();
                    if (shot) {
                        const artId = `shot-${Date.now()}`;
                        setArtifacts(prev => [{ id: artId, type: 'screenshot' as any, url: shot, description: `Editor Check ${iteration}.${editorSteps}`, agent: AgentType.EDITOR }, ...prev]);
                        
                        // Inject image into history specifically
                        editorHistory.push({
                            role: 'function',
                            parts: [{ functionResponse: { name: fc.name, response: { result: "Screenshot captured. See next message." } } }]
                        });
                        editorHistory.push({
                            role: 'user',
                            parts: [
                                { text: "Here is the visual result of your edit. Does it match your expectation?" },
                                { inlineData: { mimeType: 'image/png', data: shot } }
                            ]
                        });
                        continue; 
                    } else {
                        resultMsg = "Screenshot failed (Empty canvas).";
                        toolFailed = true;
                    }
                }
            } 
            else if (fc.name === 'verify_changes') {
                // GUARD: Check Todos
                // Note: We need the *latest* state. In a real app we'd use a Ref for synchronous access.
                // We will use a hacky check assuming the agent just updated it.
                // Better approach: Use a ref for todos or pass them through.
                // Since we can't change the hook structure easily now, let's assume strictness.
                
                // We'll perform the check based on what we *sent* to the UI, but inside this closure `editorTodo` might be stale.
                // Fix: Let's use the setState callback to check and throw.
                let hasPending = false;
                setEditorTodo(prev => {
                    hasPending = prev.some(t => t.status !== 'done');
                    return prev;
                });
                
                // Wait for the sync check
                await new Promise(r => setTimeout(r, 100));

                if (hasPending) {
                    resultMsg = "ACTION DENIED: You have 'pending' items in your todo list. Complete them and use 'take_screenshot' to verify them BEFORE calling verify_changes.";
                    toolFailed = true;
                    addLog(AgentType.SYSTEM, "Blocked Verify", 'warning', "Agent tried to verify with pending tasks.");
                } else {
                    editorActive = false; // Break the inner loop, go back to Verifier
                    resultMsg = "Submitting for verification.";
                }
            }

            editorHistory.push({
                role: 'function',
                parts: [{ functionResponse: { name: fc.name, response: { result: resultMsg, success: !toolFailed } } }]
            });
        }
      }
    }

    setStatus(WorkflowStatus.COMPLETED);
    addLog(AgentType.SYSTEM, "Refinement workflow completed.", 'success');
  };

  const getActiveCode = () => {
    if (viewingVersionId === null) return currentCode;
    const version = codeHistory.find(v => v.id === viewingVersionId);
    return version ? version.code : currentCode;
  };

  const getPreviousCode = () => {
      if (viewingVersionId === null && codeHistory.length > 1) {
          return codeHistory[1].code;
      }
      if (viewingVersionId !== null) {
          const idx = codeHistory.findIndex(v => v.id === viewingVersionId);
          if (idx !== -1 && idx < codeHistory.length - 1) {
              return codeHistory[idx + 1].code;
          }
      }
      return "";
  };

  const renderLogEntry = (log: LogEntry) => {
    if (log.type === 'thought') {
        return (
            <div className="pl-4 border-l-2 border-gray-700 my-2 italic text-gray-400">
               <span className="block text-[10px] uppercase font-bold text-gray-600 mb-1">Thought Process</span>
               {log.details || log.message}
            </div>
        );
    }
    if (log.type === 'tool_call') {
        return (
            <div className="bg-gray-800/50 rounded border border-gray-700 p-2 my-2 font-mono text-xs text-neon-blue">
                <div className="flex items-center gap-2 mb-1">
                    <Icons.Terminal /> 
                    <span className="font-bold">{log.message}</span>
                </div>
                {log.metadata && (
                    <pre className="text-gray-400 overflow-x-auto p-1 bg-black/30 rounded">
                        {JSON.stringify(log.metadata, null, 2)}
                    </pre>
                )}
            </div>
        );
    }
    return (
        <div className={`flex items-start gap-2 ${log.type === 'error' ? 'text-red-400' : 'text-gray-300'}`}>
            <span className={`font-bold mt-0.5 ${
                log.agent === AgentType.EDITOR ? 'text-neon-purple' :
                log.agent === AgentType.CODER ? 'text-blue-400' :
                log.agent === AgentType.VERIFIER ? 'text-yellow-400' :
                'text-gray-400'
            }`}>{log.agent}:</span>
            <div className="flex-1">
                 <div>{log.message}</div>
                 {log.details && (
                    <div className="mt-1 text-gray-500 text-xs bg-gray-900/50 p-1 rounded">
                         <button onClick={() => setSelectedLog(log)} className="underline hover:text-gray-300">View Full Output</button>
                    </div>
                 )}
            </div>
        </div>
    );
  };

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className="w-1/3 min-w-[400px] border-r border-gray-800 flex flex-col bg-gray-950 z-10 shadow-xl">
        <div className="p-6 border-b border-gray-800 bg-gray-900">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-neon-blue to-neon-purple bg-clip-text text-transparent mb-2">
            Voxel Architect
          </h1>
          <p className="text-gray-400 text-sm mb-4">
            Gemini 3 Pro High-Fidelity Refinement
          </p>

          {!originalImage ? (
            <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-700 border-dashed rounded-lg cursor-pointer hover:bg-gray-800 transition group">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <p className="text-sm text-gray-500 group-hover:text-neon-blue transition">Click to upload reference image</p>
              </div>
              <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
            </label>
          ) : (
            <div className="relative group">
              <img src={`data:image/png;base64,${originalImage}`} className="w-full h-48 object-cover rounded-md border border-gray-700" alt="Original" />
              <button 
                onClick={() => setOriginalImage(null)}
                className="absolute top-2 right-2 bg-red-600/90 text-white px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 transition hover:bg-red-500"
              >
                Reset Image
              </button>
            </div>
          )}

          {apiKeyMissing && (
             <div className="mt-4 p-2 bg-red-900/50 border border-red-500 rounded text-xs text-red-200">
               Missing API_KEY in environment.
             </div>
          )}

          {originalImage && status === WorkflowStatus.IDLE && (
            <button
              onClick={startWorkflow}
              className="mt-4 w-full bg-gradient-to-r from-neon-blue to-blue-600 text-black font-bold py-3 rounded-lg hover:brightness-110 transition flex items-center justify-center gap-2 shadow-lg shadow-neon-blue/20"
            >
              <Icons.Play /> Start Voxel Generation
            </button>
          )}
          
          {status !== WorkflowStatus.IDLE && (
              <div className="mt-4 flex items-center gap-2 text-neon-green text-sm font-mono animate-pulse bg-green-900/20 p-2 rounded border border-green-900/50 justify-center">
                  <div className="w-2 h-2 bg-neon-green rounded-full"></div>
                  {status}
              </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-800 bg-gray-900">
            <button 
                onClick={() => setActiveTab('logs')}
                className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${activeTab === 'logs' ? 'text-neon-blue border-b-2 border-neon-blue bg-gray-800/50' : 'text-gray-500 hover:text-gray-300'}`}
            >
                <div className="flex items-center justify-center gap-2">
                    <Icons.Terminal /> Console
                </div>
            </button>
            <button 
                onClick={() => setActiveTab('plan')}
                className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${activeTab === 'plan' ? 'text-neon-green border-b-2 border-neon-green bg-gray-800/50' : 'text-gray-500 hover:text-gray-300'}`}
            >
                <div className="flex items-center justify-center gap-2">
                    <Icons.List /> Plan ({editorTodo.filter(t => t.status !== 'done').length})
                </div>
            </button>
            <button 
                onClick={() => setActiveTab('versions')}
                className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${activeTab === 'versions' ? 'text-neon-purple border-b-2 border-neon-purple bg-gray-800/50' : 'text-gray-500 hover:text-gray-300'}`}
            >
                <div className="flex items-center justify-center gap-2">
                    <Icons.History /> History
                </div>
            </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-black scrollbar-thin scrollbar-thumb-gray-800 scrollbar-track-transparent">
          {activeTab === 'logs' && (
             <div className="p-4 space-y-4 font-mono text-xs">
                {logs.map((log) => (
                    <div key={log.id} className="border-b border-gray-900 pb-2 last:border-0">
                         {renderLogEntry(log)}
                    </div>
                ))}
             </div>
          )}

          {activeTab === 'plan' && (
             <div className="p-4 space-y-2">
                 {editorTodo.map((item, idx) => (
                     <div key={item.id} className={`p-3 rounded border flex items-start gap-2 ${
                         item.status === 'done' ? 'border-green-900 bg-green-900/10' :
                         'border-gray-800 bg-gray-900'
                     }`}>
                         <div className={`mt-0.5 w-3 h-3 rounded-full flex-shrink-0 ${
                             item.status === 'done' ? 'bg-green-500' :
                             item.status === 'in_progress' ? 'bg-blue-500 animate-pulse' :
                             'bg-gray-600'
                         }`} />
                         <div className="flex-1">
                             <div className={`text-xs ${item.status === 'done' ? 'text-gray-500 line-through' : 'text-gray-200'}`}>
                                 {item.text}
                             </div>
                             <div className="text-[10px] text-gray-500 uppercase mt-1">ID: {idx} • {item.status}</div>
                         </div>
                     </div>
                 ))}
             </div>
          )}

          {activeTab === 'versions' && (
              <div className="p-4 space-y-2">
                  {codeHistory.map((version, idx) => (
                      <button 
                        key={version.id}
                        onClick={() => {
                            setViewingVersionId(version.id);
                            setViewMode('preview');
                        }}
                        className={`w-full text-left p-3 rounded border text-xs transition ${
                            viewingVersionId === version.id 
                            ? 'border-neon-purple bg-neon-purple/10 text-white' 
                            : 'border-gray-800 hover:border-gray-600 text-gray-400'
                        }`}
                      >
                          <div className="flex justify-between mb-1">
                              <span className="font-bold text-neon-purple">v{codeHistory.length - idx}</span>
                              <span className="text-gray-600">{new Date(version.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <div className="truncate opacity-80">{version.description}</div>
                      </button>
                  ))}
              </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col relative h-full">
        {/* Controls */}
        <div className="absolute top-4 right-4 z-20 bg-gray-900 border border-gray-700 rounded-lg p-1 flex gap-1 shadow-xl">
             <button onClick={() => setViewMode('preview')} className={`p-2 rounded ${viewMode === 'preview' ? 'bg-gray-700' : 'text-gray-400'}`}><Icons.Eye /></button>
             <button onClick={() => setViewMode('code')} className={`p-2 rounded ${viewMode === 'code' ? 'bg-gray-700' : 'text-gray-400'}`}><Icons.Code /></button>
             <button onClick={() => setViewMode('diff')} className={`p-2 rounded ${viewMode === 'diff' ? 'bg-gray-700' : 'text-gray-400'}`}><Icons.Diff /></button>
        </div>

        {/* Viewport */}
        <div className="flex-1 bg-black relative p-4 flex flex-col gap-4 min-h-0">
          <div className="flex-1 relative rounded-xl overflow-hidden shadow-2xl border border-gray-800 bg-gray-950 min-h-0">
            {currentCode ? (
                <>
                    <div className={`w-full h-full ${viewMode === 'preview' ? 'block' : 'hidden'}`}>
                        <CodePreview 
                            ref={previewRef} 
                            code={getActiveCode()} 
                            onRuntimeError={handleRuntimeError}
                        />
                    </div>
                    {viewMode === 'code' && (
                        <div className="w-full h-full overflow-auto p-4 bg-[#0a0a0a] text-gray-300 font-mono text-xs">
                            <pre className="whitespace-pre-wrap">{getActiveCode()}</pre>
                        </div>
                    )}
                    {viewMode === 'diff' && (
                        <div className="w-full h-full p-2 bg-[#0a0a0a] overflow-hidden flex flex-col">
                            <div className="flex-1 overflow-auto">
                                <DiffViewer oldCode={getPreviousCode()} newCode={getActiveCode()} />
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-4">
                    <div className="w-16 h-16 border-4 border-gray-800 border-t-neon-blue rounded-full animate-spin"></div>
                    <p className="font-mono text-sm animate-pulse">Generating Voxel Code...</p>
                </div>
            )}
          </div>

          {/* Artifacts (Screenshots) */}
          <div className="h-40 border-t border-gray-800 pt-4 overflow-y-auto flex-shrink-0">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Visual History</h3>
              {artifacts.length > 0 ? (
                  <ArtifactGallery artifacts={artifacts} onSelect={setSelectedArtifact} />
              ) : (
                  <div className="text-xs text-gray-800 p-4 border border-dashed border-gray-800 rounded text-center">
                      Screenshots will appear here during refinement.
                  </div>
              )}
          </div>
        </div>

        {/* Modals (Log & Artifact) */}
        {selectedLog && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-8">
                <div className="w-full max-w-4xl h-[80vh] bg-gray-900 border border-gray-700 rounded-lg flex flex-col shadow-2xl">
                    <div className="flex items-center justify-between p-4 border-b border-gray-800 bg-gray-800/50">
                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                           <span className="text-neon-blue">{selectedLog.agent}</span> Output
                        </h2>
                        <button onClick={() => setSelectedLog(null)} className="text-gray-400 hover:text-white"><Icons.Close /></button>
                    </div>
                    <div className="flex-1 overflow-auto p-4 bg-black">
                        <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap">{selectedLog.details || selectedLog.message}</pre>
                    </div>
                </div>
            </div>
        )}
        {selectedArtifact && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-8 animate-in fade-in duration-200">
                <div className="relative max-w-full max-h-full">
                    <button onClick={() => setSelectedArtifact(null)} className="absolute -top-12 right-0 text-white hover:text-neon-blue transition"><Icons.Close /></button>
                    <img src={`data:image/png;base64,${selectedArtifact.url}`} alt={selectedArtifact.description} className="max-h-[85vh] max-w-[90vw] rounded-lg border border-gray-700 shadow-2xl" />
                    <div className="mt-4 text-center">
                        <span className="bg-gray-800 text-gray-200 px-3 py-1 rounded-full text-sm font-mono border border-gray-700">{selectedArtifact.description}</span>
                    </div>
                </div>
            </div>
        )}
      </div>
    </div>
  );
}
