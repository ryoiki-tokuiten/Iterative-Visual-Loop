


import React, { useRef, useEffect, useImperativeHandle, forwardRef, useState } from 'react';
import html2canvas from 'html2canvas';

interface CodePreviewProps {
  code: string;
  onRuntimeError?: (error: string) => void;
  onConsoleLog?: (message: string) => void;
}

export interface CodePreviewHandle {
  takeScreenshot: () => Promise<string | null>;
}

const CodePreview = forwardRef<CodePreviewHandle, CodePreviewProps>(({ code, onRuntimeError, onConsoleLog }, ref) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Inject error capturing script
  const enhancedCode = React.useMemo(() => {
    // We insert a script at the very top to catch load errors and unhandled promise rejections
    const errorScript = `
      <script>
        window.onerror = function(message, source, lineno, colno, error) {
          window.parent.postMessage({ type: 'iframe-error', message: message, lineno: lineno }, '*');
        };
        window.onunhandledrejection = function(event) {
          window.parent.postMessage({ type: 'iframe-error', message: 'Unhandled Rejection: ' + (event.reason ? event.reason.toString() : 'Unknown'), lineno: 0 }, '*');
        };
        // Capture console.error as well
        const originalError = console.error;
        console.error = function(...args) {
            window.parent.postMessage({ type: 'iframe-console-error', message: args.join(' ') }, '*');
            originalError.apply(console, args);
        };
      </script>
    `;
    // Try to insert after <head> or <html>, or just prepend
    if (code.includes('<head>')) {
      return code.replace('<head>', `<head>${errorScript}`);
    } else {
      return `${errorScript}${code}`;
    }
  }, [code]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'iframe-error') {
        const msg = `Runtime Error at line ${event.data.lineno}: ${event.data.message}`;
        if (onRuntimeError) onRuntimeError(msg);
      }
      if (event.data?.type === 'iframe-console-error') {
        if (onConsoleLog) onConsoleLog(`[Console Error]: ${event.data.message}`);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onRuntimeError, onConsoleLog]);

  // Helper to capture a single frame from the Three.js canvas
  const captureFrame = async (doc: Document, win: any): Promise<HTMLCanvasElement | null> => {
    const canvas = doc.querySelector('canvas');
    if (!canvas) {
      console.warn('No canvas found in document');
      return null;
    }

    try {
      // Force a render if we have access to scene/camera/renderer
      if (win?.scene && win?.camera && win?.renderer) {
        win.renderer.render(win.scene, win.camera);
      }

      // Wait for the frame to actually be drawn
      await new Promise(resolve => requestAnimationFrame(resolve));

      // Create a temporary canvas to copy the content
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const ctx = tempCanvas.getContext('2d');
      if (!ctx) return null;

      // Draw the WebGL canvas content
      ctx.drawImage(canvas, 0, 0);
      return tempCanvas;
    } catch (e) {
      console.error('Frame capture failed:', e);
      return null;
    }
  };

  useImperativeHandle(ref, () => ({
    takeScreenshot: async () => {
      if (!iframeRef.current || !iframeRef.current.contentDocument?.body) {
        console.error("No iframe content found");
        return null;
      }

      const win = iframeRef.current.contentWindow as any;
      const doc = iframeRef.current.contentDocument;

      // Wait for canvas to appear
      let attempts = 0;
      while (!doc.querySelector('canvas') && attempts < 10) {
        await new Promise(r => setTimeout(r, 200));
        attempts++;
      }

      // Check if we can perform a Smart Multi-Angle Capture
      // We look for 'window.camera' and 'window.inspectionViews' or just 'window.camera'
      if (win.camera && win.renderer) {
        try {
          const originalPos = win.camera.position.clone();
          const originalQuat = win.camera.quaternion.clone();

          // Define Views
          let views = [];
          if (win.inspectionViews && Array.isArray(win.inspectionViews) && win.inspectionViews.length > 0) {
            views = win.inspectionViews;
          } else {
            // Fallback Default Views if agent didn't define them
            views = [
              { label: "Original", restore: true }, // Special flag to use current view
              { position: [0, 50, 0], target: [0, 0, 0], label: "Top Down" },
              { position: [20, 20, 20], target: [0, 0, 0], label: "Iso View" }
            ];
          }

          // Limit to 4 views for a 2x2 grid
          const activeViews = views.slice(0, 4);
          const capturedCanvases: HTMLCanvasElement[] = [];

          for (const view of activeViews) {
            if (!view.restore) {
              // Set camera position and target
              if (view.position) win.camera.position.set(view.position[0], view.position[1], view.position[2]);
              if (view.target) win.camera.lookAt(view.target[0], view.target[1], view.target[2]);
              win.camera.updateProjectionMatrix();
              if (win.controls) {
                win.controls.target.set(view.target?.[0] || 0, view.target?.[1] || 0, view.target?.[2] || 0);
                win.controls.update();
              }
            }

            // Force render and wait for shadow maps to update
            if (win.scene && win.camera && win.renderer) {
              // Render twice to ensure shadow maps are computed
              win.renderer.render(win.scene, win.camera);
              await new Promise(r => setTimeout(r, 50));
              win.renderer.render(win.scene, win.camera);
            }

            // Wait for frame and then capture
            await new Promise(r => setTimeout(r, 100));
            const cap = await captureFrame(doc, win);
            if (cap) capturedCanvases.push(cap);
          }

          // Restore Camera
          win.camera.position.copy(originalPos);
          win.camera.quaternion.copy(originalQuat);
          if (win.controls) win.controls.update();
          if (win.scene) win.renderer.render(win.scene, win.camera);

          // Stitch into Grid
          if (capturedCanvases.length > 0) {
            const count = capturedCanvases.length;
            const cols = count === 1 ? 1 : 2;
            const rows = Math.ceil(count / 2);
            const w = capturedCanvases[0].width;
            const h = capturedCanvases[0].height;

            const gridCanvas = document.createElement('canvas');
            gridCanvas.width = w * cols;
            gridCanvas.height = h * rows;
            const ctx = gridCanvas.getContext('2d');

            if (ctx) {
              // Fill black
              ctx.fillStyle = "#000";
              ctx.fillRect(0, 0, gridCanvas.width, gridCanvas.height);

              capturedCanvases.forEach((c, idx) => {
                const r = Math.floor(idx / cols);
                const col = idx % cols;
                ctx.drawImage(c, col * w, r * h);

                // Draw Label
                ctx.fillStyle = "rgba(0,0,0,0.5)";
                ctx.fillRect(col * w, r * h, w, 24);
                ctx.fillStyle = "#00f3ff";
                ctx.font = "bold 16px monospace";
                ctx.fillText(activeViews[idx].label || `View ${idx}`, col * w + 10, r * h + 18);
              });

              return gridCanvas.toDataURL('image/png').split(',')[1];
            }
          }
        } catch (e) {
          console.warn("Smart capture failed, falling back to simple capture", e);
        }
      }

      // Fallback: Simple Single Screenshot
      const singleCap = await captureFrame(doc, win);
      if (singleCap) {
        return singleCap.toDataURL('image/png').split(',')[1];
      }

      // Fallback 2: html2canvas
      try {
        const capturedCanvas = await html2canvas(doc.body, {
          useCORS: true,
          allowTaint: true,
          logging: false,
          width: doc.documentElement.scrollWidth,
          height: doc.documentElement.scrollHeight,
          backgroundColor: '#000000',
        });
        return capturedCanvas.toDataURL('image/png').split(',')[1];
      } catch (e) {
        return null;
      }
    }
  }));

  return (
    <div className="w-full h-full bg-surface-0 rounded-lg overflow-hidden relative">
      <iframe
        ref={iframeRef}
        srcDoc={enhancedCode}
        title="Voxel Preview"
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    </div>
  );
});

export default CodePreview;