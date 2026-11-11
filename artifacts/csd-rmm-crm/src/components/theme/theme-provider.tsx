import { ThemeProvider as NextThemesProvider } from "next-themes";

export const THEME_STORAGE_KEY = "csd-theme";

// Light / dark / system for the staff app. Tailwind runs in class mode
// (`darkMode: ["class"]`), so next-themes toggles `.dark` on <html>; the
// shadcn variables in index.css and the compat layer in theme-dark.css do
// the rest. The choice is per browser (localStorage), not per account.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="light" enableSystem storageKey={THEME_STORAGE_KEY} disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
