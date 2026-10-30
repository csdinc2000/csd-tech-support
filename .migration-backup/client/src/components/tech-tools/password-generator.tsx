import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Copy, Check, KeyRound } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const LOWER_AMB = "lo";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const UPPER_AMB = "IO";
const NUM = "23456789";
const NUM_AMB = "01";
const SYM = "!@#$%^&*-_=+?";

const WORDS = [
  "anchor", "bridge", "cactus", "dolphin", "ember", "falcon", "granite", "harbor",
  "ivory", "jaguar", "kettle", "lantern", "marble", "nectar", "orbit", "pepper",
  "quartz", "ribbon", "saddle", "timber", "umbra", "velvet", "walnut", "xenon",
  "yonder", "zephyr", "copper", "dynamo", "engine", "fossil",
];

function randomInt(max: number) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}

function pick(str: string) {
  return str[randomInt(str.length)];
}

function shuffle(arr: string[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function estimateStrength(pw: string): { label: string; color: string; pct: number } {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 20;
  const entropy = pw.length * (pool ? Math.log2(pool) : 0);
  if (entropy < 50) return { label: "Weak", color: "bg-red-500", pct: 25 };
  if (entropy < 75) return { label: "Fair", color: "bg-yellow-500", pct: 50 };
  if (entropy < 110) return { label: "Strong", color: "bg-green-500", pct: 75 };
  return { label: "Very strong", color: "bg-emerald-600", pct: 100 };
}

export default function PasswordGenerator() {
  const { toast } = useToast();
  const [mode, setMode] = useState<"random" | "passphrase">("random");
  const [length, setLength] = useState(16);
  const [words, setWords] = useState(4);
  const [useUpper, setUseUpper] = useState(true);
  const [useLower, setUseLower] = useState(true);
  const [useNum, setUseNum] = useState(true);
  const [useSym, setUseSym] = useState(true);
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(true);
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);

  const generate = useCallback(() => {
    if (mode === "passphrase") {
      const parts: string[] = [];
      for (let i = 0; i < words; i++) {
        const w = WORDS[randomInt(WORDS.length)];
        parts.push(w.charAt(0).toUpperCase() + w.slice(1));
      }
      parts.push(String(randomInt(90) + 10));
      setValue(parts.join("-"));
      setCopied(false);
      return;
    }
    let lower = LOWER, upper = UPPER, num = NUM;
    if (!excludeAmbiguous) {
      lower += LOWER_AMB;
      upper += UPPER_AMB;
      num += NUM_AMB;
    }
    const sets: string[] = [];
    if (useLower) sets.push(lower);
    if (useUpper) sets.push(upper);
    if (useNum) sets.push(num);
    if (useSym) sets.push(SYM);
    if (sets.length === 0) {
      toast({ title: "Pick at least one character type", variant: "destructive" });
      return;
    }
    const all = sets.join("");
    const chars: string[] = sets.map((s) => pick(s));
    for (let i = chars.length; i < length; i++) chars.push(pick(all));
    setValue(shuffle(chars).join(""));
    setCopied(false);
  }, [mode, length, words, useUpper, useLower, useNum, useSym, excludeAmbiguous, toast]);

  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast({ title: "Copied to clipboard" });
  };

  const strength = value ? estimateStrength(value) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-csd-red" /> Password Generator
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex gap-2">
          <Button
            variant={mode === "random" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("random")}
            data-testid="button-mode-random"
          >
            Random
          </Button>
          <Button
            variant={mode === "passphrase" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("passphrase")}
            data-testid="button-mode-passphrase"
          >
            Passphrase
          </Button>
        </div>

        <div className="flex items-stretch gap-2">
          <Input
            readOnly
            value={value}
            placeholder='Click "Generate"'
            className="font-mono text-sm"
            data-testid="input-generated-password"
          />
          <Button variant="outline" size="icon" onClick={copy} disabled={!value} data-testid="button-copy-password">
            {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button onClick={generate} data-testid="button-generate-password">
            <RefreshCw className="mr-2 h-4 w-4" /> Generate
          </Button>
        </div>

        {strength && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>Strength</span>
              <Badge variant="secondary">{strength.label}</Badge>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div className={`h-full ${strength.color} transition-all`} style={{ width: `${strength.pct}%` }} />
            </div>
          </div>
        )}

        {mode === "random" ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <Label>Length</Label>
                <span className="text-sm font-medium">{length}</span>
              </div>
              <Slider value={[length]} min={8} max={48} step={1} onValueChange={(v) => setLength(v[0])} data-testid="slider-length" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={useUpper} onCheckedChange={(v) => setUseUpper(!!v)} data-testid="checkbox-upper" /> Uppercase (A-Z)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={useLower} onCheckedChange={(v) => setUseLower(!!v)} data-testid="checkbox-lower" /> Lowercase (a-z)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={useNum} onCheckedChange={(v) => setUseNum(!!v)} data-testid="checkbox-num" /> Numbers (0-9)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={useSym} onCheckedChange={(v) => setUseSym(!!v)} data-testid="checkbox-sym" /> Symbols (!@#)
              </label>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <Checkbox checked={excludeAmbiguous} onCheckedChange={(v) => setExcludeAmbiguous(!!v)} data-testid="checkbox-ambiguous" /> Exclude look-alikes (0/O, 1/l/I)
              </label>
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label>Number of words</Label>
              <span className="text-sm font-medium">{words}</span>
            </div>
            <Slider value={[words]} min={3} max={8} step={1} onValueChange={(v) => setWords(v[0])} data-testid="slider-words" />
            <p className="mt-2 text-xs text-gray-500">Easy to read aloud over the phone, hard to crack. A number is added on the end.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
