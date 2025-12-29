
import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
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
    runEditorStepRaw,
    runEditorStepStreaming
} from './services/gemini';
import { applyMultiEdit, readFile, formatCodeWithLineNumbers } from './utils/editorTools';
import CodePreview, { CodePreviewHandle } from './components/CodePreview';
import DiffViewer from './components/DiffViewer';
import { ArtifactGallery } from './components/ArtifactGallery';
import { PROMPTS } from './constants';

// Icons from react-icons
import {
    HiPlay,
    HiCheck,
    HiSparkles,
    HiEye,
    HiCode,
    HiSwitchHorizontal,
    HiX,
    HiCog,
    HiPhotograph,
    HiChevronDown,
    HiCube,
    HiPencil,
    HiSearchCircle,
    HiTerminal
} from 'react-icons/hi';
import { VscTools } from 'react-icons/vsc';

// Agent display info with React icon components
const AgentInfo: Record<AgentType, { name: string; Icon: React.ComponentType<{ className?: string }>; color: string }> = {
    [AgentType.CODER]: { name: 'Voxel Architect', Icon: HiCube, color: 'text-violet-400' },
    [AgentType.EDITOR]: { name: 'Editor', Icon: HiPencil, color: 'text-amber-400' },
    [AgentType.VERIFIER]: { name: 'Supervisor', Icon: HiSearchCircle, color: 'text-cyan-400' },
    [AgentType.SYSTEM]: { name: 'System', Icon: HiTerminal, color: 'text-text-muted' },
};

type SidebarTab = 'activity' | 'plan' | 'history';
type ViewMode = 'preview' | 'code' | 'diff';

