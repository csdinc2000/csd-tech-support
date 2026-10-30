import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertCrmDealSchema, updateCrmDealSchema, DEAL_STAGES } from "@shared/schema";
import {
  changeDealStage,
  getDealTimeline,
  getPipelineStats,
  linkItemToDeal,
  LINKABLE_ITEM_TYPES,
} from "../crm-pipeline";
import { addPipelineEventClient, publishPipelineEvent } from "../crm-events";

/**
 * CRM sales-pipeline router, mounted at /api/crm/pipeline-era paths from
 * registerRoutes. Sits behind the global /api auth gate in server/index.ts
 * (nothing here is on the public allowlist), alongside the older
 * contacts/leads/jobs endpoints that live in routes.ts.
 */
const router = Router();

function requesterEmail(req: Request): string | null {
  return ((req.user as any)?.claims?.email as string | undefined) ?? null;
}

// List deals, optionally filtered by stage: GET /deals?stage=proposal
router.get("/deals", async (req: Request, res: Response) => {
  try {
    const stage = req.query.stage as string | undefined;
    if (stage && !(DEAL_STAGES as readonly string[]).includes(stage)) {
      return res.status(400).json({ message: `Invalid stage. Expected one of: ${DEAL_STAGES.join(", ")}` });
    }
    const deals = stage ? await storage.getCrmDealsByStage(stage) : await storage.getCrmDeals();
    res.json(deals);
  } catch (error) {
    console.error("Failed to fetch deals:", error);
    res.status(500).json({ message: "Failed to fetch deals" });
  }
});

router.post("/deals", async (req: Request, res: Response) => {
  try {
    const data = insertCrmDealSchema.parse(req.body);
    const deal = await storage.createCrmDeal(data);
    publishPipelineEvent({ type: "deal_created", dealId: deal.id, stage: deal.stage });
    res.status(201).json(deal);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid deal data", errors: error.errors });
    }
    console.error("Failed to create deal:", error);
    res.status(500).json({ message: "Failed to create deal" });
  }
});

router.get("/deals/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid deal id" });
  try {
    const deal = await storage.getCrmDeal(id);
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    res.json(deal);
  } catch (error) {
    console.error("Failed to fetch deal:", error);
    res.status(500).json({ message: "Failed to fetch deal" });
  }
});

// General field updates. Stage moves go through PATCH /deals/:id/stage so the
// won → auto-ticket rule can't be bypassed.
router.patch("/deals/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid deal id" });
  try {
    const data = updateCrmDealSchema.omit({ stage: true }).parse(req.body);
    const deal = await storage.updateCrmDeal(id, data);
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    publishPipelineEvent({ type: "deal_updated", dealId: deal.id, stage: deal.stage });
    res.json(deal);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid deal data", errors: error.errors });
    }
    console.error("Failed to update deal:", error);
    res.status(500).json({ message: "Failed to update deal" });
  }
});

const stageChangeSchema = z.object({
  stage: z.enum(DEAL_STAGES),
  technicianId: z.number().int().nullable().optional(),
});

router.patch("/deals/:id/stage", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid deal id" });
  try {
    const { stage, technicianId } = stageChangeSchema.parse(req.body);
    const result = await changeDealStage(id, stage, {
      technicianId,
      performedBy: requesterEmail(req),
    });
    if (!result) return res.status(404).json({ message: "Deal not found" });
    res.json({ deal: result.deal, onboardingTicket: result.onboardingTicket });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid stage change", errors: error.errors });
    }
    console.error("Failed to change deal stage:", error);
    res.status(500).json({ message: "Failed to change deal stage" });
  }
});

router.delete("/deals/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid deal id" });
  try {
    const deleted = await storage.deleteCrmDeal(id);
    if (!deleted) return res.status(404).json({ message: "Deal not found" });
    publishPipelineEvent({ type: "deal_deleted", dealId: id });
    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete deal:", error);
    res.status(500).json({ message: "Failed to delete deal" });
  }
});

// 360° interaction history: calls + voicemails + tickets + CRM activity.
router.get("/deals/:id/timeline", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid deal id" });
  try {
    const deal = await storage.getCrmDeal(id);
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    const timeline = await getDealTimeline(deal);
    res.json({ deal, timeline });
  } catch (error) {
    console.error("Failed to fetch deal timeline:", error);
    res.status(500).json({ message: "Failed to fetch deal timeline" });
  }
});

const linkSchema = z.object({
  itemType: z.enum(LINKABLE_ITEM_TYPES),
  itemId: z.number().int(),
  // null detaches the item from the deal
  attach: z.boolean().default(true),
});

router.post("/deals/:id/link", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid deal id" });
  try {
    const { itemType, itemId, attach } = linkSchema.parse(req.body);
    const deal = await storage.getCrmDeal(id);
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    const ok = await linkItemToDeal(itemType, itemId, attach ? id : null);
    if (!ok) return res.status(404).json({ message: `${itemType} ${itemId} not found` });
    publishPipelineEvent({ type: "deal_linked", dealId: id });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid link request", errors: error.errors });
    }
    console.error("Failed to link item to deal:", error);
    res.status(500).json({ message: "Failed to link item to deal" });
  }
});

router.get("/pipeline/stats", async (_req: Request, res: Response) => {
  try {
    res.json(await getPipelineStats());
  } catch (error) {
    console.error("Failed to fetch pipeline stats:", error);
    res.status(500).json({ message: "Failed to fetch pipeline stats" });
  }
});

// Live updates for the pipeline board and stat badges.
router.get("/pipeline/stream", (req: Request, res: Response) => {
  const cleanup = addPipelineEventClient(res);
  req.on("close", cleanup);
});

export default router;
