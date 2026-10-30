import { useAuth, useUser } from "@clerk/react";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, LockKeyhole, ShieldCheck, TriangleAlert } from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiRequestError, apiRequest, queryClient } from "@/lib/queryClient";

type ValidInvite = { id: string; email: string; role: string; status: "pending"; expiresAt: string };
type PageState = "missing" | "validating" | "valid" | "invalid" | "error" | "accepted";
const storageKey = "csd_staff_invite_token";

function readAndStoreToken(): string | null {
  const fromHash = window.location.hash.slice(1);
  if (fromHash) {
    try {
      sessionStorage.setItem(storageKey, fromHash);
      // Only remove the fragment once the token survives a redirect in this tab.
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    } catch {
      // If session storage is unavailable, leave the fragment intact for a reload.
    }
    return fromHash;
  }
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function clearToken() {
  try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
}

function appPath(path: string) {
  const base = `/${String(import.meta.env.BASE_URL || "/").replace(/^\/+|\/+$/g, "")}`;
  return `${base === "/" ? "" : base}${path}`;
}

export default function StaffInviteLanding() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [token, setToken] = useState<string | null>(readAndStoreToken);
  const [state, setState] = useState<PageState>(token ? "validating" : "missing");
  const [invite, setInvite] = useState<ValidInvite | null>(null);
  const [playVideo, setPlayVideo] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  useEffect(() => {
    if (user?.firstName) setFirstName((current) => current || user.firstName || "");
    if (user?.lastName) setLastName((current) => current || user.lastName || "");
  }, [user?.firstName, user?.lastName]);

  useEffect(() => {
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateVideoPreference = () => setPlayVideo(!motionPreference.matches);
    updateVideoPreference();
    motionPreference.addEventListener("change", updateVideoPreference);
    return () => motionPreference.removeEventListener("change", updateVideoPreference);
  }, []);

  useEffect(() => {
    if (!token) return;
    let current = true;
    setState("validating");
    setMessage(null);
    void (async () => {
      try {
        const response = await apiRequest("POST", "/api/public/staff-invites/validate", { token });
        const data = await response.json() as ValidInvite;
        if (!current) return;
        setInvite(data);
        setState("valid");
      } catch (error) {
        if (!current) return;
        if (error instanceof ApiRequestError && (error.status === 404 || error.status === 410)) {
          clearToken();
          setToken(null);
          setInvite(null);
          setState("invalid");
          setMessage("This invitation is invalid, expired, or has been revoked. Ask the account owner for a new link.");
        } else {
          setState("error");
          setMessage("We could not check this invitation. Please try again.");
        }
      }
    })();
    return () => { current = false; };
  }, [token, attempt]);

  const accept = async () => {
    if (!token || working) return;
    setWorking(true);
    setMessage(null);
    try {
      const response = await apiRequest("POST", "/api/public/staff-invites/accept", { token, firstName: firstName.trim(), lastName: lastName.trim() });
      const result = await response.json() as { role: string; approvalStatus: "pending" };
      if (result.approvalStatus !== "pending") throw new Error("Unexpected approval state");
      clearToken();
      setToken(null);
      setState("accepted");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/auth/access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] }),
      ]);
      window.location.assign(appPath("/dashboard"));
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 410)) {
        clearToken();
        setToken(null);
        setState("invalid");
        setMessage("This invitation is no longer available. Ask the account owner for a new link.");
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setMessage(`This invitation is for ${invite?.email ?? "a different email address"}. Sign in with that verified email address to accept it. The invitation has not been used.`);
      } else if (error instanceof ApiRequestError && error.status === 409) {
        setMessage(error.message || "This account has a conflict. Ask the owner to resolve it before trying again.");
      } else if (error instanceof ApiRequestError && error.status === 401) {
        setMessage("Your sign-in has expired. Sign in again with the invited email address to continue.");
      } else {
        setMessage("We could not accept this invitation. Please try again.");
      }
    } finally {
      setWorking(false);
    }
  };

  const roleName = invite?.role.replace(/_/g, " ") ?? "";

  return (
    <main className="flex min-h-[100dvh] flex-col bg-stone-50 text-stone-950" data-testid="page-staff-invite">
      <div className="h-1 bg-csd-red" />
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-6 md:px-8">
        <div className="flex items-center gap-3">
          <img src={csdLogo} alt="Computer Systems Depot Inc" className="h-10 w-auto shrink-0 object-contain" />
          <div><p className="text-sm font-bold tracking-tight">CSD <span className="font-normal text-stone-500">/ Staff access</span></p><p className="text-[10px] font-bold uppercase tracking-[0.15em] text-stone-500">Secure invitation</p></div>
        </div>
        <LockKeyhole className="h-4 w-4 text-stone-400" aria-hidden="true" />
      </header>

      <section aria-label="Staff invitation" className="relative isolate flex flex-1 items-center overflow-hidden bg-gray-950 text-white">
        {playVideo ? (
          <video
            className="absolute inset-0 h-full w-full object-cover opacity-75"
            autoPlay
            loop
            muted
            playsInline
            poster="/hero-poster.jpg"
            aria-hidden="true"
          >
            <source src="/hero.mp4" type="video/mp4" />
          </video>
        ) : (
          <img
            src="/hero-poster.jpg"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover opacity-75"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-gray-950/95 via-gray-950/70 to-gray-950/35" />
        <div className="absolute inset-0 bg-gradient-to-t from-gray-950/60 to-transparent" />

      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 items-center px-5 pb-16 pt-8 md:px-8">
        <div className="grid w-full gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] md:items-center md:gap-16">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 border-l-2 border-red-400 pl-3 text-xs font-bold uppercase tracking-[0.15em] text-red-200"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> By invitation only</div>
            <h1 className="max-w-lg text-4xl font-semibold leading-[1.1] tracking-tight md:text-5xl">A deliberate way into the team.</h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-gray-200">Your account is connected to CSD only through an invitation from the owner. Roles are assigned by the owner, never selected during sign-up. The owner approves access after you accept.</p>
            <div className="mt-8 space-y-3 border-t border-white/20 pt-6 text-sm text-gray-200">
              <p className="flex items-start gap-3"><span className="font-mono text-xs font-bold text-red-300">01</span> Confirm the invitation is addressed to you.</p>
              <p className="flex items-start gap-3"><span className="font-mono text-xs font-bold text-red-300">02</span> Sign in or create an account with that email.</p>
              <p className="flex items-start gap-3"><span className="font-mono text-xs font-bold text-red-300">03</span> Complete your profile and accept, then wait for owner approval.</p>
            </div>
          </div>

          <section className="min-w-0 overflow-hidden rounded-xl border border-stone-200 bg-[hsl(28,29%,98%)] text-stone-950 shadow-lg" aria-live="polite">
            <div className="border-b border-stone-200 px-5 py-4 md:px-6"><p className="text-xs font-bold uppercase tracking-[0.14em] text-stone-500">Invitation status</p></div>
            <div className="p-5 md:p-6">
              {state === "validating" ? (
                <div className="space-y-4" data-testid="loading-invite-validation"><div className="h-6 w-2/3 animate-pulse rounded bg-stone-200" /><div className="h-12 w-full animate-pulse rounded bg-stone-100" /><div className="h-12 w-4/5 animate-pulse rounded bg-stone-100" /></div>
              ) : state === "valid" && invite ? (
                <div data-testid="panel-valid-invite">
                  <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Invitation verified</div>
                  <h2 className="mt-4 text-2xl font-semibold tracking-tight">You’re invited to CSD.</h2>
                  <div className="mt-5 divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white px-4">
                    <div className="py-3"><p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">Invited email</p><p className="mt-1 break-all text-sm font-semibold" data-testid="text-invited-email">{invite.email}</p></div>
                    <div className="py-3"><p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">Owner-assigned role</p><p className="mt-1 text-sm font-semibold capitalize" data-testid="text-invited-role">{roleName}</p></div>
                    <div className="py-3"><p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">Valid until</p><p className="mt-1 text-sm font-medium" data-testid="text-invite-expiry">{new Date(invite.expiresAt).toLocaleString()}</p></div>
                  </div>
                  {!isLoaded ? <div className="mt-5 h-10 animate-pulse rounded bg-stone-200" data-testid="loading-invite-auth" /> : isSignedIn ? (
                    <div className="mt-5 space-y-3">
                      <p className="text-sm text-stone-600">Complete your staff profile to request approval for the role assigned by the owner.</p>
                      <label className="block text-sm font-medium">First name<Input autoComplete="given-name" maxLength={100} required value={firstName} onChange={(event) => setFirstName(event.target.value)} className="mt-1 bg-white" data-testid="input-invite-first-name" /></label>
                      <label className="block text-sm font-medium">Last name<Input autoComplete="family-name" maxLength={100} required value={lastName} onChange={(event) => setLastName(event.target.value)} className="mt-1 bg-white" data-testid="input-invite-last-name" /></label>
                      <Button type="button" disabled={working || !firstName.trim() || !lastName.trim()} onClick={() => void accept()} className="w-full gap-2 bg-csd-red hover:bg-red-800" data-testid="button-accept-invite">{working ? "Accepting…" : "Accept invitation"} {!working && <ArrowRight className="h-4 w-4" />}</Button>
                    </div>
                  ) : (
                    <div className="mt-5"><p className="mb-3 text-sm text-stone-600">Continue with <strong>{invite.email}</strong>. Already have an account? Sign in with email or Google using this same email address. Your invitation will be waiting when you return.</p><div className="flex flex-col gap-2 sm:flex-row"><Button asChild className="flex-1 gap-2 bg-csd-red hover:bg-red-800"><a href={appPath("/sign-up?redirect=/staff-invite")} data-testid="link-invite-sign-up">Create invited account <ArrowRight className="h-4 w-4" /></a></Button><Button asChild variant="outline" className="flex-1"><a href={appPath("/sign-in?redirect=/staff-invite")} data-testid="link-invite-sign-in">Sign in with email or Google</a></Button></div></div>
                  )}
                  {message && <p role="alert" className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="error-invite-accept">{message}</p>}
                </div>
              ) : state === "accepted" ? (
                <div data-testid="status-invite-accepted"><CheckCircle2 className="h-9 w-9 text-emerald-700" aria-hidden="true" /><h2 className="mt-4 text-2xl font-semibold tracking-tight">Waiting for owner approval</h2><p className="mt-2 text-sm leading-relaxed text-stone-600">Your invitation is accepted. The owner must approve your account before you can use the workspace.</p><Button asChild className="mt-5 bg-csd-red hover:bg-red-800"><a href={appPath("/dashboard")}>View access status</a></Button></div>
              ) : (
                <div data-testid="panel-invite-unavailable"><TriangleAlert className="h-8 w-8 text-amber-700" aria-hidden="true" /><h2 className="mt-4 text-2xl font-semibold tracking-tight">{state === "error" ? "Could not verify invitation" : state === "missing" ? "Invitation link needed" : "Invitation unavailable"}</h2><p className="mt-2 text-sm leading-relaxed text-stone-600" role={state === "missing" ? undefined : "alert"} data-testid="text-invite-error">{message ?? "Open the private link sent to you by the account owner to continue."}</p>{state === "error" && <Button type="button" variant="outline" className="mt-5" onClick={() => setAttempt((value) => value + 1)} data-testid="button-retry-invite">Try again</Button>}{state === "invalid" && <p className="mt-5 border-t border-stone-200 pt-4 text-xs text-stone-500">A new invitation must be created by the owner.</p>}</div>
              )}
            </div>
          </section>
        </div>
      </div>
      </section>
      <footer className="mx-auto w-full max-w-5xl border-t border-stone-200 px-5 py-5 text-xs text-stone-500 md:px-8">CSD / Internal operations · Access is owner-controlled</footer>
    </main>
  );
}