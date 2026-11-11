import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSuggestion, clearLookupCache, lookupHardwareText, mergeReading, parseHardwareText } from "./marketplace-scan";

test("Lenovo Legion bottom sticker → laptop with full spec matrix", () => {
  const parsed = parseHardwareText(`
    Lenovo Legion 5 Pro 16ACH6H
    Type 82JQ  S/N PF2X9K7L
    AMD Ryzen 7 5800H  NVIDIA GeForce RTX 3070 8GB
    16GB DDR4 3200  1TB PCIe NVMe SSD  Windows 11 Home
  `);
  assert.equal(parsed.brand, "Lenovo");
  assert.equal(parsed.deviceType, "laptop");
  assert.match(parsed.model, /^Legion 5 Pro/);
  assert.equal(parsed.specs.cpu, "AMD Ryzen 7 5800H");
  assert.equal(parsed.specs.gpu, "NVIDIA GeForce RTX 3070");
  assert.equal(parsed.specs.ram, "16GB DDR4-3200");
  assert.equal(parsed.specs.storage, "1TB PCIe NVMe SSD");
  assert.equal(parsed.specs.os, "Windows 11 Home");
  assert.equal(parsed.identifiers.serialNumber, "PF2X9K7L");
  assert.equal(parsed.identifiers.partNumber, "82JQ");

  const s = buildSuggestion(parsed);
  assert.equal(s.category, "laptop");
  assert.equal(s.confidence, "high");
  assert.equal(s.title, "Lenovo Legion 5 Pro 16ACH6H - RTX 3070 / 16GB");
  assert.match(s.descriptionHook, /^Factory specs: Lenovo Legion 5 Pro 16ACH6H featuring AMD Ryzen 7 5800H, NVIDIA GeForce RTX 3070/);
  assert.match(s.descriptionHook, /1440p/);
});

test("Dell service tag plate", () => {
  const parsed = parseHardwareText("Dell XPS 15 9520  Service Tag: 7GHJ2M3  Express Service Code: 16412334567");
  assert.equal(parsed.brand, "Dell");
  assert.equal(parsed.identifiers.serviceTag, "7GHJ2M3");
  assert.equal(parsed.deviceType, "laptop");
  assert.equal(buildSuggestion(parsed).title, "Dell XPS 15 9520");
});

test("Gigabyte GPU part number decodes to the chip and memory", () => {
  const parsed = parseHardwareText("GIGABYTE  GV-N3070GAMING OC-8GD  REV 2.0");
  assert.equal(parsed.brand, "Gigabyte");
  assert.equal(parsed.specs.gpu, "NVIDIA GeForce RTX 3070 8GB");
  assert.equal(parsed.deviceType, "gpu");
  const s = buildSuggestion(parsed);
  assert.equal(s.category, "parts");
  assert.equal(s.title, "Gigabyte RTX 3070 8GB");
});

test("EVGA part number decodes the 30-series model", () => {
  const parsed = parseHardwareText("EVGA 08G-P5-3755-KR");
  assert.equal(parsed.specs.gpu, "NVIDIA GeForce RTX 3070 8GB");
  assert.equal(parsed.identifiers.partNumber, "08G-P5-3755-KR");
});

test("Intel + NVIDIA desktop spec sheet → gaming PC", () => {
  const parsed = parseHardwareText("Intel Core i7-13700K, GeForce RTX 4070 Ti Super 16GB, 32GB DDR5 RAM, 2TB NVMe SSD, Windows 11 Pro");
  assert.equal(parsed.specs.cpu, "Intel Core i7-13700K");
  assert.equal(parsed.specs.gpu, "NVIDIA GeForce RTX 4070 Ti Super");
  assert.equal(parsed.specs.ram, "32GB DDR5");
  assert.equal(parsed.specs.storage, "2TB NVMe SSD");
  assert.equal(parsed.deviceType, "desktop");
  const s = buildSuggestion(parsed);
  assert.equal(s.category, "gaming_pc");
  assert.equal(s.title, "Gaming PC - RTX 4070 Ti Super / 32GB");
});

test("HP product number and Ryzen X3D", () => {
  const parsed = parseHardwareText("HP OMEN 45L  Product No: 8L0P7AA#ABA  Ryzen 7 7800X3D  RX 7900 XTX");
  assert.equal(parsed.brand, "HP");
  assert.equal(parsed.identifiers.partNumber, "8L0P7AA#ABA");
  assert.equal(parsed.specs.cpu, "AMD Ryzen 7 7800X3D");
  assert.equal(parsed.specs.gpu, "AMD Radeon RX 7900 XTX");
  assert.equal(parsed.deviceType, "desktop");
});

test("bare CPU box → parts", () => {
  const parsed = parseHardwareText("AMD Ryzen 5 5600X");
  assert.equal(parsed.deviceType, "cpu");
  assert.equal(buildSuggestion(parsed).title, "AMD Ryzen 5 5600X");
  assert.equal(buildSuggestion(parsed).category, "parts");
});

test("nothing recognisable → not detected", () => {
  const s = buildSuggestion(parseHardwareText("MADE IN CHINA  CE  FCC  input 19.5V"));
  assert.equal(s.detected, false);
  assert.equal(s.title, "");
  assert.equal(s.descriptionHook, "");
});

