
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
    runEditorStepRaw,
    runEditorStepStreaming
} from './services/gemini';
import { applySearchAndReplace, readFile, formatCodeWithLineNumbers } from './utils/editorTools';
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
    const [activeTab, setActiveTab] = useState<'stream' | 'todos' | 'assets' | 'history'>('stream');
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
        return `[TODO LIST] ${done}/${todos.length} complete\n${lines.join('\n')}${pending > 0 ? `\n>> ${pending} pending - complete all before calling exit` : '\n>> All done - ready to exit'}`;
    };



    const addLog = useCallback((agent: AgentType, message: string, type: LogEntry['type'] = 'info', details?: string, metadata?: any) => {
        const id = Math.random().toString(36).substr(2, 9);
        setLogs(prev => [...prev, {
            id,
            timestamp: Date.now(),
            agent,
            message,
            type,
            details,
            metadata
        }]);
        return id;
    }, []);

    const updateLogMetadata = useCallback((id: string, updates: any) => {
        setLogs(prev => prev.map(log => {
            if (log.id === id) {
                return {
                    ...log,
                    metadata: {
                        ...log.metadata,
                        ...updates
                    }
                };
            }
            return log;
        }));
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
        // Clear previous runtime errors since a new version is loaded
        latestRuntimeErrorRef.current = null;
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


    const runRefinementLoop = async (
        originalImg: string,
        startCode: string
    ) => {
        let loopCode = startCode;
        let iteration = 0;
        const maxIterations = 20;
        let loopVerified = false;
        let loopProgressReport = "";
        let shouldResetHistory = false;

        const dims = await getImgDims(originalImg);

        // Upload initial reference image to sandbox
        try {
            await fetch('/api/save-media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: 'reference_image.png', base64: originalImg })
            });
        } catch (e) {
            console.error("Failed to save reference image to sandbox:", e);
        }

        // Set viewMode to preview and wait for compile/render before taking startup captures
        if (viewMode !== 'preview') setViewMode('preview');
        addLog(AgentType.SYSTEM, "Rendering initial generated scene and capturing startup assets...", 'info');
        await new Promise(r => setTimeout(r, 3000));

        // Capture startup screenshot and recording of current scene state
        const startupScreenshot = await previewRef.current?.takeScreenshot();
        const startupRecording = await previewRef.current?.recordScene();

        // Add startup recording to artifacts for UI
        if (startupRecording) {
            const recId = `rec-editor-startup-${Date.now()}`;
            setArtifacts(prev => [{
                id: recId,
                type: 'video',
                url: startupRecording,
                mimeType: 'video/webm',
                description: `Initial Scene Recording`,
                agent: AgentType.EDITOR
            }, ...prev]);
        }

        // Upload startup visual check files to python sandbox
        if (startupScreenshot) {
            try {
                await fetch('/api/save-media', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: 'screenshot_latest.png', base64: startupScreenshot })
                });
                await fetch('/api/save-media', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: `screenshot_iter_0.png`, base64: startupScreenshot })
                });
            } catch (e) {
                console.error("Failed to save startup screenshot to sandbox:", e);
            }
        }
        if (startupRecording) {
            try {
                await fetch('/api/save-media', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: 'recording_latest.webm', base64: startupRecording })
                });
                await fetch('/api/save-media', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: `recording_iter_0.webm`, base64: startupRecording })
                });
            } catch (e) {
                console.error("Failed to save startup recording to sandbox:", e);
            }
        }

        // Build starting parts including visual feedback from the beginning
        const initialParts: any[] = [
            { text: PROMPTS.EDITOR_SYSTEM },
            { text: `Original Reference Image (Dimensions: ${dims.width}x${dims.height} pixels):` },
            { inlineData: { mimeType: 'image/png', data: originalImg } },
            { text: `[INITIAL HTML - STARTING POINT]\n${formatCodeWithLineNumbers(startCode)}\n[END INITIAL HTML]\n\nThis is the INITIAL code you are starting with. You should keep track of the edits you apply, or read the current code using your read_file tool if you need to inspect the current state.` }
        ];

        if (startupScreenshot || startupRecording) {
            initialParts.push({ text: `\n[STARTUP VISUAL PREVIEW OF INITIAL GENERATED SCENE]\nHere is the initial rendered state of the scene before any refinement edits. Compare it closely with the Original Reference Image:` });
            if (startupScreenshot) {
                initialParts.push({ inlineData: { mimeType: 'image/png', data: startupScreenshot } });
            }
            if (startupRecording) {
                initialParts.push({ inlineData: { mimeType: 'video/webm', data: startupRecording } });
            }
        }

        let editorHistory: any[] = [
            {
                role: 'user',
                parts: initialParts
            }
        ];

        while (isLoopingRef.current) {
            try {
                iteration++;

                if (shouldResetHistory) {
                    addLog(AgentType.SYSTEM, "Iteration limit reached. Resetting history and starting next cycle...", 'info');

                    if (viewMode !== 'preview') setViewMode('preview');
                    await new Promise(r => setTimeout(r, 2000));

                    const shot = await previewRef.current?.takeScreenshot();
                    const recording = await previewRef.current?.recordScene();

                    if (shot) {
                        try {
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: 'screenshot_latest.png', base64: shot })
                            });
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: `screenshot_iter_${iteration}_final.png`, base64: shot })
                            });
                        } catch (e) {
                            console.error("Failed to save reset screenshot:", e);
                        }
                    }

                    if (recording) {
                        try {
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: 'recording_latest.webm', base64: recording })
                            });
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: `recording_iter_${iteration}_final.webm`, base64: recording })
                            });
                        } catch (e) {
                            console.error("Failed to save reset recording:", e);
                        }
                    }

                    const initialParts: any[] = [
                        { text: PROMPTS.EDITOR_SYSTEM },
                        { text: `Original Reference Image (Dimensions: ${dims.width}x${dims.height} pixels):` },
                        { inlineData: { mimeType: 'image/png', data: originalImg } },
                        { text: `[CURRENT HTML - STARTING POINT]\n${formatCodeWithLineNumbers(loopCode)}\n[END CURRENT HTML]\n\nThis is the CURRENT code you are starting with. You should keep track of the edits you apply, or read the current code using your read_file tool if you need to inspect the current state.` }
                    ];

                    if (shot) {
                        initialParts.push({ inlineData: { mimeType: 'image/png', data: shot } });
                    }
                    if (recording) {
                        initialParts.push({ inlineData: { mimeType: 'video/webm', data: recording } });
                    }

                    initialParts.push({
                        text: `[PROGRESS REPORT FROM PREVIOUS ITERATIONS]\n${loopProgressReport}`
                    });

                    initialParts.push({
                        text: `[CURRENT TODO LIST]\n${buildTodoContextString(editorTodoRef.current)}`
                    });

                    editorHistory = [
                        {
                            role: 'user',
                            parts: initialParts
                        }
                    ];

                    iteration = 0; // next outer loop cycle starts at 1
                    shouldResetHistory = false;
                    addLog(AgentType.SYSTEM, "History cleared and re-hydrated with progress report.", 'success');
                    continue;
                }

                addLog(AgentType.SYSTEM, `Refinement cycle ${iteration}`, 'info');

                // For subsequent iterations, capture the latest rendered state.
                // For cycle 1, visual context is already captured and hydrated in the initial history above.
                if (iteration > 1) {
                    if (viewMode !== 'preview') setViewMode('preview');
                    await new Promise(r => setTimeout(r, 2000));

                    // Capture screenshot and recording of current scene state
                    const screenshot = await previewRef.current?.takeScreenshot();
                    addLog(AgentType.SYSTEM, "Capturing scene recording...", 'info');
                    const recording = await previewRef.current?.recordScene();

                    // Add recording to artifacts for UI
                    if (recording) {
                        const recId = `rec-editor-cycle-${iteration}-${Date.now()}`;
                        setArtifacts(prev => [{
                            id: recId,
                            type: 'video',
                            url: recording,
                            mimeType: 'video/webm',
                            description: `Cycle ${iteration} Recording`,
                            agent: AgentType.EDITOR
                        }, ...prev]);
                    }

                    // Upload visual check files to python sandbox
                    if (screenshot) {
                        try {
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: 'screenshot_latest.png', base64: screenshot })
                            });
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: `screenshot_iter_${iteration}.png`, base64: screenshot })
                            });
                        } catch (e) {
                            console.error("Failed to save screenshot to sandbox:", e);
                        }
                    }
                    if (recording) {
                        try {
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: 'recording_latest.webm', base64: recording })
                            });
                            await fetch('/api/save-media', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: `recording_iter_${iteration}.webm`, base64: recording })
                            });
                        } catch (e) {
                            console.error("Failed to save recording to sandbox:", e);
                        }
                    }

                    let renderError = latestRuntimeErrorRef.current;
                    latestRuntimeErrorRef.current = null;

                    if (renderError) {
                        addLog(AgentType.SYSTEM, "Runtime error detected", 'error');
                        editorHistory.push({
                            role: 'user',
                            parts: [{ text: `[CRITICAL RUNTIME ERROR DETECTED ON STARTUP/RELOAD]\nYour last applied code has a critical runtime error:\n${renderError}\n\nFix this immediately before proceeding. Start by planning with todo_list.\n\n${buildTodoContextString(editorTodoRef.current)}` }]
                        });
                    } else {
                        const modelCallCount = editorHistory.filter(m => m.role === 'model').length;
                        const isWarning = modelCallCount >= 20;
                        addLog(AgentType.SYSTEM, isWarning ? "Providing context reset warning and visual render files to Editor..." : "Providing visual render files to Editor...", 'info');

                        const textContent = isWarning
                            ? `[SYSTEM NOTICE - CONTEXT OVERFLOW LIMIT REACHED]\n` +
                              `You have reached the limit of ${maxIterations} refinement iterations. To prevent context overflow, you must now call the 'progress_so_far' tool to submit your transition report and clear the history. No further edits will be committed until the progress report is submitted.\n\n` +
                              `Compare the latest screenshot and orbit video recording below closely to the original Reference Image to compile your report. Your report MUST cover:\n` +
                              `1) What was previously in the "progress so far" report (if any),\n` +
                              `2) What you have done,\n` +
                              `3) What is remaining,\n` +
                              `4) Exactly what you were going to do next.\n\n` +
                              `Once you call 'progress_so_far', the system will reset the history, capture the latest screenshot/recording, and carry over this report and the current todo list to the next cycle.\n\n` +
                              `${buildTodoContextString(editorTodoRef.current)}`
                            : `[VISUAL FEEDBACK - Refinement Cycle ${iteration}]\nHere is the latest rendered screenshot and 15-second orbit video recording of your scene.\nCompare it closely to the original Reference Image and use your Python visual sandbox tools to crop, zoom, and inspect discrepancies. Identify missing details, alignments, and object counts to refine the code further.\n\nStart by updating or creating your todo_list.\n\n${buildTodoContextString(editorTodoRef.current)}`;

                        const startMsgParts: any[] = [
                            { text: textContent }
                        ];
                        if (screenshot) {
                            startMsgParts.push({ inlineData: { mimeType: 'image/png', data: screenshot } });
                        }
                        if (recording) {
                            startMsgParts.push({ inlineData: { mimeType: 'video/webm', data: recording } });
                        }

                        editorHistory.push({
                            role: 'user',
                            parts: startMsgParts
                        });
                    }
                }

                setStatus(WorkflowStatus.EDITING);
                let editorActive = true;
                let editorSteps = 0;

                while (editorActive && editorSteps < 20) {
                    editorSteps++;

                    const lastMsg = editorHistory[editorHistory.length - 1];
                    if (lastMsg.role === 'model') {
                        const mCount = editorHistory.filter(m => m.role === 'model').length;
                        if (mCount >= 20) {
                            editorHistory.push({
                                role: 'user',
                                parts: [{ text: `[SYSTEM NOTICE - CONTEXT OVERFLOW LIMIT REACHED]\nYou must now call the 'progress_so_far' tool to submit your progress report. No further code edits can be applied.` }]
                            });
                        } else {
                            editorHistory.push({
                                role: 'user',
                                parts: [{ text: `Continue.` }]
                            });
                        }
                    }


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
                        const logId = addLog(AgentType.EDITOR, `${fc.name}`, 'tool_call', undefined, args);

                        let resultMsg = "Tool executed.";
                        let toolFailed = false;

                        if (fc.name === 'search_and_replace') {
                            const modelCallCount = editorHistory.filter(m => m.role === 'model').length;
                            if (modelCallCount >= 20) {
                                resultMsg = `ERROR: Iteration limit of 20 model calls has been reached. No further edits can be applied. You must call the 'progress_so_far' tool to submit your transition report and proceed to the next cycle.`;
                                toolFailed = true;
                            } else {
                                const res = applySearchAndReplace(loopCode, args.operations || []);
                                loopCode = res.newCode;
                                resultMsg = res.msg;
                                toolFailed = !res.success;
                                args._opResults = res.opResults || [];
                                if (res.success) {
                                    saveCodeVersion(loopCode, `Iter ${iteration}.${editorSteps}`);
                                    resultMsg = `${res.msg}\n\nEdits applied successfully. ${args.operations?.length || 0} operations completed.`;
                                    await new Promise(r => setTimeout(r, 500));
                                }
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
                        else if (fc.name === 'run_python_script') {
                            try {
                                const res = await fetch('/api/run-python', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ script: args.script })
                                });

                                if (!res.ok) {
                                    throw new Error(`HTTP error! status: ${res.status}`);
                                }

                                const runResult = await res.json();

                                // Construct tool response text
                                let textResult = `Python script executed ${runResult.success ? 'successfully' : 'with errors'}.\n`;
                                textResult += `Exit code: ${runResult.exitCode}\n\n`;
                                if (runResult.stdout) {
                                    textResult += `[STDOUT]\n${runResult.stdout}\n[END STDOUT]\n\n`;
                                }
                                if (runResult.stderr) {
                                    textResult += `[STDERR]\n${runResult.stderr}\n[END STDERR]\n\n`;
                                }
                                if (runResult.files && runResult.files.length > 0) {
                                    textResult += `Generated output files: ${runResult.files.map((f: any) => f.filename).join(', ')}`;
                                } else {
                                    textResult += `No output files generated.`;
                                }

                                resultMsg = textResult;
                                args.script = args.script; // Store script in args for rendering in UI log
                                args._runResult = runResult; // Store runResult in args for rendering in UI log

                                // Push the function response
                                editorHistory.push({
                                    role: 'function',
                                    parts: [{ functionResponse: { name: fc.name, response: { result: resultMsg, success: runResult.success } } }]
                                });
                                updateLogMetadata(logId, {
                                    _resultMsg: resultMsg,
                                    _success: runResult.success,
                                    _runResult: runResult
                                });

                                // If there are output files (images/videos), attach them to editorHistory as user role parts
                                if (runResult.files && runResult.files.length > 0) {
                                    const fileParts: any[] = [
                                        { text: `Here are the output files generated by the python script:` }
                                    ];
                                    for (const file of runResult.files) {
                                        fileParts.push({
                                            inlineData: {
                                                mimeType: file.mimeType,
                                                data: file.base64
                                            }
                                        });
                                    }
                                    editorHistory.push({
                                        role: 'user',
                                        parts: fileParts
                                    });
                                }
                                continue; // Skip standard function response pushing, we did it manually
                            } catch (err: any) {
                                resultMsg = `Failed to execute python script: ${err.message}`;
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
                                    // Upload screenshot to sandbox
                                    try {
                                        await fetch('/api/save-media', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ filename: `screenshot_latest.png`, base64: shot })
                                        });
                                        await fetch('/api/save-media', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ filename: `screenshot_iter_${iteration}.png`, base64: shot })
                                        });
                                    } catch (e) {
                                        console.error("Failed to save screenshot to sandbox:", e);
                                    }

                                    // Upload recording to sandbox if available
                                    if (recording) {
                                        try {
                                            await fetch('/api/save-media', {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ filename: `recording_latest.webm`, base64: recording })
                                            });
                                            await fetch('/api/save-media', {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ filename: `recording_iter_${iteration}.webm`, base64: recording })
                                            });
                                        } catch (e) {
                                            console.error("Failed to save recording to sandbox:", e);
                                        }
                                    }

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
                                    updateLogMetadata(logId, {
                                        _resultMsg: "Screenshot and recording captured.",
                                        _success: true,
                                        _screenshot: shot,
                                        _recording: recording
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
                        else if (fc.name === 'progress_so_far') {
                            const report = args.report || "";
                            loopProgressReport = report;
                            resultMsg = "Progress report received. System will reset history for the next cycle.";
                            shouldResetHistory = true;
                            editorActive = false;
                        }
                        else if (fc.name === 'exit') {
                            const todos = editorTodoRef.current;
                            const pending = todos.filter(t => t.status !== 'done');

                            if (todos.length === 0) {
                                resultMsg = "DENIED: You must create a todo_list and plan your work before exiting.";
                                toolFailed = true;
                                addLog(AgentType.SYSTEM, "Blocked exit - no todo list planned", 'warning');
                            } else if (pending.length > 0) {
                                resultMsg = `DENIED: You have ${pending.length} pending todo tasks that must be marked 'done' before exiting.\n${buildTodoContextString(todos)}`;
                                toolFailed = true;
                                addLog(AgentType.SYSTEM, "Blocked exit - pending todo tasks", 'warning');
                            } else if (latestRuntimeErrorRef.current) {
                                resultMsg = `DENIED: Your changes caused a critical compile or runtime error: ${latestRuntimeErrorRef.current}. You must fix this error before exiting.`;
                                toolFailed = true;
                                addLog(AgentType.SYSTEM, "Blocked exit - active runtime error", 'error');
                                latestRuntimeErrorRef.current = null; // Clear it after informing
                            } else {
                                editorActive = false;
                                loopVerified = true;
                                resultMsg = "OK: Exiting visual refinement loop. Workflow completed successfully!";
                                addLog(AgentType.SYSTEM, "Workflow completed and terminated via agent exit()", 'success');
                            }
                        }

                        editorHistory.push({
                            role: 'function',
                            parts: [{ functionResponse: { name: fc.name, response: { result: resultMsg, success: !toolFailed } } }]
                        });
                        updateLogMetadata(logId, {
                            _resultMsg: resultMsg,
                            _success: !toolFailed
                        });
                    }
                }

                if (loopVerified) {
                    addLog(AgentType.SYSTEM, "Refinement loop completed successfully!", 'success');
                    break;
                }
            } catch (err: any) {
                console.error("Error in refinement loop iteration:", err);
                addLog(AgentType.SYSTEM, `Refinement loop error: ${err.message || err}. Retrying in 10s...`, 'error');
                iteration = Math.max(0, iteration - 1);
                await new Promise(r => setTimeout(r, 10000));
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

        // Special rendering for search_and_replace tool calls in the stream
        if (log.type === 'tool_call' && log.message === 'search_and_replace') {
            const opResults: any[] = log.metadata?._opResults || [];
            const operations: any[] = log.metadata?.operations || [];
            
            // Map operations to results if results are not available yet (e.g. streaming or old logs)
            const displayOps = opResults.length > 0 ? opResults : operations.map(op => ({
                search_block: op.search_block,
                replace_block: op.replace_block,
                success: log.metadata?._resultMsg ? !log.metadata?._resultMsg.includes('failed') : true
            }));

            const doneCount = displayOps.filter(op => op.success).length;

            return (
                <div className="todo-plan-card" style={{ borderColor: 'rgba(var(--accent-blue-rgb), 0.3)', background: 'rgba(var(--accent-blue-rgb), 0.02)' }}>
                    <div className="todo-plan-header" style={{ color: 'var(--accent-blue)', background: 'rgba(var(--accent-blue-rgb), 0.08)', borderBottomColor: 'rgba(var(--accent-blue-rgb), 0.15)' }}>
                        <VscTools className="tool-icon" />
                        <span className="tool-name font-mono font-bold">Search & Replace Edits</span>
                        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', fontWeight: 'bold' }}>
                            {doneCount}/{displayOps.length} applied
                        </span>
                    </div>
                    <div className="p-3 bg-surface-1 border border-surface-3 rounded-lg mt-2 flex flex-col gap-3">
                        {displayOps.map((op, idx) => (
                            <details key={idx} className="w-full bg-surface-2 border border-surface-3 rounded-lg overflow-hidden">
                                <summary className="flex items-center gap-2 p-2.5 cursor-pointer select-none font-medium hover:bg-surface-3 transition-colors">
                                    {op.success ? (
                                        <HiCheck style={{ color: 'var(--accent-green)', width: '1rem', height: '1rem', flexShrink: 0 }} />
                                    ) : (
                                        <HiX style={{ color: 'var(--accent-red)', width: '1rem', height: '1rem', flexShrink: 0 }} />
                                    )}
                                    <span className="text-xs font-semibold">
                                        Edit #{idx + 1}
                                    </span>
                                    <span className={`text-[0.65rem] px-2 py-0.5 rounded-full font-bold ml-2`} style={{
                                        background: op.success ? 'rgba(52, 211, 153, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                        color: op.success ? 'var(--accent-green)' : 'var(--accent-red)'
                                    }}>
                                        {op.success ? 'Applied' : 'Failed'}
                                    </span>
                                    {!op.success && op.error && (
                                        <span className="text-[0.7rem] text-text-tertiary-color truncate ml-auto pr-2" style={{ color: 'var(--text-tertiary-color)' }}>
                                            {op.error}
                                        </span>
                                    )}
                                </summary>
                                <div className="p-3 bg-surface-1 border-t border-surface-3 text-xs font-mono flex flex-col gap-3">
                                    {op.search_block && (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[0.65rem] font-bold text-text-tertiary-color uppercase tracking-wider">Search Block (Find):</span>
                                            <pre className="p-2.5 rounded-md overflow-x-auto whitespace-pre leading-relaxed" style={{
                                                background: 'rgba(239, 68, 68, 0.04)',
                                                borderColor: 'rgba(239, 68, 68, 0.12)',
                                                border: '1px solid',
                                                color: '#fca5a5'
                                            }}>{op.search_block}</pre>
                                        </div>
                                    )}
                                    {op.replace_block !== undefined && (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[0.65rem] font-bold text-text-tertiary-color uppercase tracking-wider">Replace Block (Substitute):</span>
                                            <pre className="p-2.5 rounded-md overflow-x-auto whitespace-pre leading-relaxed" style={{
                                                background: 'rgba(52, 211, 153, 0.04)',
                                                borderColor: 'rgba(52, 211, 153, 0.12)',
                                                border: '1px solid',
                                                color: '#a7f3d0'
                                            }}>{op.replace_block}</pre>
                                        </div>
                                    )}
                                </div>
                            </details>
                        ))}
                    </div>
                </div>
            );
        }

        // Special rendering for progress_so_far tool calls in the stream
        if (log.type === 'tool_call' && log.message === 'progress_so_far') {
            const report = log.metadata?.report || "";
            return (
                <div className="todo-plan-card" style={{ borderColor: 'rgba(var(--accent-purple-rgb), 0.3)', background: 'rgba(var(--accent-purple-rgb), 0.02)' }}>
                    <div className="todo-plan-header" style={{ color: 'var(--accent-purple)', background: 'rgba(var(--accent-purple-rgb), 0.08)', borderBottomColor: 'rgba(var(--accent-purple-rgb), 0.15)' }}>
                        <VscTools className="tool-icon" />
                        <span className="tool-name font-mono font-bold">Progress Report Submitted</span>
                    </div>
                    <div className="p-4 bg-surface-1 border border-surface-3 rounded-lg mt-2 flex flex-col gap-2 max-h-[500px] overflow-y-auto leading-relaxed text-sm text-text-primary-color markdown-content">
                        <ReactMarkdown>{report}</ReactMarkdown>
                    </div>
                </div>
            );
        }

        // Special rendering for run_python_script tool calls in the stream
        if (log.type === 'tool_call' && log.message === 'run_python_script' && log.metadata?._runResult) {
            const result = log.metadata._runResult;
            return (
                <div className="todo-plan-card">
                    <div className="todo-plan-header">
                        <VscTools className="tool-icon" />
                        <span>Run Python Script</span>
                        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: result.success ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                            {result.success ? 'Success' : `Failed (Exit: ${result.exitCode})`}
                        </span>
                    </div>
                    <div className="p-3 bg-surface-1 border border-surface-3 rounded-lg mt-2 flex flex-col gap-2">
                        {/* Script code preview */}
                        <details className="w-full text-xs bg-black text-green-400 p-2 rounded-lg font-mono">
                            <summary className="cursor-pointer select-none font-bold text-gray-400">View Python Code</summary>
                            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{log.metadata.script}</pre>
                        </details>

                        {/* stdout/stderr */}
                        {result.stdout && (
                            <div className="w-full text-xs bg-surface-2 p-2 rounded-lg font-mono">
                                <div className="text-gray-400 font-bold mb-1">STDOUT:</div>
                                <pre className="overflow-x-auto whitespace-pre-wrap text-text-primary-color">{result.stdout}</pre>
                            </div>
                        )}
                        {result.stderr && (
                            <div className="w-full text-xs bg-surface-2 p-2 rounded-lg font-mono border border-red-500/20">
                                <div className="text-red-400 font-bold mb-1">STDERR:</div>
                                <pre className="overflow-x-auto whitespace-pre-wrap text-red-300">{result.stderr}</pre>
                            </div>
                        )}

                        {/* Output Files Render */}
                        {result.files && result.files.length > 0 && (
                            <div className="mt-2 flex flex-col gap-3 w-full">
                                <div className="text-xs font-bold text-gray-400">Generated Output Files:</div>
                                {result.files.map((file: any, idx: number) => {
                                    const isImage = file.mimeType.startsWith('image/');
                                    const isVideo = file.mimeType.startsWith('video/');
                                    return (
                                        <div key={idx} className="flex flex-col items-center p-2 bg-surface-2 rounded-lg border border-surface-3 w-full">
                                            <div className="text-xs text-gray-400 mb-1 font-mono">{file.filename} ({file.mimeType})</div>
                                            {isImage && (
                                                <img
                                                    src={`data:${file.mimeType};base64,${file.base64}`}
                                                    style={{ maxWidth: '100%', maxHeight: '300px', objectFit: 'contain', borderRadius: '8px' }}
                                                    alt={file.filename}
                                                />
                                            )}
                                            {isVideo && (
                                                <video
                                                    src={`data:${file.mimeType};base64,${file.base64}`}
                                                    controls
                                                    style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '8px' }}
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            );
        }

        if (log.type === 'tool_call') {
            const opCount = log.metadata?.operations?.length;
            const isCompleted = log.metadata?._resultMsg !== undefined;
            const isSuccess = log.metadata?._success;
            return (
                <div className="todo-plan-card" style={{ borderColor: 'rgba(var(--accent-blue-rgb), 0.3)', background: 'rgba(var(--accent-blue-rgb), 0.02)' }}>
                    <div className="todo-plan-header" style={{ color: 'var(--accent-blue)', background: 'rgba(var(--accent-blue-rgb), 0.08)', borderBottomColor: 'rgba(var(--accent-blue-rgb), 0.15)' }}>
                        <VscTools className="tool-icon" />
                        <span className="tool-name font-mono font-bold">{log.message}</span>
                        {opCount && (
                            <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>
                                ({opCount} operations)
                            </span>
                        )}
                        {isCompleted && (
                            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: isSuccess ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 'bold' }}>
                                {isSuccess ? 'Success' : 'Failed'}
                            </span>
                        )}
                        {log.metadata && (
                            <button
                                onClick={() => toggleLogExpand(log.id)}
                                style={{ marginLeft: isCompleted ? '0.5rem' : 'auto', fontSize: '0.75rem', background: 'none', border: 'none', color: 'var(--text-secondary-color)', cursor: 'pointer' }}
                            >
                                {isExpanded ? 'Hide Args' : 'View Args'}
                            </button>
                        )}
                    </div>

                    {isExpanded && log.metadata && (
                        <div className="p-3 bg-surface-1 border border-surface-3 rounded-lg m-2 text-xs font-mono text-text-secondary-color max-h-48 overflow-y-auto">
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                                {JSON.stringify(
                                    Object.keys(log.metadata)
                                        .filter(k => !k.startsWith('_') && k !== 'logId')
                                        .reduce((obj, key) => ({ ...obj, [key]: log.metadata[key] }), {}),
                                    null,
                                    2
                                )}
                            </pre>
                        </div>
                    )}

                    {isCompleted && log.metadata?._resultMsg && (
                        <div className="p-3 bg-surface-1/40 border-t border-surface-3 flex flex-col gap-3">
                            <div className="w-full text-xs bg-surface-2 p-2.5 rounded-lg font-mono border border-surface-3">
                                <div className="text-gray-400 font-bold mb-1.5 uppercase tracking-wider text-[0.65rem]">System Response Sent to LLM:</div>
                                <pre className="overflow-x-auto whitespace-pre-wrap text-text-primary-color leading-relaxed">{log.metadata._resultMsg}</pre>
                            </div>

                            {log.metadata._screenshot && (
                                <div className="flex flex-col items-center p-2 bg-surface-2 rounded-lg border border-surface-3 w-full">
                                    <div className="text-[0.65rem] text-gray-400 mb-1.5 font-mono uppercase tracking-wider">screenshot_latest.png (Render Viewport)</div>
                                    <img
                                        src={`data:image/png;base64,${log.metadata._screenshot}`}
                                        style={{ maxWidth: '100%', maxHeight: '240px', objectFit: 'contain', borderRadius: '6px' }}
                                        alt="Tool Output Screenshot"
                                    />
                                </div>
                            )}

                            {log.metadata._recording && (
                                <div className="flex flex-col items-center p-2 bg-surface-2 rounded-lg border border-surface-3 w-full">
                                    <div className="text-[0.65rem] text-gray-400 mb-1.5 font-mono uppercase tracking-wider">recording_latest.webm (Orbit Video)</div>
                                    <video
                                        src={`data:video/webm;base64,${log.metadata._recording}`}
                                        controls
                                        style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: '6px' }}
                                    />
                                </div>
                            )}
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
                    <div className="flex items-center justify-between mb-3">
                        <div className="sidebar-header-title">
                            <div className="sidebar-header-icon">
                                <HiSparkles className="w-5 h-5" />
                            </div>
                            <div>
                                <h1>Iterative Visual Studio</h1>
                                <p>Refining scenes to pixel-perfection</p>
                            </div>
                        </div>

                        {status !== WorkflowStatus.IDLE ? (
                            <div className="status-badge mt-0 py-1 px-2.5">
                                <div className="status-dot" />
                                <span className="status-text text-[10px]">{status}</span>
                            </div>
                        ) : (
                            <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-surface-3 bg-surface-2 text-[10px] text-text-secondary font-semibold">
                                <div className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                                <span>STANDBY</span>
                            </div>
                        )}
                    </div>

                    {/* Image Upload */}
                    {!originalImage ? (
                        <label className={`upload-area py-4 ${status !== WorkflowStatus.IDLE ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}`}>
                            <HiPhotograph className="w-6 h-6 upload-area-icon mb-1" />
                            <p className="upload-area-text text-xs">Upload reference image</p>
                            {status === WorkflowStatus.IDLE && (
                                <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                            )}
                        </label>
                    ) : (
                        <div className="relative group flex items-center gap-2 p-2 bg-surface-2 border border-surface-3 rounded-xl">
                            <img
                                src={`data:image/png;base64,${originalImage}`}
                                className="w-10 h-10 object-cover rounded-lg border border-surface-3"
                                alt="Reference"
                            />
                            <div className="flex-1 min-w-0">
                                <div className="text-[11px] font-semibold text-text-primary truncate">Reference Image</div>
                                {originalImageDims && (
                                    <div className="text-[9px] text-text-secondary font-mono">{originalImageDims.width}x{originalImageDims.height}px</div>
                                )}
                            </div>
                            {status === WorkflowStatus.IDLE && (
                                <button
                                    onClick={() => setOriginalImage(null)}
                                    className="p-1.5 bg-surface-3 hover:bg-surface-4 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
                                >
                                    <HiX className="w-3 h-3" />
                                </button>
                            )}
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
                            className="btn-primary mt-3 py-2.5"
                        >
                            <HiPlay className="w-4 h-4" />
                            Start Studio
                        </button>
                    )}
                </div>

                {/* Activity Stream (Single View) - Inside Sidebar */}
                <div className="flex-1 overflow-y-auto activity-messages-container" ref={activityRef} onScroll={handleActivityScroll}>
                    <div className="p-4 space-y-3">
                        {logs.length === 0 && !streamingThought ? (
                            <div className="text-center py-12 text-text-secondary text-sm">
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
            <div className="main-panel pattern-grid">

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
                        ) : status === WorkflowStatus.IDLE ? (
                            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-4 p-8">
                                <div className="p-4 bg-surface-2 rounded-2xl border border-surface-3 text-text-muted">
                                    <HiPhotograph className="w-12 h-12 text-accent opacity-40" />
                                </div>
                                <div className="text-center max-w-sm">
                                    <h3 className="text-sm font-semibold text-text-primary mb-1">No Active Scene</h3>
                                    <p className="text-xs text-text-secondary leading-relaxed">
                                        Upload a reference image on the left and start the refinement loop to reconstruct it as a 3D scene.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-4">
                                <div className="w-12 h-12 border-2 border-surface-3 border-t-accent rounded-full animate-spin" />
                                <p className="text-sm">Generating scene...</p>
                            </div>
                        )}
                    </div>

                    {/* Bottom Panels Grid */}
                    <div className="h-48 border-t border-surface-3 pt-4 flex-shrink-0 grid grid-cols-12 gap-4">
                        {/* Screenshots Column */}
                        <div className="col-span-6 flex flex-col h-full overflow-hidden">
                            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Screenshots</h3>
                            <div className="flex-1 overflow-y-auto">
                                {artifacts.length > 0 ? (
                                    <ArtifactGallery artifacts={artifacts} onSelect={setSelectedArtifact} />
                                ) : (
                                    <div className="text-sm text-text-secondary p-4 border border-dashed border-surface-3 rounded-lg text-center h-full flex items-center justify-center bg-surface-1/50">
                                        Screenshots will appear here during refinement
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* History & Mode Selection Column */}
                        <div className="col-span-6 flex flex-col h-full overflow-hidden border-l border-surface-3 pl-4">
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
                                    <HiClock className="w-3.5 h-3.5 text-accent" /> History
                                </h3>
                                {/* View mode selector integrated directly here */}
                                <div className="btn-group flex items-center p-0.5 bg-surface-2 rounded-lg border border-surface-3">
                                    {[
                                        { mode: 'preview', icon: HiEye, label: 'Preview' },
                                        { mode: 'code', icon: HiCode, label: 'Code' },
                                        { mode: 'diff', icon: HiSwitchHorizontal, label: 'Diff' },
                                    ].map(({ mode, icon: Icon, label }) => (
                                        <button
                                            key={mode}
                                            onClick={() => setViewMode(mode as ViewMode)}
                                            className={`p-1.5 rounded-md transition-colors ${viewMode === mode ? 'bg-accent/20 text-accent border border-accent/40' : 'text-text-secondary hover:text-text-primary'}`}
                                            title={label}
                                        >
                                            <Icon className="w-3.5 h-3.5" />
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {/* History list */}
                            <div className="flex-1 overflow-x-auto overflow-y-hidden flex gap-2 pb-1 items-stretch">
                                {codeHistory.length === 0 ? (
                                    <div className="text-sm text-text-secondary p-4 border border-dashed border-surface-3 rounded-lg text-center w-full flex items-center justify-center bg-surface-1/50">
                                        No history versions yet
                                    </div>
                                ) : (
                                    codeHistory.map((version, idx) => (
                                        <button
                                            key={version.id}
                                            onClick={() => {
                                                setViewingVersionId(version.id);
                                            }}
                                            className={`flex-shrink-0 w-32 p-2 rounded-lg border text-left flex flex-col justify-between transition-all ${viewingVersionId === version.id
                                                ? 'border-accent bg-accent/10 shadow-lg shadow-accent/5'
                                                : 'border-surface-3 hover:border-surface-4 bg-surface-2'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between w-full mb-1">
                                                <span className={`text-[10px] font-bold ${viewingVersionId === version.id ? 'text-accent' : 'text-text-primary'}`}>
                                                    v{codeHistory.length - idx}
                                                </span>
                                                <span className="text-[9px] text-text-secondary">
                                                    {new Date(version.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                                </span>
                                            </div>
                                            <div className="text-[10px] text-text-secondary line-clamp-2 leading-snug">
                                                {version.description}
                                            </div>
                                        </button>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Modals */}
                {
                    selectedLog && (() => {
                        const SelectedIcon = AgentInfo[selectedLog.agent].Icon;
                        return (
                            <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/90 backdrop-blur-sm p-8">
                                <div className="w-full max-w-4xl h-[80vh] bg-surface-1 border border-surface-3 rounded-xl flex flex-col shadow-2xl">
                                    <div className="flex items-center justify-between p-4 border-b border-surface-3">
                                        <div className="flex items-center gap-3">
                                            <SelectedIcon className="w-5 h-5" />
                                            <span className={`font-medium ${AgentInfo[selectedLog.agent].color}`}>
                                                {AgentInfo[selectedLog.agent].name}
                                            </span>
                                        </div>
                                        <button onClick={() => setSelectedLog(null)} className="p-2 text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-3">
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
                                    className="absolute -top-12 right-0 p-2 text-text-secondary hover:text-text-primary"
                                >
                                    <HiX className="w-6 h-6" />
                                </button>
                                {selectedArtifact.type === 'video' ? (
                                    <video
                                        src={`data:${selectedArtifact.mimeType || 'video/webm'};base64,${selectedArtifact.url}`}
                                        controls
                                        autoPlay
                                        loop
                                        className="max-h-[85vh] max-w-[90vw] rounded-xl border border-surface-3 shadow-2xl"
                                    />
                                ) : (
                                    <img
                                        src={`data:image/png;base64,${selectedArtifact.url}`}
                                        alt={selectedArtifact.description}
                                        className="max-h-[85vh] max-w-[90vw] rounded-xl border border-surface-3 shadow-2xl"
                                    />
                                )}
                                <div className="mt-4 text-center">
                                    <span className="bg-surface-2 text-text-secondary px-4 py-2 rounded-full text-sm border border-surface-3">
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
