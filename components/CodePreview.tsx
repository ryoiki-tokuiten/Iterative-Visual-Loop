


import React, { useRef, useEffect, useImperativeHandle, forwardRef, useState } from 'react';
import html2canvas from 'html2canvas';

interface CodePreviewProps {
  code: string;
  onRuntimeError?: (error: string) => void;
  onConsoleLog?: (message: string) => void;
}

export interface CodePreviewHandle {
  takeScreenshot: () => Promise<string | null>;
  recordScene: () => Promise<string | null>; // Returns base64 WebM
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
    },

    // Record a scene orbit video (15 seconds, 60 FPS, full 360° orbit)
    recordScene: async () => {
      if (!iframeRef.current || !iframeRef.current.contentDocument?.body) {
        console.error("No iframe content found for recording");
        return null;
      }

      const win = iframeRef.current.contentWindow as any;
      const doc = iframeRef.current.contentDocument;

      // Wait for canvas to appear with timeout
      let attempts = 0;
      const maxAttempts = 20;
      while (!doc.querySelector('canvas') && attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 200));
        attempts++;
      }

      const canvas = doc.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas) {
        console.error("No canvas found for recording after waiting");
        return null;
      }

      // Check if we have Three.js scene access
      if (!win.camera || !win.renderer || !win.scene) {
        console.warn("No Three.js scene access for recording - missing camera, renderer, or scene globals");
        return null;
      }

      let recorder: MediaRecorder | null = null;
      let animationFrameId: number | null = null;

      try {
        // Get stream from canvas at 60 FPS for smooth playback
        const stream = canvas.captureStream(60);

        // Try to use webm codec with best quality, fallback gracefully
        let mimeType = 'video/webm;codecs=vp9';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/webm;codecs=vp8';
        }
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/webm';
        }
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/mp4';
        }
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          console.error("No supported video mimeType found for MediaRecorder");
          return null;
        }

        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 5000000 // 5 Mbps for good quality
        });
        const chunks: Blob[] = [];

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunks.push(e.data);
          }
        };

        recorder.onerror = (e) => {
          console.error("MediaRecorder error:", e);
        };

        // Start recording
        recorder.start(1000); // Collect data every 1 second for safety

        // Save original camera state
        const origPos = win.camera.position.clone();
        const origQuat = win.camera.quaternion.clone();
        const origTarget = win.controls?.target?.clone?.() || { x: 0, y: 0, z: 0 };

        // Calculate scene parameters for fallback
        const center = win.controls?.target?.clone?.() || { x: 0, y: 0, z: 0 };
        const baseRadius = Math.sqrt(
          Math.pow(origPos.x - center.x, 2) +
          Math.pow(origPos.z - center.z, 2)
        ) || 20;
        const baseHeight = origPos.y || 10;
        const startAngle = Math.atan2(origPos.x - center.x, origPos.z - center.z);

        // Helper: smooth easing function for natural motion
        const easeInOut = (t: number): number => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

        // Helper: lerp between values
        const lerp = (a: number, b: number, t: number): number => a + (b - a) * easeInOut(t);

        /*
         * CAMERA PATH STRATEGY:
         * 1. If window.inspectionViews is defined by the agent, smoothly transition between each view
         * 2. Each view gets equal time, with smooth interpolation during transitions
         * 3. Falls back to a simple orbit if no views are defined
         */

        const duration = 15000;
        const startTime = Date.now();

        // Check if agent has defined custom inspection views
        const customViews = win.inspectionViews && Array.isArray(win.inspectionViews) && win.inspectionViews.length > 0
          ? win.inspectionViews
          : null;

        const animate = (): Promise<void> => {
          return new Promise<void>((resolve, reject) => {
            const step = () => {
              try {
                const elapsed = Date.now() - startTime;
                if (elapsed >= duration) {
                  resolve();
                  return;
                }

                const t = elapsed / duration; // 0 to 1 over full duration

                if (customViews) {
                  // Use agent-defined inspection views with smooth transitions
                  const numViews = customViews.length;
                  const holdRatio = 0.6; // 60% of time spent at each view, 40% transitioning
                  const segmentDuration = 1 / numViews;

                  const currentSegment = Math.min(Math.floor(t / segmentDuration), numViews - 1);
                  const segmentProgress = (t - currentSegment * segmentDuration) / segmentDuration;

                  const currentView = customViews[currentSegment];
                  const nextView = customViews[Math.min(currentSegment + 1, numViews - 1)];

                  // Get positions with defaults
                  const currPos = currentView.position || [origPos.x, origPos.y, origPos.z];
                  const currTarget = currentView.target || [center.x, center.y, center.z];
                  const nextPos = nextView.position || currPos;
                  const nextTarget = nextView.target || currTarget;

                  let px: number, py: number, pz: number, tx: number, ty: number, tz: number;

                  if (segmentProgress < holdRatio) {
                    // Hold at current view
                    px = currPos[0]; py = currPos[1]; pz = currPos[2];
                    tx = currTarget[0]; ty = currTarget[1]; tz = currTarget[2];
                  } else {
                    // Transition to next view
                    const transitionT = (segmentProgress - holdRatio) / (1 - holdRatio);
                    px = lerp(currPos[0], nextPos[0], transitionT);
                    py = lerp(currPos[1], nextPos[1], transitionT);
                    pz = lerp(currPos[2], nextPos[2], transitionT);
                    tx = lerp(currTarget[0], nextTarget[0], transitionT);
                    ty = lerp(currTarget[1], nextTarget[1], transitionT);
                    tz = lerp(currTarget[2], nextTarget[2], transitionT);
                  }

                  win.camera.position.set(px, py, pz);
                  win.camera.lookAt(tx, ty, tz);
                } else {
                  // Fallback: simple orbit around the scene
                  const angle = startAngle + t * Math.PI * 2;
                  const verticalOffset = Math.sin(t * Math.PI * 4) * (baseHeight * 0.15);

                  win.camera.position.x = center.x + Math.sin(angle) * baseRadius;
                  win.camera.position.z = center.z + Math.cos(angle) * baseRadius;
                  win.camera.position.y = baseHeight + verticalOffset;
                  win.camera.lookAt(center.x, center.y, center.z);
                }

                if (win.controls) {
                  win.controls.update();
                }

                win.renderer.render(win.scene, win.camera);
                animationFrameId = requestAnimationFrame(step);
              } catch (error) {
                console.error("Animation step error:", error);
                reject(error);
              }
            };
            animationFrameId = requestAnimationFrame(step);
          });
        };

        // Run animation with timeout safety
        const animationPromise = animate();
        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Animation timeout")), duration + 5000)
        );

        try {
          await Promise.race([animationPromise, timeoutPromise]);
        } catch (error) {
          console.warn("Animation interrupted:", error);
          // Continue to try to save what we recorded
        }

        // Cancel any remaining animation frame
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
        }

        // Restore camera
        try {
          win.camera.position.copy(origPos);
          win.camera.quaternion.copy(origQuat);
          if (win.controls && origTarget) {
            win.controls.target.set(origTarget.x, origTarget.y, origTarget.z);
            win.controls.update();
          }
          win.renderer.render(win.scene, win.camera);
        } catch (restoreError) {
          console.warn("Failed to restore camera:", restoreError);
        }

        // Stop recording and wait for data with timeout
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            console.warn("Recorder stop timeout, proceeding with collected data");
            resolve();
          }, 3000);

          recorder!.onstop = () => {
            clearTimeout(timeout);
            resolve();
          };
        });

        // Check if we have data
        if (chunks.length === 0) {
          console.error("No recording data collected");
          return null;
        }

        // Convert to base64
        const blob = new Blob(chunks, { type: 'video/webm' });

        if (blob.size === 0) {
          console.error("Empty recording blob");
          return null;
        }

        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("FileReader timeout")), 30000);

          reader.onloadend = () => {
            clearTimeout(timeout);
            const result = reader.result as string;
            if (result && result.includes(',')) {
              resolve(result.split(',')[1]); // Remove data URL prefix
            } else {
              reject(new Error("Invalid base64 result"));
            }
          };
          reader.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("FileReader error"));
          };
          reader.readAsDataURL(blob);
        });

        console.log(`Recording complete: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        return base64;

      } catch (e) {
        console.error("Recording failed:", e);

        // Cleanup on error
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
        }
        if (recorder && recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch (stopError) {
            console.warn("Failed to stop recorder:", stopError);
          }
        }

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