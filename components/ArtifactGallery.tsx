

import React from 'react';
import { GeneratedArtifact } from '../types';

interface ArtifactGalleryProps {
  artifacts: GeneratedArtifact[];
  onSelect: (artifact: GeneratedArtifact) => void;
}

export const ArtifactGallery: React.FC<ArtifactGalleryProps> = ({ artifacts, onSelect }) => {
  if (artifacts.length === 0) return null;

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {artifacts.map((art) => (
        <div
          key={art.id}
          className="relative group flex-shrink-0 rounded-lg overflow-hidden border border-surface-4 cursor-pointer hover:border-accent transition-colors"
          onClick={() => onSelect(art)}
        >
          <img
            src={`data:image/png;base64,${art.url}`}
            alt={art.type}
            className="w-28 h-20 object-cover transition-transform group-hover:scale-105"
          />
          <div className="absolute bottom-0 left-0 right-0 bg-surface-0/90 backdrop-blur-sm px-2 py-1 text-[10px] text-text-secondary truncate">
            {art.description}
          </div>
        </div>
      ))}
    </div>
  );
};