test("mergeReading prefers the vision model's fields but lets regex decode part numbers", () => {
  const result = mergeReading({
    rawText: "ASUS TUF Gaming A15 FA506IV\nGV-N3070GAMING OC-8GD",
    brand: "ASUS",
    model: "TUF Gaming A15 FA506IV",
    deviceType: "laptop",
    cpu: "AMD Ryzen 7 4800H",
    ram: "16GB DDR4",
    storage: "512GB NVMe SSD",
    serialNumber: "",
  });
  assert.equal(result.detected, true);
  assert.equal(result.brand, "ASUS");
  assert.equal(result.category, "laptop");
  assert.equal(result.specs.cpu, "AMD Ryzen 7 4800H");
  assert.equal(result.specs.gpu, "NVIDIA GeForce RTX 3070 8GB");
  assert.equal(result.title, "ASUS TUF Gaming A15 FA506IV - RTX 3070 8GB / 16GB");
  assert.equal(result.identifiers.serialNumber, undefined);
});

test("mergeReading with no vision reading still runs regex over nothing gracefully", () => {
  const result = mergeReading(null);
  assert.equal(result.detected, false);
  assert.equal(result.confidence, "low");
});

test("text lookup: the model is consulted even for full spec lines (it adds pricing), regex stays canonical", async () => {
  clearLookupCache();
  let calls = 0;
  const result = await lookupHardwareText("i7-13700K RTX 4070 32GB DDR5 2TB NVMe", async () => {
    calls++;
    return { cpu: "Core i7 13700K", gpu: "RTX 4070", usedPriceLowUsd: 900, usedPriceHighUsd: 1200, priceBasis: "comparable builds", summary: "High-end 2023 gaming desktop" };
  });
  assert.equal(calls, 1);
  assert.equal(result.category, "gaming_pc");
  assert.equal(result.specs.cpu, "Intel Core i7-13700K", "regex normalisation wins over the model's loose spelling");
  assert.deepEqual(result.pricing, { low: 900, high: 1200, basis: "comparable builds" });
  assert.equal(result.summary, "High-end 2023 gaming desktop");
});

test("text lookup: multi-config lines come back with candidates, and results are cached", async () => {
  clearLookupCache();
  let calls = 0;
  const reader = async () => {
    calls++;
    return {
      brand: "Dell", model: "XPS 15 9520", deviceType: "laptop" as const, releaseYear: 2022, grounded: true,
      usedPriceLowUsd: "650", usedPriceHighUsd: "1100",
      candidates: [
        { label: "i7-12700H / RTX 3050 Ti / 16GB / 512GB", cpu: "Intel Core i7-12700H", gpu: "NVIDIA GeForce RTX 3050 Ti", ram: "16GB DDR5", storage: "512GB NVMe SSD" },
        { cpu: "Intel Core i9-12900HK", gpu: "NVIDIA GeForce RTX 3050 Ti", ram: "32GB DDR5", storage: "1TB NVMe SSD" },
        { label: "" },
      ],
    };
  };
  const first = await lookupHardwareText("xps 9520", reader);
  assert.equal(first.detected, true);
  assert.equal(first.grounded, true);
  assert.equal(first.releaseYear, "2022");
  assert.equal(first.pricing?.low, 650);
  assert.equal(first.candidates.length, 2, "empty candidate rows are dropped");
  assert.equal(first.candidates[1].label, "Intel Core i9-12900HK · NVIDIA GeForce RTX 3050 Ti · 32GB DDR5 · 1TB NVMe SSD");
  assert.equal(first.specs.cpu, "", "ambiguous config leaves the top-level spec empty");

  const second = await lookupHardwareText("  XPS   9520 ", reader);
  assert.equal(calls, 1, "normalised query hits the cache");
  assert.deepEqual(second, first);
});

test("text lookup: nonsense pricing is ignored", async () => {
  clearLookupCache();
  const result = await lookupHardwareText("Ryzen 7 5800X", async () => ({ usedPriceLowUsd: 300, usedPriceHighUsd: 100 }));
  assert.equal(result.pricing, null);
});

test("text lookup: product codes are expanded by the model and merged", async () => {
  const result = await lookupHardwareText("82JQ", async (q) => {
    assert.equal(q, "82JQ");
    return { brand: "Lenovo", model: "Legion 5 Pro 16ACH6H", deviceType: "laptop", cpu: "AMD Ryzen 7 5800H", gpu: "NVIDIA GeForce RTX 3070", ram: "16GB DDR4", storage: "1TB SSD", partNumber: "82JQ" };
  });
  assert.equal(result.detected, true);
  assert.equal(result.category, "laptop");
  assert.equal(result.title, "Lenovo Legion 5 Pro 16ACH6H - RTX 3070 / 16GB");
  assert.equal(result.identifiers.partNumber, "82JQ");
  assert.equal(result.rawText, "82JQ");
});

test("text lookup: a failing model falls back to regex", async () => {
  clearLookupCache();
  const result = await lookupHardwareText("Ryzen 5 5600X", async () => { throw new Error("boom"); });
  assert.equal(result.specs.cpu, "AMD Ryzen 5 5600X");
  assert.equal(result.category, "parts");
});

test("GPU lookups keep the vendor model name and don't put VRAM in the RAM field", () => {
  const r = mergeReading({ rawText: "gv-n3070gaming oc-8gd", brand: "Gigabyte", model: "RTX 3070 Gaming OC", deviceType: "gpu", gpu: "NVIDIA GeForce RTX 3070", ram: "8GB GDDR6" });
  assert.equal(r.specs.ram, "");
  assert.equal(r.specs.gpu, "NVIDIA GeForce RTX 3070 8GB");
  assert.equal(r.title, "Gigabyte RTX 3070 Gaming OC");
  assert.equal(r.category, "parts");
});
