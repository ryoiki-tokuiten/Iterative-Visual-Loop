
import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import './app.css';
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
import { HistoryPanel } from './components/HistoryPanel';
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
    HiTerminal,
    HiClock
} from 'react-icons/hi';
import { VscTools } from 'react-icons/vsc';

// Agent display info with React icon components
const AgentInfo: Record<AgentType, { name: string; Icon: React.ComponentType<{ className?: string }>; color: string }> = {
    [AgentType.CODER]: { name: 'Voxel Architect', Icon: HiCube, color: 'text-violet-400' },
    [AgentType.EDITOR]: { name: 'Editor', Icon: HiPencil, color: 'text-amber-400' },
    [AgentType.VERIFIER]: { name: 'Supervisor', Icon: HiSearchCircle, color: 'text-cyan-400' },
    [AgentType.SYSTEM]: { name: 'System', Icon: HiTerminal, color: 'text-text-muted' },
};


type ViewMode = 'preview' | 'code' | 'diff';

export default function App() {
    const [status, setStatus] = useState<WorkflowStatus>(WorkflowStatus.IDLE);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [originalImage, setOriginalImage] = useState<string | null>(null);
    const [originalImageDims, setOriginalImageDims] = useState<{ width: number; height: number } | null>(null);
    const [artifacts, setArtifacts] = useState<GeneratedArtifact[]>([]);

    const [currentCode, setCurrentCode] = useState<string>("");
    const [codeHistory, setCodeHistory] = useState<CodeVersion[]>([]);
    const [viewingVersionId, setViewingVersionId] = useState<number | null>(null);

    const [editorTodo, setEditorTodo] = useState<TodoItem[]>([]);
    const editorTodoRef = useRef<TodoItem[]>([]);
    const [apiKeyMissing, setApiKeyMissing] = useState(false);
    const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
    const [selectedArtifact, setSelectedArtifact] = useState<GeneratedArtifact | null>(null);

    const [showHistory, setShowHistory] = useState(false);
    const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

    const [viewMode, setViewMode] = useState<ViewMode>('preview');
    const [streamingThought, setStreamingThought] = useState<string>('');
    const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);

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

    // Auto-scroll logic: scroll to bottom unless user scrolled up
    const handleActivityScroll = useCallback(() => {
        const el = activityRef.current;
        if (el) {
            const { scrollTop, scrollHeight, clientHeight } = el;
            const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) <= 2;
            setIsUserScrolledUp(!isAtBottom);
        }
    }, []);

    // Auto-scroll to bottom when logs change (unless user scrolled up)
    useEffect(() => {
        if (!isUserScrolledUp && activityRef.current) {
            const el = activityRef.current;
            el.scrollTop = el.scrollHeight;
        }
    }, [logs, streamingThought, isUserScrolledUp]);

    // Helper to get image dimensions from base64 string
    const getImgDims = (base64: string): Promise<{ width: number; height: number }> => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = (e) => reject(e);
            img.src = `data:image/png;base64,${base64}`;
        });
    };

    // Helper to crop a base64 image and return base64 cropped string
    const cropBase64Image = (base64Str: string, x1?: number, y1?: number, x2?: number, y2?: number): Promise<string> => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error("Failed to get 2d canvas context"));
                    return;
                }

                const width = img.naturalWidth;
                const height = img.naturalHeight;

                const rx1 = Math.max(0, x1 !== undefined ? x1 : 0);
                const ry1 = Math.max(0, y1 !== undefined ? y1 : 0);
                const rx2 = Math.min(width, x2 !== undefined ? x2 : width);
                const ry2 = Math.min(height, y2 !== undefined ? y2 : height);

                const cropW = rx2 - rx1;
                const cropH = ry2 - ry1;

                if (cropW <= 0 || cropH <= 0) {
                    reject(new Error(`Invalid crop dimensions: ${cropW}x${cropH}`));
                    return;
                }

                canvas.width = cropW;
                canvas.height = cropH;
                ctx.drawImage(img, rx1, ry1, cropW, cropH, 0, 0, cropW, cropH);
                resolve(canvas.toDataURL('image/png').split(',')[1]);
            };
            img.onerror = (e) => reject(e);
            img.src = `data:image/png;base64,${base64Str}`;
        });
    };

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
            setViewingVersionId(null);
            setShowHistory(false);
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

        const dims = await getImgDims(originalImg);

        let editorHistory: any[] = [
            {
                role: 'user',
                parts: [
                    { text: PROMPTS.EDITOR_SYSTEM },
                    { text: `Original Reference Image (Dimensions: ${dims.width}x${dims.height} pixels):` },
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
                        // Add snapshot of todos to log for rendering
                        args._todoSnapshot = [...editorTodoRef.current];
                    }
                    else if (fc.name === 'view_reference_image') {
                        try {
                            const dims = await getImgDims(originalImg);
                            const croppedBase64 = await cropBase64Image(originalImg, args.x1, args.y1, args.x2, args.y2);

                            const rx1 = args.x1 !== undefined ? args.x1 : 0;
                            const ry1 = args.y1 !== undefined ? args.y1 : 0;
                            const rx2 = args.x2 !== undefined ? args.x2 : dims.width;
                            const ry2 = args.y2 !== undefined ? args.y2 : dims.height;

                            resultMsg = `Reference image crop [${rx1}, ${ry1}] to [${rx2}, ${ry2}] retrieved successfully. Reference image size: ${dims.width}x${dims.height}.`;

                            // Save cropped base64 to metadata for rendering in UI log
                            args._croppedImage = croppedBase64;
                            args._cropCoords = { x1: rx1, y1: ry1, x2: rx2, y2: ry2, width: dims.width, height: dims.height };

                            // Send the cropped image as inline image back to Gemini
                            editorHistory.push({
                                role: 'function',
                                parts: [{ functionResponse: { name: fc.name, response: { result: resultMsg, success: true } } }]
                            });

                            editorHistory.push({
                                role: 'user',
                                parts: [
                                    { text: `Here is the requested reference image section [${rx1}, ${ry1}] to [${rx2}, ${ry2}]:` },
                                    { inlineData: { mimeType: 'image/png', data: croppedBase64 } }
                                ]
                            });
                            continue; // Skip standard function response pushing, we did it manually
                        } catch (err: any) {
                            resultMsg = `Failed to crop image: ${err.message}`;
                            toolFailed = true;
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
                <div className="message-card agent-message">
                    <div className="message-header">
                        <info.Icon className="message-icon\" />
                        <span className="message-role">{info.name}</span>
                        <span className="message-time">Chain of Thought</span>
                    </div>
                    <div
                        className="thought-card-content"
                        ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                    >
                        <ReactMarkdown>{log.details || log.message}</ReactMarkdown>
                    </div>
                </div>
            );
        }



        // Special rendering for todo_list tool calls in the stream
        if (log.type === 'tool_call' && log.message === 'todo_list' && log.metadata?._todoSnapshot) {
            const todos: TodoItem[] = log.metadata._todoSnapshot;
            const doneCount = todos.filter(t => t.status === 'done').length;
            const progress = todos.length > 0 ? Math.round((doneCount / todos.length) * 100) : 0;

            return (
                <div className="todo-plan-card">
                    <div className="todo-plan-header">
                        <VscTools className="tool-icon" />
                        <span>Updated Plan</span>
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.75rem' }}>{doneCount}/{todos.length}</span>
                            <div style={{ width: '4rem', height: '4px', background: 'rgba(var(--accent-yellow-rgb), 0.2)', borderRadius: '9999px', overflow: 'hidden' }}>
                                <div style={{ height: '100%', background: 'var(--accent-yellow)', width: `${progress}%` }} />
                            </div>
                        </div>
                    </div>
                    <div className="todo-plan-content">
                        {todos.map((item) => (
                            <div
                                key={item.id}
                                className={`todo-item ${item.status === 'done' ? 'done' : item.status === 'in_progress' ? 'in-progress' : 'pending'}`}
                            >
                                <div style={{
                                    width: '1rem', height: '1rem', borderRadius: '4px', border: '1px solid',
                                    borderColor: item.status === 'done' ? 'var(--accent-green)' : item.status === 'in_progress' ? 'var(--accent-yellow)' : 'var(--border-color)',
                                    background: item.status === 'done' ? 'var(--accent-green)' : 'transparent',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                                }}>
                                    {item.status === 'done' && <HiCheck style={{ width: '0.7rem', height: '0.7rem', color: 'white' }} />}
                                </div>
                                <span style={{ fontSize: '0.8rem', color: item.status === 'done' ? 'var(--text-tertiary-color)' : 'var(--text-secondary-color)', textDecoration: item.status === 'done' ? 'line-through' : 'none' }}>
                                    {item.text}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            );
        }

        // Special rendering for view_reference_image tool calls in the stream
        if (log.type === 'tool_call' && log.message === 'view_reference_image' && log.metadata?._croppedImage) {
            const coords = log.metadata._cropCoords;
            return (
                <div className="todo-plan-card">
                    <div className="todo-plan-header">
                        <VscTools className="tool-icon" />
                        <span>View Reference Image (Zoom)</span>
                        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', opacity: 0.8 }}>
                            {coords ? `[${coords.x1}, ${coords.y1}] to [${coords.x2}, ${coords.y2}]` : 'Full Image'}
                        </span>
                    </div>
                    <div className="p-3 bg-surface-1 border border-surface-3 rounded-lg mt-2 flex flex-col items-center">
                        <img 
                            src={`data:image/png;base64,${log.metadata._croppedImage}`} 
                            style={{ maxWidth: '100%', maxHeight: '300px', objectFit: 'contain', borderRadius: '8px' }} 
                            alt="Cropped Reference Section"
                        />
                        {coords && (
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary-color)', marginTop: '0.5rem' }}>
                                Natural size: {coords.width}x{coords.height} | Crop: {coords.x2 - coords.x1}x{coords.y2 - coords.y1} px
                            </span>
                        )}
                    </div>
                </div>
            );
        }

        if (log.type === 'tool_call') {
            const opCount = log.metadata?.operations?.length;
            return (
                <div className="tool-result">
                    <div className="tool-result-header">
                        <VscTools className="tool-icon" />
                        <span className="tool-name">{log.message}</span>
                        {opCount && (
                            <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>
                                ({opCount} operations)
                            </span>
                        )}
                        {log.metadata && (
                            <button
                                onClick={() => toggleLogExpand(log.id)}
                                style={{ marginLeft: 'auto', fontSize: '0.75rem', background: 'none', border: 'none', color: 'var(--text-secondary-color)', cursor: 'pointer' }}
                            >
                                {isExpanded ? 'Hide' : 'Details'}
                            </button>
                        )}
                    </div>
                    {isExpanded && log.metadata && (
                        <div className="tool-result-content">
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(log.metadata, null, 2)}</pre>
                        </div>
                    )}
                </div>
            );
        }

        // Regular message
        const messageClass = log.type === 'error' ? 'message-card system-error'
            : log.type === 'success' ? 'message-card system-message'
                : 'message-card';

        return (
            <div className={messageClass}>
                <div className="message-header">
                    <info.Icon className="message-icon" />
                    <span className="message-role">{info.name}</span>
                </div>
                <div className="message-content">
                    {log.message}
                </div>
                {log.details && (
                    <button
                        onClick={() => setSelectedLog(log)}
                        style={{ marginTop: '0.5rem', fontSize: '0.75rem', background: 'none', border: 'none', color: 'var(--accent-blue)', cursor: 'pointer' }}
                    >
                        View full output →
                    </button>
                )}
            </div>
        );
    };

    // Calculate todo progress
    const todoProgress = editorTodo.length > 0
        ? Math.round((editorTodo.filter(t => t.status === 'done').length / editorTodo.length) * 100)
        : 0;

    return (
        <div className="app-container">
            {/* Sidebar */}
            <div className="sidebar-panel">
                {/* Header */}
                <div className="sidebar-header">
                    <div className="sidebar-header-title">
                        <div className="sidebar-header-icon">
                            <HiSparkles className="w-5 h-5" />
                        </div>
                        <div>
                            <h1>Iterative Visual Refinements</h1>
                            <p>AI-Powered Scene Generation</p>
                        </div>
                    </div>

                    {/* Image Upload */}
                    {!originalImage ? (
                        <label className="upload-area">
                            <HiPhotograph className="w-8 h-8 upload-area-icon" />
                            <p className="upload-area-text">Drop image or click to upload</p>
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
                            className="btn-primary"
                        >
                            <HiPlay className="w-4 h-4" />
                            Generate Voxel Scene
                        </button>
                    )}

                    {status !== WorkflowStatus.IDLE && (
                        <div className="status-badge">
                            <div className="status-dot" />
                            <span className="status-text">{status}</span>
                        </div>
                    )}
                </div>

                {/* Activity Stream (Single View) - Inside Sidebar */}
                <div className="flex-1 overflow-y-auto activity-messages-container" ref={activityRef} onScroll={handleActivityScroll}>
                    <div className="p-4 space-y-3">
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
                                {/* Streaming thought display */}
                                {streamingThought && (
                                    <div className="thought-card">
                                        <div className="thought-card-header">
                                            <div className="pulse-dot" />
                                            <span className="title">Editor</span>
                                            <span className="subtitle">Thinking...</span>
                                        </div>
                                        <div
                                            className="thought-card-content"
                                            ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                                        >
                                            <ReactMarkdown>{streamingThought}</ReactMarkdown>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="main-panel">

                {/* History Button (Top Right) */}
                <div className="main-panel-controls">
                    <button
                        onClick={() => setShowHistory(true)}
                        className="btn-control"
                    >
                        <HiClock className="w-4 h-4" />
                        History
                    </button>

                    <div className="btn-group">
                        {[
                            { mode: 'preview', icon: HiEye, label: 'Preview' },
                            { mode: 'code', icon: HiCode, label: 'Code' },
                            { mode: 'diff', icon: HiSwitchHorizontal, label: 'Diff' },
                        ].map(({ mode, icon: Icon, label }) => (
                            <button
                                key={mode}
                                onClick={() => setViewMode(mode as ViewMode)}
                                className={`btn-control ${viewMode === mode ? 'active' : ''}`}
                                title={label}
                            >
                                <Icon className="w-4 h-4" />
                            </button>
                        ))}
                    </div>
                </div>

                {/* History Floating Panel */}
                {
                    showHistory && (
                        <HistoryPanel
                            history={codeHistory}
                            currentVersionId={viewingVersionId}
                            onSelect={(id) => {
                                setViewingVersionId(id);
                                setViewMode('preview');
                            }}
                            onClose={() => setShowHistory(false)}
                        />
                    )
                }

                {/* Viewport */}
                <div className="viewport">
                    <div className="viewport-main">
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
                {
                    selectedLog && (() => {
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
                    })()
                }

                {
                    selectedArtifact && (
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
                    )
                }
            </div>
        </div>
    );
}
