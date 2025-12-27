
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
    const [apiKeyMissing, setApiKeyMissing] = useState(false);
    const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
    const [selectedArtifact, setSelectedArtifact] = useState<GeneratedArtifact | null>(null);
    const [activeTab, setActiveTab] = useState<SidebarTab>('activity');
    const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

    const [viewMode, setViewMode] = useState<ViewMode>('preview');

    const previewRef = useRef<CodePreviewHandle>(null);
    const latestRuntimeErrorRef = useRef<string | null>(null);
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

    const manageVerifierHistory = (history: any[], newCode: string, newScreenshot: string | null) => {
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
                    { text: `Current Code (WITH LINE NUMBERS - use these for insert_before / insert_after):\n\n${formatCodeWithLineNumbers(loopCode)}` },
                    { text: "Original Reference Image:" },
                    { inlineData: { mimeType: 'image/png', data: originalImg } }
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
            const screenshot = await previewRef.current?.takeScreenshot();

            setStatus(WorkflowStatus.CRITIQUING);

            let critique = "";
            if (latestRuntimeErrorRef.current) {
                critique = `CRITICAL RUNTIME ERROR: ${latestRuntimeErrorRef.current}. Fix this immediately.`;
                addLog(AgentType.SYSTEM, "Runtime error detected", 'error');
                latestRuntimeErrorRef.current = null;
            } else {
                addLog(AgentType.VERIFIER, "Reviewing scene against reference...", 'info');

                verifierHistory = manageVerifierHistory(verifierHistory, loopCode, screenshot);

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
                parts: [{ text: `SUPERVISOR DIRECTIVES (Iteration ${iteration}):\n${critique}\n\nStart by creating a todo_list.` }]
            });

            setStatus(WorkflowStatus.EDITING);
            setActiveTab('plan');
            let editorActive = true;
            let editorSteps = 0;

            while (editorActive && editorSteps < 20) {
                editorSteps++;

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

                let modelText = "";
                candidate.content.parts.forEach((p: any) => { if (p.text) modelText += p.text + "\n"; });
                if (modelText.trim()) addLog(AgentType.EDITOR, "Thinking...", 'thought', modelText);

                editorHistory.push({ role: 'model', parts: candidate.content.parts });

                const toolCalls = candidate.content.parts.filter((p: any) => p.functionCall);

                if (toolCalls.length > 0) {
                    const fc = toolCalls[0].functionCall;
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
                        if (args.clear) setEditorTodo([]);
                        if (args.add_items) {
                            setEditorTodo(prev => [...prev, ...args.add_items.map((t: string) => ({ id: Math.random().toString(), text: t, status: 'pending' }))]);
                            resultMsg = `Added ${args.add_items.length} items.`;
                        }
                        if (args.update_items) {
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
                                setArtifacts(prev => [{ id: artId, type: 'screenshot' as any, url: shot, description: `Check ${iteration}.${editorSteps}`, agent: AgentType.EDITOR }, ...prev]);

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
                        let hasPending = false;
                        setEditorTodo(prev => {
                            hasPending = prev.some(t => t.status !== 'done');
                            return prev;
                        });

                        await new Promise(r => setTimeout(r, 100));

                        if (hasPending) {
                            resultMsg = "ACTION DENIED: You have 'pending' items in your todo list. Complete them and use 'take_screenshot' to verify them BEFORE calling verify_changes.";
                            toolFailed = true;
                            addLog(AgentType.SYSTEM, "Blocked verify - pending tasks", 'warning');
                        } else {
                            editorActive = false;
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
                    <div className="ml-9 p-3 bg-surface-2 rounded-lg border border-surface-4 max-h-[400px] overflow-y-auto">
                        <pre className={`text-sm text-text-secondary leading-relaxed whitespace-pre-wrap font-sans ${!isExpanded && 'line-clamp-6'}`}>
                            {log.details || log.message}
                        </pre>
                        {log.details && log.details.length > 300 && (
                            <button
                                onClick={() => toggleLogExpand(log.id)}
                                className="mt-2 text-xs text-accent hover:text-accent-muted flex items-center gap-1"
                            >
                                {isExpanded ? 'Collapse' : 'Expand full response'}
                                <HiChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                            </button>
                        )}
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
                        <div className="p-4 space-y-4">
                            {logs.length === 0 ? (
                                <div className="text-center py-12 text-text-muted text-sm">
                                    Activity will appear here once you start generation
                                </div>
                            ) : (
                                logs.map((log) => (
                                    <div key={log.id} className="pb-4 border-b border-surface-3 last:border-0">
                                        {renderLogEntry(log)}
                                    </div>
                                ))
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
                            <img
                                src={`data:image/png;base64,${selectedArtifact.url}`}
                                alt={selectedArtifact.description}
                                className="max-h-[85vh] max-w-[90vw] rounded-xl border border-surface-4 shadow-2xl"
                            />
                            <div className="mt-4 text-center">
                                <span className="bg-surface-2 text-text-secondary px-4 py-2 rounded-full text-sm border border-surface-4">
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
