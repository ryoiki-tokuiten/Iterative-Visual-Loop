async function testPythonTool() {
  const pythonScript = `
import cv2
import numpy as np
from PIL import Image
from moviepy import VideoFileClip

print("=== Starting Python Sandbox Execution ===")

# 1. Crop test image using OpenCV
print("Loading Media 317.png...")
img = cv2.imread("Media 317.png")
if img is not None:
    print(f"Original Image Dimensions: {img.shape}")
    # Crop a 400x400 section from center
    h, w, c = img.shape
    crop = img[h//4:3*h//4, w//4:3*w//4]
    cv2.imwrite("output_crop.png", crop)
    print("Successfully saved cropped image: output_crop.png")
else:
    print("Error: Could not load Media 317.png")

# 2. Extract a frame using OpenCV
print("Loading Media 315.mp4...")
cap = cv2.VideoCapture("Media 315.mp4")
if cap.isOpened():
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    print(f"Video Info - FPS: {fps}, Total Frames: {total_frames}")
    
    # Read frame at 2 seconds
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(fps * 2.0))
    ret, frame = cap.read()
    if ret:
        cv2.imwrite("output_frame.jpg", frame)
        print("Successfully saved extracted frame: output_frame.jpg")
    else:
        print("Error: Could not read frame at 2 seconds")
    cap.release()
else:
    print("Error: Could not load Media 315.mp4")

# 3. Create a short video clip using MoviePy
print("Trimming video using MoviePy...")
try:
    clip = VideoFileClip("Media 315.mp4").subclipped(0, 1.5)
    # Write as webm
    clip.write_videofile("output_clip.webm", codec="libvpx", audio=False)
    clip.close()
    print("Successfully saved trimmed video: output_clip.webm")
except Exception as e:
    print(f"MoviePy error: {e}")

print("=== Python Sandbox Execution Finished ===")
`;

  console.log("Sending Python script execution request to Vite dev server...");
  try {
    const response = await fetch("http://localhost:5173/api/run-python", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ script: pythonScript }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log("\n=== Response Received ===");
    console.log(`Success: ${data.success}`);
    console.log(`Exit Code: ${data.exitCode}`);
    
    if (data.stdout) {
      console.log(`\n--- STDOUT ---\n${data.stdout.trim()}`);
    }
    
    if (data.stderr) {
      console.log(`\n--- STDERR ---\n${data.stderr.trim()}`);
    }
    
    console.log(`\n--- Output Files (${data.files ? data.files.length : 0}) ---`);
    if (data.files && data.files.length > 0) {
      data.files.forEach((file) => {
        const base64Snippet = file.base64.substring(0, 40) + "...";
        console.log(`- File: ${file.filename}`);
        console.log(`  MimeType: ${file.mimeType}`);
        console.log(`  Base64 Snippet: ${base64Snippet}`);
        console.log(`  Base64 Length: ${file.base64.length} chars`);
      });
    } else {
      console.log("No output files returned.");
    }
    
    // Assert check
    const expectedFiles = ["output_crop.png", "output_frame.jpg", "output_clip.webm"];
    const returnedFiles = (data.files || []).map(f => f.filename);
    const missing = expectedFiles.filter(f => !returnedFiles.includes(f));
    
    if (data.success && missing.length === 0) {
      console.log("\n✅ VERIFICATION SUCCESSFUL: Script executed and all expected visual outputs were returned correctly!");
    } else {
      console.log(`\n❌ VERIFICATION FAILED: Success flag is ${data.success}, missing files: [${missing.join(", ")}]`);
    }
  } catch (err) {
    console.error("Connection failed:", err.message);
  }
}

testPythonTool();
