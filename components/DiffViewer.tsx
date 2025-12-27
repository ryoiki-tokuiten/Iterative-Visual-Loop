
import React from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

interface DiffViewerProps {
  oldCode: string;
  newCode: string;
}

// Custom styles for the diff viewer
const diffStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#0f0f10',
      diffViewerColor: '#a1a1aa',
      addedBackground: 'rgba(16, 185, 129, 0.1)',
      addedColor: '#6ee7b7',
      removedBackground: 'rgba(239, 68, 68, 0.1)',
      removedColor: '#fca5a5',
      wordAddedBackground: 'rgba(16, 185, 129, 0.25)',
      wordRemovedBackground: 'rgba(239, 68, 68, 0.25)',
      addedGutterBackground: 'rgba(16, 185, 129, 0.15)',
      removedGutterBackground: 'rgba(239, 68, 68, 0.15)',
      gutterBackground: '#18181b',
      gutterBackgroundDark: '#0f0f10',
      highlightBackground: '#27272a',
      highlightGutterBackground: '#3f3f46',
      codeFoldGutterBackground: '#18181b',
      codeFoldBackground: '#27272a',
      emptyLineBackground: '#0f0f10',
      gutterColor: '#71717a',
      addedGutterColor: '#10b981',
      removedGutterColor: '#ef4444',
      codeFoldContentColor: '#a1a1aa',
      diffViewerTitleBackground: '#18181b',
      diffViewerTitleColor: '#fafafa',
      diffViewerTitleBorderColor: '#3f3f46',
    }
  },
  line: {
    padding: '4px 10px',
    '&:hover': {
      background: 'rgba(255, 255, 255, 0.03)',
    }
  },
  gutter: {
    minWidth: '40px',
    padding: '0 10px',
    '&:hover': {
      cursor: 'pointer',
    }
  },
  marker: {
    padding: '0 10px',
  },
  contentText: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '13px',
    lineHeight: '1.6',
  },
  content: {
    width: '100%',
  },
  wordDiff: {
    padding: '1px 4px',
    borderRadius: '3px',
  },
  codeFold: {
    fontSize: '12px',
  },
  codeFoldContent: {
    padding: '8px 12px',
  },
};

const DiffViewer: React.FC<DiffViewerProps> = ({ oldCode, newCode }) => {
  // If no old code, just show new code as all additions
  const oldValue = oldCode || '';
  const newValue = newCode || '';

  return (
    <div className="w-full h-full overflow-auto bg-surface-1 rounded-lg border border-surface-4">
      <ReactDiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={false}
        useDarkTheme={true}
        compareMethod={DiffMethod.WORDS}
        styles={diffStyles}
        showDiffOnly={false}
        extraLinesSurroundingDiff={3}
        hideLineNumbers={false}
        leftTitle="Previous Version"
        rightTitle="Current Version"
      />
    </div>
  );
};

export default DiffViewer;
