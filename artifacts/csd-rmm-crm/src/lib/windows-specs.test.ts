import assert from "node:assert/strict";
import test from "node:test";
import { cleanCpuName, formatDiskSize, parseWindowsSpecs, pickGpu } from "./windows-specs.ts";

test("parses the JSON one-liner into buyer-friendly specs", () => {
  const json = JSON.stringify({
    CPU: "AMD Ryzen 7 7800X3D 8-Core Processor",
    GPU: ["NVIDIA GeForce RTX 4070", "AMD Radeon(TM) Graphics"],
    RAMBytes: 34359738368,
    MemType: 34,
    MemSpeed: 5600,
    Disks: [
      { Model: "Samsung SSD 990 PRO 1TB", Size: 1000204886016, MediaType: "SSD", BusType: "NVMe" },
      { Model: "ST2000DM008-2FR102", Size: 2000398934016, MediaType: "HDD", BusType: "SATA" },
      { Model: "SanDisk Ultra USB 3.0", Size: 61530439680, MediaType: "Unspecified", BusType: "USB" },
    ],
    OS: "Microsoft Windows 11 Pro",
  });
  assert.deepEqual(parseWindowsSpecs(`PS C:\\Users\\me> ...\n${json}\nPS C:\\Users\\me>`), {
    cpu: "AMD Ryzen 7 7800X3D",
    gpu: "NVIDIA GeForce RTX 4070",
    ram: "32GB DDR5-5600",
    storage: "1TB NVMe SSD + 2TB HDD",
    os: "Windows 11 Pro",
  });
});

test("single GPU/disk collapse (PowerShell unwraps one-element arrays)", () => {
  const specs = parseWindowsSpecs(JSON.stringify({
    CPU: "12th Gen Intel(R) Core(TM) i7-12700K",
    GPU: "Intel(R) UHD Graphics 770",
    RAMBytes: 17179869184,
    MemType: 26,
    MemSpeed: 3200,
    Disks: { Model: "WDC WDS500G2B0C-00PXH0", Size: 500107862016, MediaType: "SSD", BusType: "NVMe" },
    OS: "Microsoft Windows 10 Home",
  }));
  assert.deepEqual(specs, { cpu: "Intel Core i7-12700K", gpu: "Intel UHD Graphics 770", ram: "16GB DDR4-3200", storage: "500GB NVMe SSD", os: "Windows 10 Home" });
});

test("falls back to console text from the individual Get-CimInstance commands", () => {
  const pasted = `
PS C:\\> Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name
Intel(R) Core(TM) i5-9400F CPU @ 2.90GHz
PS C:\\> Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
NVIDIA GeForce GTX 1660 SUPER
Microsoft Basic Display Adapter
PS C:\\> Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum

Count    : 2
Average  :
Sum      : 17179869184
Maximum  :
Minimum  :
Property : Capacity

PS C:\\> Get-CimInstance Win32_DiskDrive | Select-Object Model, Size

Model                          Size
-----                          ----
KINGSTON SA400S37480G  480103981056
WDC WD10EZEX-08WN4A0  1000202273280
`;
  assert.deepEqual(parseWindowsSpecs(pasted), {
    cpu: "Intel Core i5-9400F",
    gpu: "NVIDIA GeForce GTX 1660 SUPER",
    ram: "16GB",
    storage: "480GB + 1TB",
  });
});

test("returns null for unusable input", () => {
  assert.equal(parseWindowsSpecs(""), null);
  assert.equal(parseWindowsSpecs("hello world"), null);
  assert.equal(parseWindowsSpecs("{}"), null);
});

test("cleanCpuName strips marketing suffixes", () => {
  assert.equal(cleanCpuName("Intel(R) Core(TM) i7-13700K"), "Intel Core i7-13700K");
  assert.equal(cleanCpuName("AMD Ryzen 5 5600G with Radeon Graphics"), "AMD Ryzen 5 5600G");
  assert.equal(cleanCpuName("Intel(R) Xeon(R) CPU E5-2670 v3 @ 2.30GHz"), "Intel Xeon E5-2670 v3");
});

test("pickGpu prefers the discrete card and drops virtual adapters", () => {
  assert.equal(pickGpu(["Microsoft Basic Display Adapter"]), null);
  assert.equal(pickGpu(["Intel(R) Iris(R) Xe Graphics", "NVIDIA GeForce RTX 4060 Laptop GPU", "Parsec Virtual Display Adapter"]), "NVIDIA GeForce RTX 4060 Laptop GPU");
  assert.equal(pickGpu(["AMD Radeon(TM) Graphics"]), "AMD Radeon Graphics");
});

test("formatDiskSize rounds to marketing sizes", () => {
  assert.equal(formatDiskSize(256060514304), "256GB");
  assert.equal(formatDiskSize(1000204886016), "1TB");
  assert.equal(formatDiskSize(1500301910016), "1.5TB");
  assert.equal(formatDiskSize(4000787030016), "4TB");
});
