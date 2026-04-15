"use client";

import { useState, useRef } from "react";

interface Props {
  property: string;
}

function burnTimestamp(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);

      const now = new Date();
      const timestamp = now.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });

      const fontSize = Math.max(16, Math.floor(img.width / 30));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const textWidth = ctx.measureText(timestamp).width;
      const padding = fontSize * 0.5;
      const x = padding;
      const y = img.height - padding;

      // Dark background
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(
        x - padding * 0.5,
        y - fontSize - padding * 0.3,
        textWidth + padding,
        fontSize + padding * 0.8
      );

      // White text
      ctx.fillStyle = "#ffffff";
      ctx.fillText(timestamp, x, y);

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas toBlob failed"));
        },
        "image/jpeg",
        0.85
      );
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export default function PhotosTab({ property }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [success, setSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    setFiles(selected);
    setSuccess(false);
    const urls = selected.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
  }

  async function handleUpload() {
    if (files.length === 0) return;
    setUploading(true);
    setProgress("Processing photos...");

    try {
      const formData = new FormData();
      formData.append("property", property);

      for (let i = 0; i < files.length; i++) {
        setProgress(`Stamping photo ${i + 1} of ${files.length}...`);
        const stamped = await burnTimestamp(files[i]);
        formData.append("photos", stamped, `photo_${i}.jpg`);
      }

      setProgress("Uploading to Google Drive...");
      const res = await fetch("/api/upload-photos", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setSuccess(true);
      setProgress(`${data.count} photos uploaded successfully!`);
      setFiles([]);
      setPreviews([]);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setProgress("Upload failed. Please try again.");
      console.error(err);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
          <div className="text-3xl mb-2">✅</div>
          <p className="text-green-800 font-medium">{progress}</p>
        </div>
      )}

      <label className="block w-full cursor-pointer">
        <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-blue-400 transition-colors">
          <div className="text-4xl mb-2">📷</div>
          <p className="text-gray-600 font-medium">Tap to select photos</p>
          <p className="text-gray-400 text-sm mt-1">Select multiple from camera roll</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
      </label>

      {previews.length > 0 && (
        <>
          <p className="text-sm text-gray-500 mt-4 mb-2">
            {previews.length} photo{previews.length !== 1 ? "s" : ""} selected
          </p>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {previews.map((url, i) => (
              <div key={i} className="aspect-square rounded-lg overflow-hidden bg-gray-100">
                <img
                  src={url}
                  alt={`Preview ${i + 1}`}
                  className="w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="w-full bg-blue-600 text-white py-3 rounded-xl text-lg font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50"
          >
            {uploading ? progress : `Upload ${previews.length} Photo${previews.length !== 1 ? "s" : ""}`}
          </button>
        </>
      )}
    </div>
  );
}