export default function App() {
    const [status, setStatus] = useState<WorkflowStatus>(WorkflowStatus.IDLE);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [originalImage, setOriginalImage] = useState<string | null>(null);
    const [artifacts, setArtifacts] = useState<GeneratedArtifact[]>([]);

    const [currentCode, setCurrentCode] = useState<string>("");
    const [codeHistory, setCodeHistory] = useState<CodeVersion[]>([]);
    const [viewingVersionId, setViewingVersionId] = useState<number | null>(null);

    const [editorTodo, setEditorTodo] = useState<TodoItem[]>([]);
    const editorTodoRef = useRef<TodoItem[]>([]);
    const [apiKeyMissing, setApiKeyMissing] = useState(false);
    const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
    const [selectedArtifact, setSelectedArtifact] = useState<GeneratedArtifact | null>(null);
    const [activeTab, setActiveTab] = useState<SidebarTab>('activity');
    const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

    const [viewMode, setViewMode] = useState<ViewMode>('preview');
    const [streamingThought, setStreamingThought] = useState<string>('');

    const previewRef = useRef<CodePreviewHandle>(null);
    const latestRuntimeErrorRef = useRef<string | null>(null);
    const isLoopingRef = useRef(false);
    const activityRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!process.env.API_KEY) {
            setApiKeyMissing(true);
        }
    }, []);

    // Keep ref in sync with state for synchronous access
    useEffect(() => {
        editorTodoRef.current = editorTodo;
    }, [editorTodo]);

    // Build todo context string for agent (no emojis)
    const buildTodoContextString = (todos: TodoItem[]): string => {
        if (todos.length === 0) {
            return "[TODO LIST] No tasks yet. Create a todo_list to plan your work.";
        }
        const lines = todos.map((t, i) => {
            const icon = t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]';
            return `  ${icon} ${i}: ${t.text}`;
        });
        const pending = todos.filter(t => t.status !== 'done').length;
        const done = todos.filter(t => t.status === 'done').length;
        return `[TODO LIST] ${done}/${todos.length} complete\n${lines.join('\n')}${pending > 0 ? `\n>> ${pending} pending - complete before verify_changes` : '\n>> All done - ready to verify'}`;
    };

    // Strip old context sections from history, keeping index 0 (initial) and last message (latest)
    const stripOldContextSections = (history: any[]): any[] => {
        return history.map((msg, idx) => {
            // Keep first message (initial HTML) and last message (latest HTML) as-is
            if (idx === 0 || idx === history.length - 1) return msg;
            if (msg.parts) {
                return {
                    ...msg,
                    parts: msg.parts.map((part: any) => {
                        if (part.text) {
                            let cleaned = part.text;
                            // Strip TODO LIST sections
                            cleaned = cleaned.replace(/\[TODO LIST\][\s\S]*?(?=\n\n|$)/g, '');
                            // Strip CURRENT HTML sections
                            cleaned = cleaned.replace(/\[CURRENT HTML - ALWAYS UP TO DATE\][\s\S]*?\[END CURRENT HTML\]/g, '');
                            // Strip INITIAL HTML sections (from intermediate messages if any)
                            cleaned = cleaned.replace(/\[INITIAL HTML - STARTING POINT\][\s\S]*?\[END INITIAL HTML\]/g, '');
                            // Strip Context Reminder notes
                            cleaned = cleaned.replace(/\[CONTEXT REMINDER\][\s\S]*?\[END CONTEXT REMINDER\]/g, '');
                            cleaned = cleaned.trim();
                            return { ...part, text: cleaned || 'OK' };
                        }
                        return part;
                    })
                };
            }
            return msg;
        });
    };

    const addLog = useCallback((agent: AgentType, message: string, type: LogEntry['type'] = 'info', details?: string, metadata?: any) => {
        setLogs(prev => [...prev, {
            id: Math.random().toString(36).substr(2, 9),
            timestamp: Date.now(),
            agent,
            message,
            type,
            details,
            metadata
        }]);
    }, []);

    const handleRuntimeError = useCallback((msg: string) => {
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
        setViewingVersionId(newVersion.id);
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const base64 = (evt.target?.result as string).split(',')[1];
                setOriginalImage(base64);
                addLog(AgentType.SYSTEM, "Reference image loaded", 'success');
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
            setActiveTab('activity');
            latestRuntimeErrorRef.current = null;
            isLoopingRef.current = true;

            setStatus(WorkflowStatus.CODING);
            addLog(AgentType.CODER, "Analyzing reference image...", 'info');

            const initialCode = await runCodeAgent(originalImage);

            saveCodeVersion(initialCode, "Initial Generation");
            addLog(AgentType.CODER, `Generated ${initialCode.split('\n').length} lines of code`, 'success', initialCode);

            setStatus(WorkflowStatus.RENDERING);
            await new Promise(r => setTimeout(r, 2000));

            await runRefinementLoop(originalImage, initialCode);

        } catch (err: any) {
            console.error(err);
            setStatus(WorkflowStatus.ERROR);
            addLog(AgentType.SYSTEM, `Error: ${err.message}`, 'error');
        }
    };

    const manageVerifierHistory = (history: any[], newCode: string, newScreenshot: string | null, newRecording: string | null) => {
        const newHistory = [...history];

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

        const newTurnParts: any[] = [
            { text: "Here is the latest code and visual state." },
            { text: newCode }
        ];
        if (newScreenshot) {
            newTurnParts.push({ text: "Latest Multi-Angle Screenshot:" });
            newTurnParts.push({ inlineData: { mimeType: 'image/png', data: newScreenshot } });
        } else {
            newTurnParts.push({ text: "Screenshot failed to capture (possible runtime error)." });
        }
        if (newRecording) {
            newTurnParts.push({ text: "Scene Recording (orbit view - watch for lighting, materials, and geometry from all angles):" });
            newTurnParts.push({ inlineData: { mimeType: 'video/webm', data: newRecording } });
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

        let editorHistory: any[] = [
            {
                role: 'user',
                parts: [
                    { text: PROMPTS.EDITOR_SYSTEM },
                    { text: "Original Reference Image:" },
                    { inlineData: { mimeType: 'image/png', data: originalImg } },
                    { text: `[INITIAL HTML - STARTING POINT]\n${formatCodeWithLineNumbers(startCode)}\n[END INITIAL HTML]\n\nThis is the INITIAL code you are starting with. The CURRENT/LATEST HTML will appear at the bottom of the conversation as you make edits.` }
                ]
            }
        ];

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
            addLog(AgentType.SYSTEM, `Refinement cycle ${iteration}`, 'info');

            if (viewMode !== 'preview') setViewMode('preview');
            await new Promise(r => setTimeout(r, 2000));

            // Capture screenshot and recording for supervisor review
            const screenshot = await previewRef.current?.takeScreenshot();
            addLog(AgentType.SYSTEM, "Capturing scene recording...", 'info');
            const recording = await previewRef.current?.recordScene();

            // Add recording to artifacts for UI
            if (recording) {
                const recId = `rec-supervisor-${iteration}-${Date.now()}`;
                setArtifacts(prev => [{
                    id: recId,
                    type: 'video',
                    url: recording,
                    mimeType: 'video/webm',
                    description: `Cycle ${iteration} Recording`,
                    agent: AgentType.VERIFIER
                }, ...prev]);
            }

            setStatus(WorkflowStatus.CRITIQUING);

            let critique = "";
            if (latestRuntimeErrorRef.current) {
                critique = `CRITICAL RUNTIME ERROR: ${latestRuntimeErrorRef.current}. Fix this immediately.`;
                addLog(AgentType.SYSTEM, "Runtime error detected", 'error');
                latestRuntimeErrorRef.current = null;
            } else {
                addLog(AgentType.VERIFIER, "Reviewing scene against reference...", 'info');

                verifierHistory = manageVerifierHistory(verifierHistory, loopCode, screenshot, recording);

                critique = await runGapFinder(verifierHistory);

                verifierHistory.push({ role: 'model', parts: [{ text: critique }] });
                addLog(AgentType.VERIFIER, "Analysis complete", 'info', critique);
            }

            if (critique.includes("STATUS: DEPLOYABLE")) {
                addLog(AgentType.VERIFIER, "Scene approved! Render matches reference.", 'success');
                break;
            }

            editorHistory.push({
                role: 'user',
                parts: [{ text: `SUPERVISOR DIRECTIVES (Iteration ${iteration}):\n${critique}\n\nStart by creating a todo_list.\n\n[CURRENT HTML - ALWAYS UP TO DATE]\n${formatCodeWithLineNumbers(loopCode)}\n[END CURRENT HTML]\n\n${buildTodoContextString(editorTodoRef.current)}` }]
            });

            setStatus(WorkflowStatus.EDITING);
            setActiveTab('plan');
            let editorActive = true;
            let editorSteps = 0;

            while (editorActive && editorSteps < 20) {
                editorSteps++;

                const lastMsg = editorHistory[editorHistory.length - 1];
                if (lastMsg.role === 'model') {
                    // Inject current HTML + todo list + reminder at the bottom of context
                    editorHistory.push({
                        role: 'user',
                        parts: [{ text: `Continue.\n\n[CURRENT HTML - ALWAYS UP TO DATE]\n${formatCodeWithLineNumbers(loopCode)}\n[END CURRENT HTML]\n\n${buildTodoContextString(editorTodoRef.current)}\n\n[CONTEXT REMINDER]\nThe current updated HTML above is the latest version rendered. Yes, this is the latest version of the file with your previous tool calls edits applied. Use read_file tool only if truly necessary, since the above file is literally the current latest version with your edits applied. Prefer concise large multi-operation edits. You cannot verify until all todos are done.\n[END CONTEXT REMINDER]` }]
                    });
                }

                // Strip old context sections to keep history clean - only latest HTML/todo/reminder visible
                editorHistory = stripOldContextSections(editorHistory);

                // Use streaming for real-time thought updates
                let modelText = "";
                let functionCall: any = null;
                let fullResponse: any = null;
                setStreamingThought('');  // Reset streaming state

                for await (const chunk of runEditorStepStreaming(editorHistory)) {
                    if (chunk.type === 'thought') {
                        modelText += chunk.content + "\n\n";
                        setStreamingThought(prev => prev + chunk.content + "\n\n");
                    } else if (chunk.type === 'text') {
                        modelText += chunk.content + "\n";
                        setStreamingThought(prev => prev + chunk.content + "\n");
                    } else if (chunk.type === 'functionCall') {
                        functionCall = chunk.content;
                    } else if (chunk.type === 'done') {
                        fullResponse = chunk.content;
                    }

                    // Auto-scroll activity panel
                    if (activityRef.current) {
                        activityRef.current.scrollTop = activityRef.current.scrollHeight;
                    }
                }

                // Clear streaming state and add to permanent log
                setStreamingThought('');
                if (modelText.trim()) addLog(AgentType.EDITOR, "Thinking...", 'thought', modelText);

                const candidate = fullResponse?.candidates?.[0];
                if (!candidate) break;

                editorHistory.push({ role: 'model', parts: candidate.content.parts });

                if (functionCall) {
                    const fc = functionCall;
                    const args = fc.args;
                    addLog(AgentType.EDITOR, `${fc.name}`, 'tool_call', undefined, args);

                    let resultMsg = "Tool executed.";
                    let toolFailed = false;

                    if (fc.name === 'multi_edit') {
                        const res = applyMultiEdit(loopCode, args.operations || []);
                        loopCode = res.newCode;
                        resultMsg = res.msg;
                        toolFailed = !res.success;
                        if (res.success) {
                            saveCodeVersion(loopCode, `Iter ${iteration}.${editorSteps}`);
                            resultMsg = `${res.msg}\n\nEdits applied successfully. ${args.operations?.length || 0} operations completed. Use read_file if you need to verify specific lines.`;
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }
                    else if (fc.name === 'read_file') {
                        const content = readFile(loopCode, args.start_line, args.end_line);
                        resultMsg = `Lines ${args.start_line || 1}-${args.end_line || 'End'}:\n${content.slice(-5000)}`;
                    }
                    else if (fc.name === 'todo_list') {
                        const parts: string[] = [];
                        if (args.clear) {
                            setEditorTodo([]);
                            editorTodoRef.current = [];
                            parts.push('Cleared');
                        }
                        if (args.add_items) {
                            const newItems = args.add_items.map((t: string) => ({ id: Math.random().toString(), text: t, status: 'pending' }));
                            setEditorTodo(prev => [...prev, ...newItems]);
                            editorTodoRef.current = [...editorTodoRef.current, ...newItems];
                            parts.push(`+${args.add_items.length} items`);
                        }
                        if (args.update_items) {
                            setEditorTodo(prev => {
                                const next = [...prev];
                                args.update_items.forEach((u: any) => {
                                    if (u.index >= 0 && u.index < next.length) next[u.index].status = u.status;
                                });
                                editorTodoRef.current = next;
                                return next;
                            });
                            parts.push(`Updated ${args.update_items.length}`);
                        }
                        resultMsg = `OK: ${parts.join(', ')}. ${buildTodoContextString(editorTodoRef.current)}`;
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
                            const recording = await previewRef.current?.recordScene();

                            if (shot) {
                                // Add screenshot artifact
                                const artId = `shot-${Date.now()}`;
                                setArtifacts(prev => [{ id: artId, type: 'screenshot', url: shot, mimeType: 'image/png', description: `Check ${iteration}.${editorSteps}`, agent: AgentType.EDITOR }, ...prev]);

                                // Add recording artifact if available
                                if (recording) {
                                    const recId = `rec-${Date.now()}`;
                                    setArtifacts(prev => [{ id: recId, type: 'video', url: recording, mimeType: 'video/webm', description: `Check ${iteration}.${editorSteps} Recording`, agent: AgentType.EDITOR }, ...prev]);
                                }

                                editorHistory.push({
                                    role: 'function',
                                    parts: [{ functionResponse: { name: fc.name, response: { result: "Screenshot and recording captured. See next message." } } }]
                                });

                                // Build message parts with both screenshot and recording
                                const visualParts: any[] = [
                                    { text: "Here is the visual result of your edit (screenshot + orbit recording). Does it match your expectation?" },
                                    { inlineData: { mimeType: 'image/png', data: shot } }
                                ];
                                if (recording) {
                                    visualParts.push({ inlineData: { mimeType: 'video/webm', data: recording } });
                                }

                                editorHistory.push({
                                    role: 'user',
                                    parts: visualParts
                                });
                                continue;
                            } else {
                                resultMsg = "Screenshot failed (Empty canvas).";
                                toolFailed = true;
                            }
                        }
                    }
                    else if (fc.name === 'verify_changes') {
                        const todos = editorTodoRef.current;
                        const pending = todos.filter(t => t.status !== 'done');

                        if (todos.length === 0) {
                            resultMsg = "DENIED: Create a todo_list first to plan your work.";
                            toolFailed = true;
                            addLog(AgentType.SYSTEM, "Blocked verify - no todo list", 'warning');
                        } else if (pending.length > 0) {
                            resultMsg = `DENIED: ${pending.length} tasks pending. Complete all todos first.\n${buildTodoContextString(todos)}`;
                            toolFailed = true;
                            addLog(AgentType.SYSTEM, "Blocked verify - pending tasks", 'warning');
                        } else {
                            editorActive = false;
                            resultMsg = "OK: All tasks complete. Submitting for verification.";
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
        addLog(AgentType.SYSTEM, "Refinement complete", 'success');
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

    const toggleLogExpand = (id: string) => {
        setExpandedLogs(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // Render a single log entry in conversation style
    const renderLogEntry = (log: LogEntry) => {
        const info = AgentInfo[log.agent];
        const isExpanded = expandedLogs.has(log.id);

        if (log.type === 'thought') {
            return (
                <div className="animate-fade-in">
                    <div className="flex items-start gap-3 mb-2">
                        <info.Icon className={`w-5 h-5 ${info.color}`} />
                        <div className="flex-1">
                            <div className={`text-sm font-medium ${info.color}`}>{info.name}</div>
                            <div className="text-xs text-text-muted">Chain of Thought</div>
                        </div>
                    </div>
                    <div
                        className="ml-9 p-4 bg-surface-2 rounded-lg border border-surface-4 max-h-[350px] overflow-y-auto scroll-smooth"
                        ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                    >
                        <div className="prose prose-sm prose-invert max-w-none text-text-secondary [&>p]:mb-3 [&>ul]:mb-3 [&>ol]:mb-3 [&>h1]:text-lg [&>h2]:text-base [&>h3]:text-sm [&>code]:bg-surface-3 [&>code]:px-1 [&>code]:rounded [&>pre]:bg-surface-3 [&>pre]:p-2 [&>pre]:rounded-lg [&>blockquote]:border-l-2 [&>blockquote]:border-accent [&>blockquote]:pl-3 [&>blockquote]:italic">
                            <ReactMarkdown>{log.details || log.message}</ReactMarkdown>
                        </div>
                    </div>
                </div>
            );
        }

        if (log.type === 'tool_call') {
            const opCount = log.metadata?.operations?.length;
            return (
                <div className="animate-fade-in ml-9">
                    <div className="flex items-center gap-2 p-2 bg-surface-2 rounded-lg border border-surface-4">
                        <VscTools className="w-4 h-4 text-amber-400" />
                        <span className="text-sm text-text-secondary font-mono">{log.message}</span>
                        {opCount && (
                            <span className="text-xs text-text-muted bg-surface-3 px-2 py-0.5 rounded-full">
                                {opCount} operations
                            </span>
                        )}
                        {log.metadata && (
                            <button
                                onClick={() => toggleLogExpand(log.id)}
                                className="ml-auto text-xs text-text-muted hover:text-text-secondary"
                            >
                                {isExpanded ? 'Hide' : 'Details'}
                            </button>
                        )}
                    </div>
                    {isExpanded && log.metadata && (
                        <div className="mt-2 p-3 bg-surface-1 rounded border border-surface-4 font-mono text-xs text-text-muted overflow-x-auto">
                            <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                        </div>
                    )}
                </div>
            );
        }

        // Regular message
        return (
            <div className="animate-fade-in">
                <div className="flex items-start gap-3">
                    <info.Icon className="w-5 h-5" />
                    <div className="flex-1">
                        <div className={`text-sm font-medium ${info.color}`}>{info.name}</div>
                        <div className={`text-sm mt-1 ${log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-emerald-400' : 'text-text-secondary'}`}>
                            {log.message}
                        </div>
                        {log.details && (
                            <button
                                onClick={() => setSelectedLog(log)}
                                className="mt-2 text-xs text-accent hover:text-accent-muted"
                            >
                                View full output →
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // Calculate todo progress
    const todoProgress = editorTodo.length > 0
        ? Math.round((editorTodo.filter(t => t.status === 'done').length / editorTodo.length) * 100)
        : 0;

    return (
        <div className="flex h-screen bg-surface-0 text-text-primary font-sans overflow-hidden">
            {/* Sidebar */}
            <div className="w-[420px] min-w-[380px] border-r border-surface-4 flex flex-col bg-surface-1">
                {/* Header */}
                <div className="p-5 border-b border-surface-4">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-10 h-10 rounded-xl bg-surface-3 flex items-center justify-center">
                            <HiSparkles className="w-5 h-5 text-accent" />
                        </div>
                        <div>
                            <h1 className="text-lg font-semibold text-text-primary">Voxel Architect</h1>
                            <p className="text-xs text-text-muted">AI-Powered Scene Generation</p>
                        </div>
                    </div>

                    {/* Image Upload */}
                    {!originalImage ? (
                        <label className="flex flex-col items-center justify-center w-full h-32 border border-dashed border-surface-4 rounded-xl cursor-pointer hover:bg-surface-2 hover:border-text-muted transition-all group">
                            <HiPhotograph className="w-8 h-8 text-text-muted group-hover:text-text-secondary mb-2" />
                            <p className="text-sm text-text-muted group-hover:text-text-secondary">Drop image or click to upload</p>
                            <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                        </label>
                    ) : (
                        <div className="relative group">
                            <img
                                src={`data:image/png;base64,${originalImage}`}
                                className="w-full h-36 object-cover rounded-xl border border-surface-4"
                                alt="Reference"
                            />
                            <button
                                onClick={() => setOriginalImage(null)}
                                className="absolute top-2 right-2 p-1.5 bg-surface-0/80 backdrop-blur rounded-lg text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <HiX className="w-4 h-4" />
                            </button>
                        </div>
                    )}

                    {apiKeyMissing && (
                        <div className="mt-3 p-3 bg-red-950/30 border border-red-900/50 rounded-lg text-xs text-red-400">
                            Missing API_KEY in environment
                        </div>
                    )}

                    {originalImage && status === WorkflowStatus.IDLE && (
                        <button
                            onClick={startWorkflow}
                            className="mt-4 w-full bg-accent hover:bg-accent-muted text-surface-0 font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                        >
                            <HiPlay className="w-4 h-4" />
                            Generate Voxel Scene
                        </button>
                    )}

                    {status !== WorkflowStatus.IDLE && (
                        <div className="mt-4 flex items-center gap-3 p-3 bg-surface-2 rounded-xl border border-surface-4">
                            <div className="w-2 h-2 bg-accent rounded-full animate-pulse-subtle" />
                            <span className="text-sm text-text-secondary">{status}</span>
                        </div>
                    )}
                </div>

                {/* Tabs */}
                <div className="flex border-b border-surface-4">
                    {[
                        { id: 'activity', label: 'Activity' },
                        { id: 'plan', label: `Plan${editorTodo.length > 0 ? ` (${editorTodo.filter(t => t.status !== 'done').length})` : ''}` },
                        { id: 'history', label: 'History' },
                    ].map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id as SidebarTab)}
                            className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === tab.id
                                ? 'text-text-primary border-b-2 border-accent'
                                : 'text-text-muted hover:text-text-secondary'
                                }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto">
                    {activeTab === 'activity' && (
                        <div ref={activityRef} className="p-4 space-y-4">
                            {logs.length === 0 && !streamingThought ? (
                                <div className="text-center py-12 text-text-muted text-sm">
                                    Activity will appear here once you start generation
                                </div>
                            ) : (
                                <>
                                    {logs.map((log) => (
                                        <div key={log.id} className="pb-4 border-b border-surface-3 last:border-0">
                                            {renderLogEntry(log)}
                                        </div>
                                    ))}
                                    {/* Streaming thought display - at bottom since newest is at bottom */}
                                    {streamingThought && (
                                        <div className="pb-4">
                                            <div className="flex items-start gap-3 mb-2">
                                                <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center">
                                                    <div className="w-2 h-2 bg-amber-500 rounded-full animate-ping" />
                                                </div>
                                                <div className="flex-1">
                                                    <div className="text-sm font-medium text-amber-400">Editor</div>
                                                    <div className="text-xs text-text-muted">Thinking...</div>
                                                </div>
                                            </div>
                                            <div
                                                className="ml-9 p-4 bg-surface-2 rounded-lg border border-amber-500/30 max-h-[350px] overflow-y-auto scroll-smooth"
                                                ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                                            >
                                                <div className="prose prose-sm prose-invert max-w-none text-text-secondary">
                                                    <ReactMarkdown>{streamingThought}</ReactMarkdown>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {activeTab === 'plan' && (
                        <div className="p-4">
                            {editorTodo.length > 0 && (
                                <div className="mb-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs text-text-muted">Progress</span>
                                        <span className="text-xs text-text-secondary">{todoProgress}%</span>
                                    </div>
                                    <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-accent transition-all duration-300 rounded-full"
                                            style={{ width: `${todoProgress}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="space-y-2">
                                {editorTodo.length === 0 ? (
                                    <div className="text-center py-12 text-text-muted text-sm">
                                        The Editor's task list will appear here
                                    </div>
                                ) : (
                                    editorTodo.map((item, idx) => (
                                        <div
                                            key={item.id}
                                            className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${item.status === 'done'
                                                ? 'bg-emerald-950/20 border-emerald-900/30'
                                                : item.status === 'in_progress'
                                                    ? 'bg-amber-950/20 border-amber-900/30'
                                                    : 'bg-surface-2 border-surface-4'
                                                }`}
                                        >
                                            <div className={`mt-0.5 w-5 h-5 rounded-md border-2 flex-shrink-0 flex items-center justify-center ${item.status === 'done'
                                                ? 'bg-emerald-500 border-emerald-500'
                                                : item.status === 'in_progress'
                                                    ? 'border-amber-500 animate-pulse'
                                                    : 'border-surface-4'
                                                }`}>
                                                {item.status === 'done' && <HiCheck className="w-3 h-3 text-white" />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`text-sm ${item.status === 'done' ? 'text-text-muted line-through' : 'text-text-secondary'}`}>
                                                    {item.text}
                                                </div>
                                                <div className="text-xs text-text-dim mt-1">#{idx + 1}</div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'history' && (
                        <div className="p-4 space-y-2">
                            {codeHistory.length === 0 ? (
                                <div className="text-center py-12 text-text-muted text-sm">
                                    Version history will appear here
                                </div>
                            ) : (
                                codeHistory.map((version, idx) => (
                                    <button
                                        key={version.id}
                                        onClick={() => {
                                            setViewingVersionId(version.id);
                                            setViewMode('preview');
                                        }}
                                        className={`w-full text-left p-3 rounded-lg border transition-all ${viewingVersionId === version.id
                                            ? 'border-accent bg-accent-subtle'
                                            : 'border-surface-4 hover:border-surface-3 bg-surface-2'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between mb-1">
                                            <span className={`text-sm font-medium ${viewingVersionId === version.id ? 'text-accent' : 'text-text-secondary'}`}>
                                                v{codeHistory.length - idx}
                                            </span>
                                            <span className="text-xs text-text-dim">
                                                {new Date(version.timestamp).toLocaleTimeString()}
                                            </span>
                                        </div>
                                        <div className="text-xs text-text-muted truncate">{version.description}</div>
                                    </button>
                                ))
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col relative h-full bg-surface-0">
                {/* View Mode Controls */}
                <div className="absolute top-4 right-4 z-20 flex bg-surface-2 rounded-lg border border-surface-4 p-1 gap-1">
                    {[
                        { mode: 'preview', icon: HiEye, label: 'Preview' },
                        { mode: 'code', icon: HiCode, label: 'Code' },
                        { mode: 'diff', icon: HiSwitchHorizontal, label: 'Diff' },
                    ].map(({ mode, icon: Icon, label }) => (
                        <button
                            key={mode}
                            onClick={() => setViewMode(mode as ViewMode)}
                            className={`p-2 rounded-md flex items-center gap-2 text-sm transition-colors ${viewMode === mode
                                ? 'bg-surface-3 text-text-primary'
                                : 'text-text-muted hover:text-text-secondary'
                                }`}
                            title={label}
                        >
                            <Icon className="w-4 h-4" />
                        </button>
                    ))}
                </div>

                {/* Viewport */}
                <div className="flex-1 p-4 flex flex-col gap-4 min-h-0">
                    <div className="flex-1 relative rounded-xl overflow-hidden border border-surface-4 bg-surface-1 min-h-0">
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
                                    <div className="w-full h-full overflow-auto p-4 bg-surface-1 font-mono text-sm">
                                        <pre className="text-text-secondary whitespace-pre-wrap leading-6">
                                            {getActiveCode().split('\n').map((line, i) => (
                                                <div key={i} className="flex hover:bg-surface-2">
                                                    <span className="w-12 flex-shrink-0 text-right pr-4 text-text-dim select-none">{i + 1}</span>
                                                    <span>{line || ' '}</span>
                                                </div>
                                            ))}
                                        </pre>
                                    </div>
                                )}
                                {viewMode === 'diff' && (
                                    <div className="w-full h-full">
                                        <DiffViewer oldCode={getPreviousCode()} newCode={getActiveCode()} />
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-4">
                                <div className="w-12 h-12 border-2 border-surface-4 border-t-accent rounded-full animate-spin" />
                                <p className="text-sm">Generating scene...</p>
                            </div>
                        )}
                    </div>

                    {/* Artifacts */}
                    <div className="h-36 border-t border-surface-4 pt-4 flex-shrink-0">
                        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Screenshots</h3>
                        {artifacts.length > 0 ? (
                            <ArtifactGallery artifacts={artifacts} onSelect={setSelectedArtifact} />
                        ) : (
                            <div className="text-sm text-text-dim p-4 border border-dashed border-surface-4 rounded-lg text-center">
                                Screenshots will appear here during refinement
                            </div>
                        )}
                    </div>
                </div>

                {/* Modals */}
                {selectedLog && (() => {
                    const SelectedIcon = AgentInfo[selectedLog.agent].Icon;
                    return (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/90 backdrop-blur-sm p-8">
                            <div className="w-full max-w-4xl h-[80vh] bg-surface-1 border border-surface-4 rounded-xl flex flex-col shadow-2xl">
                                <div className="flex items-center justify-between p-4 border-b border-surface-4">
                                    <div className="flex items-center gap-3">
                                        <SelectedIcon className="w-5 h-5" />
                                        <span className={`font-medium ${AgentInfo[selectedLog.agent].color}`}>
                                            {AgentInfo[selectedLog.agent].name}
                                        </span>
                                    </div>
                                    <button onClick={() => setSelectedLog(null)} className="p-2 text-text-muted hover:text-text-primary rounded-lg hover:bg-surface-3">
                                        <HiX className="w-5 h-5" />
                                    </button>
                                </div>
                                <div className="flex-1 overflow-auto p-4 bg-surface-0">
                                    <pre className="text-sm font-mono text-text-secondary whitespace-pre-wrap leading-6">
                                        {selectedLog.details || selectedLog.message}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {selectedArtifact && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/95 backdrop-blur-md p-8">
                        <div className="relative max-w-full max-h-full">
                            <button
                                onClick={() => setSelectedArtifact(null)}
                                className="absolute -top-12 right-0 p-2 text-text-muted hover:text-text-primary"
                            >
                                <HiX className="w-6 h-6" />
                            </button>
                            {selectedArtifact.type === 'video' ? (
                                <video
                                    src={`data:${selectedArtifact.mimeType || 'video/webm'};base64,${selectedArtifact.url}`}
                                    controls
                                    autoPlay
                                    loop
                                    className="max-h-[85vh] max-w-[90vw] rounded-xl border border-surface-4 shadow-2xl"
                                />
                            ) : (
                                <img
                                    src={`data:image/png;base64,${selectedArtifact.url}`}
                                    alt={selectedArtifact.description}
                                    className="max-h-[85vh] max-w-[90vw] rounded-xl border border-surface-4 shadow-2xl"
                                />
                            )}
                            <div className="mt-4 text-center">
                                <span className="bg-surface-2 text-text-secondary px-4 py-2 rounded-full text-sm border border-surface-4">
                                    {selectedArtifact.type === 'video' && '🎬 '}
                                    {selectedArtifact.description}
                                </span>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
