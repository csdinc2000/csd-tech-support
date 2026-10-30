import { useState, useEffect, useRef, type RefObject } from "react";

interface AgentLogs {
  projectManager?: string;
  headTech?: string;
}

interface SelectedCams {
  cam1: string;
  cam2: string;
}

const DEFAULT_OLLAMA_URL = "http://localhost:11434/api/generate";
const DEFAULT_OLLAMA_MODEL = "llava";

export default function AriaMultiCam() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCams, setSelectedCams] = useState<SelectedCams>({ cam1: "", cam2: "" });
  const [userPrompt, setUserPrompt] = useState("");
  const [backend, setBackend] = useState<"gemini" | "ollama">("gemini");
  const [ollamaUrl, setOllamaUrl] = useState(DEFAULT_OLLAMA_URL);
  const [ollamaModel, setOllamaModel] = useState(DEFAULT_OLLAMA_MODEL);
  const [loading, setLoading] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentLogs, setAgentLogs] = useState<AgentLogs>({});

  const videoRef1 = useRef<HTMLVideoElement>(null);
  const videoRef2 = useRef<HTMLVideoElement>(null);

  // Load connected camera devices
  useEffect(() => {
    async function getCameras() {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        // Permission denied — enumerateDevices still returns unlabeled entries.
      }
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = allDevices.filter((dev) => dev.kind === "videoinput");
      setDevices(videoInputs);
      if (videoInputs.length >= 2) {
        setSelectedCams({
          cam1: videoInputs[0].deviceId,
          cam2: videoInputs[1].deviceId,
        });
      } else if (videoInputs.length > 0) {
        setSelectedCams((prev) => ({ ...prev, cam1: videoInputs[0].deviceId }));
      }
    }
    getCameras();
  }, []);

  // Bind video streams to elements
  useEffect(() => {
    const refs: Array<[string, RefObject<HTMLVideoElement>]> = [
      [selectedCams.cam1, videoRef1],
      [selectedCams.cam2, videoRef2],
    ];

    refs.forEach(async ([deviceId, videoRef]) => {
      if (!deviceId || !videoRef.current) return;
      const previous = videoRef.current.srcObject as MediaStream | null;
      previous?.getTracks().forEach((t) => t.stop());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId }, width: 640, height: 480 },
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        console.error("Camera stream error:", err);
      }
    });

    return () => {
      refs.forEach(([, videoRef]) => {
        const stream = videoRef.current?.srcObject as MediaStream | null;
        stream?.getTracks().forEach((t) => t.stop());
      });
    };
  }, [selectedCams]);

  // Capture frame from video element into base64
  const captureFrame = (videoRef: RefObject<HTMLVideoElement>): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
  };

  const parseTeamReports = (text: string): AgentLogs => {
    const circuitMatch = text.match(/\[CIRCUIT REPORT\]:(.*?)(?=\[APEX SYNTHESIS\]|$)/s);
    const apexMatch = text.match(/\[APEX SYNTHESIS\]:(.*?)$/s);
    return {
      headTech: circuitMatch ? circuitMatch[1].trim() : text,
      projectManager: apexMatch ? apexMatch[1].trim() : text,
    };
  };

  const runOllamaLocal = async (frames: { cam1?: string | null; cam2?: string | null }) => {
    const images: string[] = [];
    if (frames.cam1) images.push(frames.cam1);
    if (frames.cam2) images.push(frames.cam2);

    const prompt = `You are operating as a 2-Agent Tactical Team at Computer Systems Depot.
Analyze the attached ${images.length} live camera feed image(s) and respond using EXACTLY this format:

[CIRCUIT REPORT]: (hardware/detail observations from the macro/detail camera)
[APEX SYNTHESIS]: (as Lead PM, synthesize the findings into a clear, actionable summary)

USER DIRECTIVE: "${userPrompt || "Routine inspection and status check."}"`;

    const res = await fetch(ollamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        images,
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      throw new Error(`Ollama returned ${res.status}: ${text}`);
    }

    const data = await res.json();
    return parseTeamReports(data.response || "");
  };

  const runGeminiCloud = async (frames: { cam1?: string | null; cam2?: string | null }) => {
    const res = await fetch("/api/aria/agent-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userPrompt,
        backend: "gemini",
        cameraFrames: {
          cam1: frames.cam1,
          cam2: frames.cam2,
        },
      }),
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || "Gemini request failed");
    }
    return data.reports as AgentLogs;
  };

  const handleAgentSubmit = async () => {
    if (coolingDown) return;
    setCoolingDown(true);
    setLoading(true);
    setError(null);

    const frames = {
      cam1: captureFrame(videoRef1),
      cam2: captureFrame(videoRef2),
    };

    try {
      const reports = backend === "ollama" ? await runOllamaLocal(frames) : await runGeminiCloud(frames);
      setAgentLogs(reports);
      const finalSpeech = reports.projectManager || reports.headTech;
      if ("speechSynthesis" in window && finalSpeech) {
        const utterance = new SpeechSynthesisUtterance(finalSpeech);
        window.speechSynthesis.speak(utterance);
      }
    } catch (err: any) {
      console.error("Agent Dispatch Error:", err);
      setError(err.message || "Agent dispatch failed — check the server logs.");
    } finally {
      setLoading(false);
      // 5-second cooldown to avoid rate limits on Gemini (no limit on Ollama)
      setTimeout(() => setCoolingDown(false), 5000);
    }
  };

  const camPanels = [
    { key: "cam1" as const, label: "Apex (Project Mgr) - Cam 1", ref: videoRef1, color: "#00E676" },
    { key: "cam2" as const, label: "Circuit (Head Tech) - Cam 2", ref: videoRef2, color: "#29B6F6" },
  ];

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif", backgroundColor: "#121212", color: "#fff", borderRadius: "12px" }}>
      <h2 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "16px" }}>Aria Multi-Agent Command Center</h2>

      {/* Backend selector */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", alignItems: "center" }}>
        <span style={{ fontSize: "0.875rem", color: "#aaa" }}>AI Backend:</span>
        <button
          onClick={() => setBackend("gemini")}
          style={{
            padding: "6px 14px",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
            fontWeight: backend === "gemini" ? "bold" : "normal",
            backgroundColor: backend === "gemini" ? "#4285F4" : "#333",
            color: backend === "gemini" ? "#fff" : "#aaa",
          }}
        >
          Gemini (Cloud)
        </button>
        <button
          onClick={() => setBackend("ollama")}
          style={{
            padding: "6px 14px",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
            fontWeight: backend === "ollama" ? "bold" : "normal",
            backgroundColor: backend === "ollama" ? "#00E676" : "#333",
            color: backend === "ollama" ? "#000" : "#aaa",
          }}
        >
          Ollama (Local)
        </button>
      </div>

      {backend === "ollama" && (
        <div style={{ background: "#1a2f1a", border: "1px solid #2e7d32", padding: "10px", borderRadius: "6px", marginBottom: "16px", fontSize: "0.8rem" }}>
          <strong>Local mode:</strong> The browser connects directly to your local Ollama server. Camera frames never leave this computer.
          <ol style={{ margin: "8px 0 0 16px", padding: 0 }}>
            <li>Install Ollama from <a href="https://ollama.com" target="_blank" rel="noreferrer" style={{ color: "#81c784" }}>ollama.com</a></li>
            <li>Pull a vision model: <code>ollama pull llava</code></li>
            <li>Start Ollama with CORS enabled: <code>OLLAMA_ORIGINS=* ollama serve</code> (Windows: <code>set OLLAMA_ORIGINS=* && ollama serve</code>)</li>
          </ol>
          <div style={{ marginTop: "10px", display: "flex", gap: "10px", alignItems: "center" }}>
            <label>URL:</label>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              style={{ flex: 1, padding: "6px", background: "#0d1f0d", color: "#fff", border: "1px solid #2e7d32", borderRadius: "4px" }}
            />
            <label>Model:</label>
            <input
              type="text"
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              style={{ width: "120px", padding: "6px", background: "#0d1f0d", color: "#fff", border: "1px solid #2e7d32", borderRadius: "4px" }}
            />
          </div>
        </div>
      )}

      {/* Camera Selection Controls */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "15px", marginBottom: "20px" }}>
        {camPanels.map(({ key, label, ref, color }) => (
          <div key={key}>
            <label><strong>{label}:</strong></label>
            <select
              value={selectedCams[key]}
              onChange={(e) => setSelectedCams({ ...selectedCams, [key]: e.target.value })}
              style={{ width: "100%", padding: "8px", marginTop: "5px", background: "#1E1E1E", color: "#fff", borderRadius: "6px" }}
            >
              <option value="">— No camera —</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
            <video
              ref={ref}
              autoPlay
              playsInline
              muted
              style={{ width: "100%", borderRadius: "8px", marginTop: "8px", border: `2px solid ${color}`, background: "#000", minHeight: "120px" }}
            />
          </div>
        ))}
      </div>

      {/* User Input Bar */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <input
          type="text"
          placeholder="Issue directive to the team..."
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !loading && !coolingDown && handleAgentSubmit()}
          style={{ flex: 1, padding: "12px", borderRadius: "6px", border: "1px solid #444", background: "#1E1E1E", color: "#fff" }}
        />
        <button
          onClick={handleAgentSubmit}
          disabled={loading || coolingDown}
          style={{ padding: "12px 24px", backgroundColor: coolingDown ? "#555" : "#00E676", color: "#000", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold", opacity: loading ? 0.6 : 1 }}
        >
          {loading ? "Processing Feeds..." : coolingDown ? "Cooling down..." : "Send Instruction"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#2d1215", border: "1px solid #b71c1c", padding: "12px", borderRadius: "6px", marginBottom: "20px" }}>
          {error}
        </div>
      )}

      {/* Agent Response Dashboard */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "15px" }}>
        <div style={{ background: "#1E1E1E", padding: "15px", borderRadius: "8px", borderLeft: "4px solid #00E676" }}>
          <h3>👑 Apex (Project Manager)</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{agentLogs.projectManager || "Awaiting input..."}</p>
        </div>

        <div style={{ background: "#1E1E1E", padding: "15px", borderRadius: "8px", borderLeft: "4px solid #29B6F6" }}>
          <h3>🔬 Circuit (Head Tech)</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{agentLogs.headTech || "Standby..."}</p>
        </div>
      </div>
    </div>
  );
}
