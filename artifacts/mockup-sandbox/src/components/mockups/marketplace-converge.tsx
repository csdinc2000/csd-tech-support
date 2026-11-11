import { useState, useRef, type ReactNode } from "react";
import {
  motion,
  useScroll,
  useTransform,
  AnimatePresence,
  type MotionValue,
} from "framer-motion";
import {
  Cpu,
  Layers,
  HardDrive,
  Zap,
  Disc,
  Camera,
  Sparkles,
  Check,
  Download,
  Activity,
  Maximize2,
  type LucideIcon,
} from "lucide-react";

// --- TELEMETRY & HARDWARE MATRIX ---
interface RigPart {
  id: string;
  name: string;
  category: string;
  price: number;
  icon: LucideIcon;
  start: { x: number; y: number; r: number };
  end: { x: number; y: number; r: number };
  spec: string;
  preview: string;
}

const RIG_DATA: {
  title: string;
  chassis: string;
  marketValue: number;
  targetPrice: number;
  parts: RigPart[];
} = {
  title: "TITAN-01 // RYZEN 9 7950X + RTX 4080 SUPER",
  chassis: "NZXT H9 FLOW // MATTE BLACK",
  marketValue: 2450,
  targetPrice: 2280,
  parts: [
    {
      id: "mobo",
      name: "ROG CROSSHAIR X670E",
      category: "Mainboard",
      price: 480,
      icon: Layers,
      start: { x: -280, y: -200, r: -15 },
      end: { x: 0, y: 0, r: 0 },
      spec: "PCIe 5.0 • 18+2 Stages",
      preview:
        "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=600&q=80",
    },
    {
      id: "cpu",
      name: "RYZEN 9 7950X",
      category: "Compute Core",
      price: 520,
      icon: Cpu,
      start: { x: 280, y: -200, r: 20 },
      end: { x: 0, y: -15, r: 0 },
      spec: "16C / 32T • 5.7 GHz Boost",
      preview:
        "https://images.unsplash.com/photo-1555680202-c86f0e12f086?auto=format&fit=crop&w=600&q=80",
    },
    {
      id: "gpu",
      name: "RTX 4080 SUPER 16GB",
      category: "Graphics Node",
      price: 990,
      icon: Maximize2,
      start: { x: -320, y: 120, r: 12 },
      end: { x: 0, y: 40, r: 0 },
      spec: "Ada Lovelace • DLSS 3.5",
      preview:
        "https://images.unsplash.com/photo-1587202372775-e229f172b9d7?auto=format&fit=crop&w=600&q=80",
    },
    {
      id: "ram",
      name: "32GB DOMINATOR DDR5",
      category: "Memory",
      price: 180,
      icon: Disc,
      start: { x: 300, y: 130, r: -10 },
      end: { x: 45, y: -15, r: 0 },
      spec: "6000MHz CL30 Low Latency",
      preview:
        "https://images.unsplash.com/photo-1562976540-1502c2145186?auto=format&fit=crop&w=600&q=80",
    },
    {
      id: "storage",
      name: "2TB SAMSUNG 990 PRO",
      category: "NVMe Storage",
      price: 160,
      icon: HardDrive,
      start: { x: -240, y: 260, r: -25 },
      end: { x: 25, y: 10, r: 0 },
      spec: "7,450 MB/s Gen4 Speeds",
      preview:
        "https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?auto=format&fit=crop&w=600&q=80",
    },
    {
      id: "psu",
      name: "1000W TITANIUM PRIME",
      category: "Power Plant",
      price: 230,
      icon: Zap,
      start: { x: 240, y: 260, r: 25 },
      end: { x: 0, y: 110, r: 0 },
      spec: "80+ Titanium • Native 12VHPWR",
      preview:
        "https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=600&q=80",
    },
  ],
};

