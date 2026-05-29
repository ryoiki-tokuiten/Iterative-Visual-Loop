
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
      diffViewerBackground: '#0f0f13',
      diffViewerColor: '#a1aab5',
      addedBackground: 'rgba(0, 229, 153, 0.08)',
      addedColor: '#00e599',
      removedBackground: 'rgba(255, 51, 102, 0.08)',
      removedColor: '#ff3366',
      wordAddedBackground: 'rgba(0, 229, 153, 0.22)',
      wordRemovedBackground: 'rgba(255, 51, 102, 0.22)',
      addedGutterBackground: 'rgba(0, 229, 153, 0.12)',
      removedGutterBackground: 'rgba(255, 51, 102, 0.12)',
      gutterBackground: '#121217',
      gutterBackgroundDark: '#0f0f13',
      highlightBackground: '#22222a',
      highlightGutterBackground: '#2d2d38',
      codeFoldGutterBackground: '#121217',
      codeFoldBackground: '#22222a',
      emptyLineBackground: '#0f0f13',
      gutterColor: '#64748b',
      addedGutterColor: '#00e599',
      removedGutterColor: '#ff3366',
      codeFoldContentColor: '#a1aab5',
      diffViewerTitleBackground: '#121217',
      diffViewerTitleColor: '#e2e8f0',
      diffViewerTitleBorderColor: '#22222a',
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
