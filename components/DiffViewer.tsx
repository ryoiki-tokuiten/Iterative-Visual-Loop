
import React, { useMemo } from 'react';
import * as Diff from 'diff';

interface DiffViewerProps {
  oldCode: string;
  newCode: string;
}

const DiffViewer: React.FC<DiffViewerProps> = ({ oldCode, newCode }) => {
  const diffs = useMemo(() => {
    if (!oldCode) return [{ value: newCode, count: 0, added: false, removed: false }];
    // @ts-ignore - diff is loaded via importmap
    return Diff.diffLines(oldCode, newCode);
  }, [oldCode, newCode]);

  return (
    <div className="w-full h-full bg-[#111] overflow-auto font-mono text-xs p-4 rounded-lg border border-gray-800">
      {diffs.map((part: any, index: number) => {
        let bgColor = 'transparent';
        let textColor = '#aaa';
        let prefix = ' ';

        if (part.added) {
          bgColor = '#0f3a0f'; // Dark Green bg
          textColor = '#4ade80'; // Bright Green text
          prefix = '+';
        } else if (part.removed) {
          bgColor = '#3a0f0f'; // Dark Red bg
          textColor = '#f87171'; // Bright Red text
          prefix = '-';
        }

        // We split by newline to render line by line for better formatting
        const lines = part.value.replace(/\n$/, '').split('\n');

        return (
          <React.Fragment key={index}>
             {lines.map((line: string, i: number) => (
                <div 
                    key={`${index}-${i}`} 
                    style={{ backgroundColor: bgColor, color: textColor }}
                    className="whitespace-pre-wrap flex"
                >
                    <span className="w-6 inline-block text-center opacity-50 select-none">{prefix}</span>
                    <span className="flex-1">{line}</span>
                </div>
             ))}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default DiffViewer;