// --- REFINED MINIMALIST FROSTED GLASS BUTTON ---
function GlassButton({
  children,
  onClick,
  icon: Icon,
  active = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  icon?: LucideIcon;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative overflow-hidden px-6 py-3 font-mono text-[11px] font-bold tracking-[0.2em] uppercase transition-all duration-300 active:scale-98 flex items-center justify-center gap-2.5 backdrop-blur-2xl border ${
        active
          ? "bg-white/[0.12] border-white/40 text-white shadow-[0_0_25px_rgba(255,46,99,0.35)]"
          : "bg-white/[0.03] border-white/10 text-zinc-300 hover:border-white/30 hover:bg-white/[0.08] hover:text-white"
      } ${className}`}
      style={{
        clipPath:
          "polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)",
      }}
    >
      {/* Specular Edge Highlight */}
      <span className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/40 to-transparent opacity-70 group-hover:opacity-100 transition-opacity" />
      {Icon && (
        <Icon className="w-3.5 h-3.5 text-[#FF5E3A] group-hover:scale-110 transition-transform" />
      )}
      <span className="relative z-10">{children}</span>
    </button>
  );
}

export default function MarketplaceConverge() {
  const [singlePartMode, setSinglePartMode] = useState(false);
  const [selectedSinglePart, setSelectedSinglePart] = useState<RigPart>(
    RIG_DATA.parts[2],
  );
  const [hoveredNode, setHoveredNode] = useState<RigPart | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);
  const [priceVal, setPriceVal] = useState(RIG_DATA.targetPrice);

  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start center", "end end"],
  });

  const assemble = useTransform(scrollYProgress, [0, 0.85], [0, 1]);
  const lockIn = useTransform(scrollYProgress, [0.75, 0.95], [0, 1]);

  const simulateScan = () => {
    setIsScanning(true);
    setTimeout(() => {
      setIsScanning(false);
      setScanComplete(true);
      window.scrollTo({ top: 600, behavior: "smooth" });
    }, 1200);
  };

  return (
    <div className="min-h-screen bg-[#05070E] text-white selection:bg-[#FF2E63] selection:text-white font-sans overflow-x-hidden relative">
      {/* ATMOSPHERIC GRADIENT: Sunset Red -> Mystic Purple -> Void Black */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(255,94,58,0.22),rgba(121,40,202,0.18),rgba(5,7,14,0.95))] z-0" />

      {/* SCANLINE FILTER */}
      <div
        className="fixed inset-0 pointer-events-none z-50 opacity-20"
        style={{
          backgroundImage:
            "linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.5) 50%), linear-gradient(90deg, rgba(255,0,0,0.03), rgba(0,255,0,0.01), rgba(0,0,255,0.03))",
          backgroundSize: "100% 3px, 6px 100%",
        }}
      />

      <div className="relative z-10 max-w-6xl mx-auto px-6 py-8 flex flex-col items-center">
        {/* MINIMAL HEADER */}
        <header className="w-full flex items-center justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-2 font-mono text-xs tracking-widest text-zinc-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#FF2E63] animate-pulse" />
            <span>RE-COMMERCE TERMINAL</span>
          </div>

          <div className="flex items-center gap-2">
            <GlassButton
              active={!singlePartMode}
              onClick={() => setSinglePartMode(false)}
            >
              Full Rig
            </GlassButton>
            <GlassButton
              active={singlePartMode}
              onClick={() => setSinglePartMode(true)}
            >
              Single Part
            </GlassButton>
          </div>
        </header>

        {/* HERO TITLE */}
        <section className="text-center my-16 space-y-3">
          <h1 className="text-6xl sm:text-8xl font-black uppercase tracking-tight text-white drop-shadow-[0_2px_20px_rgba(255,46,99,0.3)]">
            {singlePartMode ? "DISPATCH" : "CONVERGE"}
          </h1>
          <p className="font-mono text-xs text-[#FF5E3A] tracking-[0.3em] uppercase">
            // AUTONOMOUS HARDWARE INTAKE • COMPONENT TELEMETRY
          </p>
        </section>

        {/* COMPACT VISION / SCANNER CONSOLE */}
        <section className="w-full max-w-2xl bg-white/[0.02] border border-white/10 backdrop-blur-2xl p-6 mb-16 relative">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div
              onClick={simulateScan}
              className="border border-dashed border-white/20 hover:border-[#FF2E63]/80 p-6 flex flex-col items-center justify-center cursor-pointer transition-colors bg-black/40 group"
            >
              <Camera className="w-8 h-8 text-[#FF5E3A] mb-2 group-hover:scale-110 transition-transform" />
              <span className="font-mono text-xs uppercase tracking-wider text-white font-bold">
                Drop Rig / Part Imagery
              </span>
            </div>

            <div className="flex flex-col justify-between p-4 bg-black/40 border border-white/10">
              <div>
                <span className="font-mono text-[10px] uppercase text-zinc-400 block mb-1">
                  OEM Identification
                </span>
                <input
                  type="text"
                  defaultValue="NZXT Player: Three Prime"
                  className="w-full bg-black/80 border border-white/10 px-3 py-2 font-mono text-xs text-white focus:outline-none focus:border-white/40"
                />
              </div>
              <GlassButton
                onClick={simulateScan}
                icon={Sparkles}
                className="mt-3 w-full"
              >
                {isScanning ? "Scanning Optical Sensors..." : "Scan & Populate"}
              </GlassButton>
            </div>
          </div>

          {scanComplete && (
            <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between font-mono text-[10px] text-zinc-400">
              <span className="flex items-center gap-1.5 text-[#FF2E63]">
                <Check className="w-3.5 h-3.5" /> 6 Components Calibrated
              </span>
              <span>Scroll down to initiate physical docking ↓</span>
            </div>
          )}
        </section>

        {/* SINGLE PART SELECTOR (When active) */}
        {singlePartMode && (
          <section className="w-full max-w-4xl mb-12">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
              {RIG_DATA.parts.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setSelectedSinglePart(p)}
                  className={`p-3 cursor-pointer border backdrop-blur-xl transition-all ${
                    selectedSinglePart.id === p.id
                      ? "border-[#FF2E63] bg-white/[0.08]"
                      : "border-white/10 bg-black/40 hover:border-white/20"
                  }`}
                >
                  <div className="font-mono text-[9px] uppercase text-zinc-400">
                    {p.category}
                  </div>
                  <div className="font-bold text-xs truncate mt-1">{p.name}</div>
                  <div className="font-mono text-xs text-[#FF5E3A] mt-2">
                    ${p.price}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* INTERACTIVE SCROLL-DRIVEN CONVERGENCE CANVAS */}
        {!singlePartMode && (
          <div ref={containerRef} className="w-full h-[220vh] relative">
            <div className="sticky top-24 w-full h-[75vh] max-w-4xl mx-auto flex items-center justify-center border border-white/10 bg-black/40 backdrop-blur-md overflow-hidden">
              {/* Chassis Silhouette Dock */}
              <div className="absolute w-72 h-96 border border-white/20 bg-gradient-to-b from-white/[0.02] to-transparent p-4 flex flex-col justify-between pointer-events-none">
                <div className="flex justify-between font-mono text-[9px] text-zinc-500">
                  <span>{RIG_DATA.chassis}</span>
                  <span>STANDBY</span>
                </div>
                <div className="border border-dashed border-white/10 h-36 flex items-center justify-center font-mono text-[10px] text-zinc-600">
                  CHASSIS MATRIX
                </div>
                <div className="font-mono text-[9px] text-zinc-600">
                  ISOLATED AIR-CHANNEL BAY
                </div>
              </div>

              {/* Exploded Floating Hardware Nodes */}
              {RIG_DATA.parts.map((part) => (
                <HardwareNode
                  key={part.id}
                  part={part}
                  progress={assemble}
                  onHover={() => setHoveredNode(part)}
                  onLeave={() => setHoveredNode(null)}
                />
              ))}

              {/* Locked Assembly Flagship Card */}
              <motion.div
                style={{ opacity: lockIn }}
                className="absolute bottom-6 flex items-center gap-4 bg-black/90 border border-white/30 backdrop-blur-2xl px-6 py-3 shadow-[0_0_30px_rgba(0,0,0,0.8)] z-30 pointer-events-auto"
              >
                <div>
                  <div className="font-mono text-xs uppercase font-bold text-white">
                    ASSEMBLY VERIFIED // READY FOR MARKET
                  </div>
                  <div className="font-mono text-[10px] text-zinc-400">
                    High-resolution hero render generated
                  </div>
                </div>
                <GlassButton
                  icon={Download}
                  active
                  className="py-2 px-4 text-[10px]"
                >
                  Capture Flagship
                </GlassButton>
              </motion.div>
            </div>
          </div>
        )}

        {/* COMPONENT ACTION / TELEMETRY HOVER POPUP */}
        <AnimatePresence>
          {hoveredNode && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed bottom-8 right-8 z-50 w-72 bg-black/90 border border-white/20 backdrop-blur-2xl p-4 shadow-[0_0_40px_rgba(0,0,0,0.9)] pointer-events-none"
            >
              <div className="flex items-center justify-between pb-2 border-b border-white/10 text-[9px] font-mono text-[#FF5E3A]">
                <span>TELEMETRY VERIFIED</span>
                <Activity className="w-3 h-3 animate-pulse" />
              </div>

              <div className="relative h-28 w-full my-3 overflow-hidden border border-white/10 bg-zinc-950">
                <img
                  src={hoveredNode.preview}
                  alt={hoveredNode.name}
                  className="w-full h-full object-cover saturate-150 brightness-90"
                />
              </div>

              <div className="font-bold text-xs uppercase text-white truncate">
                {hoveredNode.name}
              </div>
              <div className="font-mono text-[10px] text-zinc-400 mt-0.5">
                {hoveredNode.spec}
              </div>
              <div className="mt-2 pt-2 border-t border-white/10 flex justify-between font-mono text-[10px]">
                <span className="text-zinc-500">INDEXED VALUE</span>
                <span className="text-[#FF5E3A] font-bold">
                  ${hoveredNode.price}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* PUBLISH & MARKETPLACE METRICS HUD */}
        <section className="w-full max-w-4xl bg-white/[0.02] border border-white/10 backdrop-blur-2xl p-8 mt-12 mb-20">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="md:col-span-2 space-y-4">
              <div>
                <span className="font-mono text-[10px] uppercase text-zinc-400 block mb-1">
                  Index Title
                </span>
                <input
                  type="text"
                  key={singlePartMode ? selectedSinglePart.id : "rig"}
                  defaultValue={
                    singlePartMode ? selectedSinglePart.name : RIG_DATA.title
                  }
                  className="w-full bg-black/60 border border-white/10 p-3 font-mono text-xs text-white focus:outline-none focus:border-white/30"
                />
              </div>

              <div>
                <span className="font-mono text-[10px] uppercase text-zinc-400 block mb-1">
                  Telemetry Description
                </span>
                <textarea
                  rows={3}
                  key={singlePartMode ? selectedSinglePart.id : "rig"}
                  defaultValue={
                    singlePartMode
                      ? `${selectedSinglePart.spec}. Factory-tested under sustained thermal load.`
                      : "Precision-balanced compute rig. Benchmarked and thermally calibrated. Zero silicon defects detected."
                  }
                  className="w-full bg-black/60 border border-white/10 p-3 font-mono text-[11px] text-zinc-300 focus:outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div className="flex flex-col justify-between border-t md:border-t-0 md:border-l border-white/10 pt-4 md:pt-0 md:pl-6">
              <div>
                <div className="font-mono text-[10px] uppercase text-zinc-400">
                  Valuation Engine
                </div>
                <div className="text-3xl font-black font-mono text-white mt-1">
                  ${singlePartMode ? selectedSinglePart.price : priceVal}
                </div>
                <div className="font-mono text-[10px] text-zinc-500 line-through">
                  $
                  {singlePartMode
                    ? selectedSinglePart.price + 35
                    : RIG_DATA.marketValue}
                </div>

                {!singlePartMode && (
                  <div className="mt-4">
                    <input
                      type="range"
                      min={1500}
                      max={3000}
                      value={priceVal}
                      onChange={(e) => setPriceVal(Number(e.target.value))}
                      className="w-full accent-[#FF2E63]"
                    />
                  </div>
                )}
              </div>

              <GlassButton active className="mt-6 w-full">
                Publish Listing
              </GlassButton>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// --- CONVERGING HARDWARE NODE COMPONENT ---
function HardwareNode({
  part,
  progress,
  onHover,
  onLeave,
}: {
  part: RigPart;
  progress: MotionValue<number>;
  onHover: () => void;
  onLeave: () => void;
}) {
  const x = useTransform(progress, [0, 1], [part.start.x, part.end.x]);
  const y = useTransform(progress, [0, 1], [part.start.y, part.end.y]);
  const rotate = useTransform(progress, [0, 1], [part.start.r, part.end.r]);
  const Icon = part.icon;

  return (
    <motion.div
      style={{ x, y, rotate }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className="absolute cursor-pointer group z-20"
    >
      <div className="px-3 py-2 bg-black/80 border border-white/20 hover:border-white/60 backdrop-blur-xl transition-colors flex items-center gap-2.5 shadow-xl">
        <Icon className="w-3.5 h-3.5 text-[#FF5E3A]" />
        <span className="font-mono text-[10px] uppercase font-bold text-white tracking-wider">
          {part.name.split(" ")[0]}
        </span>
      </div>
    </motion.div>
  );
}
