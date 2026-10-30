import type { Express, Request, Response } from "express";
import { GoogleGenAI } from "@google/genai";

// ============================================================================
// Multi-camera ARIA agent — Gemini (cloud) backend only.
//
// Ollama runs on the user's local machine, so in the browser-based Replit
// preview it must be called directly from the frontend (browser → localhost).
// The /api/aria/agent-command route therefore only handles Gemini.
// ============================================================================

const GEMINI_MODEL = "gemini-2.0-flash";

let geminiClient: GoogleGenAI | null | undefined;

function getGeminiClient(): GoogleGenAI | null {
  if (geminiClient === undefined) {
    const key = process.env.GEMINI_API_KEY;
    geminiClient = key ? new GoogleGenAI({ apiKey: key }) : null;
  }
  return geminiClient;
}

interface CameraFrames {
  cam1?: string; // Workbench / wide view
  cam2?: string; // Macro / scope / detail view
}

function imagePart(base64Jpeg: string) {
  return { inlineData: { mimeType: "image/jpeg", data: base64Jpeg } };
}

async function runGeminiMultiAgent(ai: GoogleGenAI, userPrompt: string, frames: CameraFrames) {
  const promptParts: any[] = [
    `You are operating as a 2-Agent Tactical Team at Computer Systems Depot.
Analyze the attached images from the 2 live camera feeds and generate a response formatted EXACTLY as structured below.

AGENT ROLES & FEEDS:
- Cam 1 Feed (Workbench / Wide View): Apex (Project Manager)
- Cam 2 Feed (Macro / Scope / Detail): Circuit (Head Tech - Hardware Specialist)

USER DIRECTIVE: "${userPrompt || "Routine inspection and status check."}"

OUTPUT FORMAT REQUIRED:
[CIRCUIT REPORT]: (Specific hardware / detail observations from Cam 2)
[APEX SYNTHESIS]: (As Lead PM, synthesize all findings into a direct, actionable summary for the user)`
  ];

  if (frames.cam1) {
    promptParts.push("--- CAMERA 1 FEED (Apex - PM Wide View) ---");
    promptParts.push(imagePart(frames.cam1));
  }
  if (frames.cam2) {
    promptParts.push("--- CAMERA 2 FEED (Circuit - Head Tech Detail View) ---");
    promptParts.push(imagePart(frames.cam2));
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: promptParts,
  });

  const fullText = response.text || "";

  const circuitMatch = fullText.match(/\[CIRCUIT REPORT\]:(.*?)(?=\[APEX SYNTHESIS\]|$)/s);
  const apexMatch = fullText.match(/\[APEX SYNTHESIS\]:(.*?)$/s);

  return {
    headTech: circuitMatch ? circuitMatch[1].trim() : "No hardware issues detected.",
    projectManager: apexMatch ? apexMatch[1].trim() : fullText,
  };
}

export function registerAriaMultiCamRoutes(app: Express) {
  app.post("/api/aria/agent-command", async (req: Request, res: Response) => {
    try {
      const { userPrompt, cameraFrames = {} } = req.body as {
        userPrompt?: string;
        cameraFrames?: CameraFrames;
      };

      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          success: false,
          error: "GEMINI_API_KEY is not configured. Switch to the Ollama (Local) backend or add a Gemini API key.",
        });
      }

      const reports = await runGeminiMultiAgent(ai, userPrompt || "", cameraFrames);

      res.json({
        success: true,
        backend: "gemini",
        reports,
        finalSpeech: reports.projectManager,
      });
    } catch (error: any) {
      console.error("Multi-Agent Vision Error:", error);

      if (error.status === 429 || (error.message && error.message.includes("429"))) {
        return res.status(429).json({
          success: false,
          error: "Rate limit reached. Please wait a few seconds before the next scan.",
          retryAfter: 5,
        });
      }

      res.status(500).json({ success: false, error: error.message });
    }
  });
}
