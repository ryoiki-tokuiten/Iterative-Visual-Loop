

import React from 'react';
import { GeneratedArtifact } from '../types';

interface ArtifactGalleryProps {
  artifacts: GeneratedArtifact[];
  onSelect: (artifact: GeneratedArtifact) => void;
}

export const ArtifactGallery: React.FC<ArtifactGalleryProps> = ({ artifacts, onSelect }) => {
  if (artifacts.length === 0) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
      {artifacts.map((art) => (
        <div 
          key={art.id} 
          className="relative group rounded-lg overflow-hidden border border-gray-700 cursor-pointer"
          onClick={() => onSelect(art)}
        >
          <img 
            src={`data:image/png;base64,${art.url}`} 
            alt={art.type} 
            className="w-full h-32 object-cover transition-transform group-hover:scale-105"
          />
          <div className="absolute bottom-0 left-0 right-0 bg-black/80 p-2 text-xs text-white truncate">
            {art.description}
          </div>
          <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      ))}
    </div>
  );
};