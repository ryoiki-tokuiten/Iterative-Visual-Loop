import React, { useRef } from 'react';
import Draggable from 'react-draggable';
import { HiX, HiClock } from 'react-icons/hi';
import { CodeVersion } from '../types';

interface HistoryPanelProps {
    history: CodeVersion[];
    currentVersionId: number | null;
    onSelect: (versionId: number) => void;
    onClose: () => void;
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
    history,
    currentVersionId,
    onSelect,
    onClose
}) => {
    const nodeRef = useRef<HTMLDivElement>(null);

    // Prevent click propagation to avoid closing if we were using a click-outside listener
    // (though in this implementation we aren't, per requirements)
    const handlePanelClick = (e: React.MouseEvent) => {
        e.stopPropagation();
    };

    return (
        <Draggable handle=".history-handle" bounds="body" nodeRef={nodeRef}>
            <div
                ref={nodeRef}
                className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-50 w-80 max-h-[600px] flex flex-col bg-surface-1 border border-surface-4 rounded-xl shadow-2xl overflow-hidden"
                onClick={handlePanelClick}
            >
                {/* Header - helper for dragging */}
                <div className="history-handle flex items-center justify-between p-3 bg-surface-2 border-b border-surface-4 cursor-move select-none">
                    <div className="flex items-center gap-2 text-text-primary font-medium">
                        <HiClock className="w-4 h-4 text-accent" />
                        <span>History</span>
                    </div>
                    {/* Close button - stop propagation to prevent drag start on click */}
                    <button
                        onClick={(e) => { e.stopPropagation(); onClose(); }}
                        className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors cursor-pointer"
                    >
                        <HiX className="w-4 h-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-surface-1">
                    {history.length === 0 ? (
                        <div className="text-center py-8 text-text-muted text-sm">
                            No history yet
                        </div>
                    ) : (
                        history.map((version, idx) => (
                            <button
                                key={version.id}
                                onClick={() => onSelect(version.id)}
                                className={`w-full text-left p-3 rounded-lg border transition-all ${currentVersionId === version.id
                                    ? 'border-accent bg-accent-subtle'
                                    : 'border-surface-4 hover:border-surface-3 bg-surface-2'
                                    }`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className={`text-sm font-medium ${currentVersionId === version.id ? 'text-accent' : 'text-text-secondary'
                                        }`}>
                                        v{history.length - idx}
                                    </span>
                                    <span className="text-xs text-text-dim">
                                        {new Date(version.timestamp).toLocaleTimeString()}
                                    </span>
                                </div>
                                <div className="text-xs text-text-muted truncate">
                                    {version.description}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>
        </Draggable>
    );
};
