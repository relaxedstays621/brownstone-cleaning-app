"use client";

import { useState, useRef, useEffect } from "react";

interface Props {
  property: string;
}

interface InventoryItem {
  item: string;
  quantity: number;
  notes: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionInstance = any;

export default function InventoryTab({ property }: Props) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance>(null);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  function toggleVoice() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      alert("Voice input is not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setText(transcript);
    };

    recognition.onerror = () => {
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  async function handleParse() {
    if (!text.trim()) return;
    setParsing(true);
    setSuccess(false);
    try {
      const res = await fetch("/api/inventory/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      setItems(data.items);
    } catch {
      alert("Failed to process. Please try again.");
    } finally {
      setParsing(false);
    }
  }

  async function handleConfirm() {
    if (!items) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/inventory/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property, items }),
      });
      if (!res.ok) throw new Error("Failed");
      setSuccess(true);
      setItems(null);
      setText("");
    } catch {
      alert("Failed to submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
          <div className="text-3xl mb-2">✅</div>
          <p className="text-green-800 font-medium">Inventory request submitted!</p>
        </div>
      )}

      {!items ? (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe what needs restocking... e.g. 'We need 3 sets of towels, dish soap, and 2 rolls of paper towels'"
            className="w-full h-32 px-4 py-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none bg-white"
          />

          <div className="flex gap-3 mt-3">
            <button
              onClick={toggleVoice}
              className={`flex-1 py-3 rounded-xl text-base font-medium transition-colors ${
                listening
                  ? "bg-red-500 text-white animate-pulse"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              {listening ? "⏹ Stop" : "🎤 Voice"}
            </button>
            <button
              onClick={handleParse}
              disabled={!text.trim() || parsing}
              className="flex-1 bg-blue-600 text-white py-3 rounded-xl text-base font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50"
            >
              {parsing ? "Processing..." : "Submit"}
            </button>
          </div>
        </>
      ) : (
        <>
          <h3 className="font-bold text-lg mb-3">Confirm Items</h3>
          <div className="space-y-2 mb-4">
            {items.map((item, i) => (
              <div key={i} className="bg-white rounded-xl p-4 border border-gray-200">
                <div className="flex justify-between items-start">
                  <span className="font-medium">{item.item}</span>
                  <span className="text-sm bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full ml-2">
                    x{item.quantity}
                  </span>
                </div>
                {item.notes && (
                  <p className="text-sm text-gray-500 mt-1">{item.notes}</p>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setItems(null)}
              className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-xl text-base font-medium hover:bg-gray-300"
            >
              Edit
            </button>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              className="flex-1 bg-green-600 text-white py-3 rounded-xl text-base font-medium hover:bg-green-700 active:bg-green-800 transition-colors disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Confirm"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
