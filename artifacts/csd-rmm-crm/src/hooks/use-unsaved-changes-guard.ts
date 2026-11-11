import { useEffect, useRef } from "react";
import { useRouter } from "wouter";

type Guard = { dirtyRef: { current: boolean }; pageUrl: URL; message: string };
const activeGuards = new Set<Guard>();
let lastEntry = typeof window === "undefined" ? null : { href: window.location.href, state: window.history.state };

function rememberNavigationEntry() {
  if (typeof window === "undefined") return;
  lastEntry = { href: window.location.href, state: window.history.state };
}

function guardPopState() {
  if (typeof window === "undefined") return;
  const destination = new URL(window.location.href);
  for (const guard of activeGuards) {
    if (!guard.dirtyRef.current ||
      (destination.origin === guard.pageUrl.origin && destination.pathname === guard.pageUrl.pathname)) continue;
    if (!window.confirm(guard.message)) {
      if (lastEntry) window.history.pushState(lastEntry.state, "", lastEntry.href);
      return;
    }
  }
  rememberNavigationEntry();
}

function addNavigationListeners() {
  if (typeof window === "undefined") return;
  window.addEventListener("pushState", rememberNavigationEntry);
  window.addEventListener("replaceState", rememberNavigationEntry);
  // Capture phase runs before the router's popstate handler, preserving the
  // mounted form when the user cancels browser Back navigation.
  window.addEventListener("popstate", guardPopState, true);
}

function removeNavigationListeners() {
  if (typeof window === "undefined") return;
  window.removeEventListener("pushState", rememberNavigationEntry);
  window.removeEventListener("replaceState", rememberNavigationEntry);
  window.removeEventListener("popstate", guardPopState, true);
}

// These must be installed before the router's popstate listener so a canceled
// Back action can preserve the form before the router unmounts it. They are a
// single module-level set, not one listener per form; HMR explicitly disposes it.
addNavigationListeners();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeNavigationListeners();
    activeGuards.clear();
  });
}

/**
 * Guards in-app navigation, history traversal and full document navigations.
 * The history entry is restored when Back is canceled so the mounted form keeps its draft.
 */
export function useUnsavedChangesGuard(dirty: boolean, message: string) {
  const router = useRouter();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    const pageUrl = new URL(window.location.href);
    const guard = { dirtyRef, pageUrl, message };
    if (activeGuards.size === 0) rememberNavigationEntry();
    activeGuards.add(guard);
    const samePage = (href: string) => {
      const destination = new URL(href, window.location.href);
      return destination.origin === pageUrl.origin
        && destination.pathname === pageUrl.pathname;
    };
    const onLinkClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!link || link.hasAttribute("download") || link.getAttribute("target") === "_blank") return;
      if (dirtyRef.current && !samePage(link.href) && !window.confirm(message)) event.preventDefault();
    };
    document.addEventListener("click", onLinkClick);
    return () => {
      activeGuards.delete(guard);
      document.removeEventListener("click", onLinkClick);
    };
  }, [message]);

  useEffect(() => {
    const original = router.aroundNav;
    const guarded: typeof original = (navigate, to, options) => {
      const destination = new URL(to, window.location.href);
      const leavesPage = destination.origin !== window.location.origin
        || destination.pathname !== window.location.pathname;
      if (leavesPage && dirtyRef.current && !window.confirm(message)) return;
      original(navigate, to, options);
    };
    Object.assign(router, { aroundNav: guarded });
    return () => {
      if (router.aroundNav === guarded) Object.assign(router, { aroundNav: original });
    };
  }, [router, message]);
}