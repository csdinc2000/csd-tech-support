// Curated knowledge base mapping the most common Twilio / TCR A2P 10DLC
// rejection patterns to plain-English remediation guidance. When a rejection
// reason returned by Twilio matches one of these patterns, the Messages page
// renders the friendly note next to the verbatim reason so owners know
// exactly what to fix before resubmitting. Unmatched reasons fall through
// and are rendered as-is.

export interface A2pRejectionHint {
  id: string;
  pattern: RegExp;
  title: string;
  remediation: string;
  docUrl: string;
}

const TWILIO_A2P_TROUBLESHOOTING =
  "https://help.twilio.com/articles/4406748707995-Why-was-my-A2P-Brand-or-Campaign-registration-rejected";
const TCR_VETTING_DOC =
  "https://help.twilio.com/articles/8772863975963-Twilio-A2P-10DLC-Brand-Score-and-Vetting";
const SAMPLE_MESSAGES_DOC =
  "https://help.twilio.com/articles/1260800720410-What-are-message-samples-and-why-are-they-required-for-A2P-10DLC-Campaigns-";
const OPT_IN_DOC =
  "https://help.twilio.com/articles/1260801864489-How-do-I-prove-end-user-opt-in-for-Twilio-A2P-10DLC-";
const PRIVACY_POLICY_DOC =
  "https://help.twilio.com/articles/14150169195675-Privacy-Policy-Requirements-for-A2P-10DLC";

// Order matters — first match wins. Put more specific patterns before
// generic catch-alls (e.g. specific EIN guidance before generic "brand
// score too low" guidance).
export const A2P_REJECTION_HINTS: A2pRejectionHint[] = [
  {
    id: "ein-mismatch",
    pattern: /\b(ein|tax\s*id|tax\s*identification)\b.*\b(mismatch|do(es)?\s*not\s*match|invalid|incorrect|unverif|mismatched|wrong)\b/i,
    title: "EIN doesn't match IRS / SOS records",
    remediation:
      "The EIN (Tax ID) you provided couldn't be matched against IRS or Secretary of State records for the legal business name. Double-check the 9-digit EIN on your IRS CP-575 letter and make sure the legal business name is exactly how it appears on that letter (no DBAs, no abbreviations).",
    docUrl: TCR_VETTING_DOC,
  },
  {
    id: "legal-name-mismatch",
    pattern: /\b(legal\s*(business\s*)?name|company\s*name|business\s*name)\b.*\b(mismatch|do(es)?\s*not\s*match|invalid|incorrect|unverif)\b/i,
    title: "Legal business name doesn't match records",
    remediation:
      "The legal business name doesn't match what the IRS or your state's Secretary of State has on file. Use the exact registered name (including 'LLC' or 'Inc.' if applicable) and avoid trade names / DBAs in this field.",
    docUrl: TCR_VETTING_DOC,
  },
  {
    id: "address-mismatch",
    pattern: /\b(address|street|postal\s*code|zip)\b.*\b(mismatch|do(es)?\s*not\s*match|invalid|incorrect|unverif)\b/i,
    title: "Business address doesn't match records",
    remediation:
      "The street address on file with the IRS / Secretary of State must match what you entered here. Use the registered headquarters address (not a P.O. box or virtual office) and include the suite number if you have one.",
    docUrl: TCR_VETTING_DOC,
  },
  {
    id: "samples-missing-optout",
    pattern: /\b(sample|sample\s*messages?)\b.*\b(opt[-\s]?out|stop|unsubscribe)\b/i,
    title: "Sample messages must include opt-out language",
    remediation:
      "Every sample message must show how recipients can opt out. Add wording like \"Reply STOP to unsubscribe\" (and ideally \"Reply HELP for help\") to each sample so reviewers can see opt-out instructions are part of your messaging.",
    docUrl: SAMPLE_MESSAGES_DOC,
  },
  {
    id: "samples-missing-brand",
    pattern: /\b(sample|sample\s*messages?)\b.*\b(brand|business|company)\s*(name|identif)/i,
    title: "Sample messages must identify your business",
    remediation:
      "Each sample message needs to clearly identify your business name in the body. Update samples to open with something like \"Hi {{1}}, this is [Your Business Name]…\" so the recipient knows who's texting them.",
    docUrl: SAMPLE_MESSAGES_DOC,
  },
  {
    id: "samples-generic",
    pattern: /\b(sample|sample\s*messages?)\b.*\b(generic|placeholder|insufficient|too\s*(short|vague)|not\s*specific)\b/i,
    title: "Sample messages are too generic",
    remediation:
      "Reviewers need concrete examples of the actual texts you'll send. Replace generic stand-ins with realistic samples that include the business name, what the message is about, variables in {{1}} format, and the STOP opt-out line.",
    docUrl: SAMPLE_MESSAGES_DOC,
  },
  {
    id: "message-flow-optin",
    pattern: /\b(message\s*flow|opt[-\s]?in|consent)\b.*\b(unclear|missing|insufficient|not\s*(describ|provid|clear|specif)|vague|invalid)\b/i,
    title: "Opt-in / message flow isn't clear",
    remediation:
      "Explain exactly how customers agree to receive texts: where the consent form lives (URL), what checkbox or language they see, and that consent is not a condition of purchase. \"Customer fills out our contact form at example.com/contact and checks a box agreeing to receive SMS\" is the level of detail reviewers want.",
    docUrl: OPT_IN_DOC,
  },
  {
    id: "website-privacy",
    pattern: /\b(privacy\s*policy|privacy\s*notice)\b/i,
    title: "Website needs a public privacy policy",
    remediation:
      "Your website must have a publicly accessible privacy policy that mentions SMS/text messaging, states that customer data (including phone numbers) is not shared with third parties for marketing, and explains how to opt out. Add or update /privacy on your site before resubmitting.",
    docUrl: PRIVACY_POLICY_DOC,
  },
  {
    id: "website-sms-disclosure",
    pattern: /\b(website|web\s*site|url|landing\s*page)\b.*\b(sms|text\s*messag|messaging\s*program|opt[-\s]?in|disclosure)\b/i,
    title: "Website doesn't disclose your SMS program",
    remediation:
      "The website you provided must visibly describe your SMS program: what messages you'll send, how often, message & data rates disclosure, and how to opt out. Many owners add this to a /sms-terms page or directly next to the phone-number field on the contact form.",
    docUrl: OPT_IN_DOC,
  },
  {
    id: "website-unreachable",
    pattern: /\b(website|url|domain)\b.*\b(unreachable|inaccessible|not\s*(found|accessible|reach)|404|down|invalid|broken)\b/i,
    title: "Website couldn't be reached",
    remediation:
      "Reviewers couldn't load the URL you provided. Make sure the site is live over HTTPS, returns a 200 OK from a public browser (no login required), and that you used the full URL including https://.",
    docUrl: TWILIO_A2P_TROUBLESHOOTING,
  },
  {
    id: "shaft-content",
    pattern: /\b(shaft|sex|hate|alcohol|firearms?|tobacco|cannabis|cbd|marijuana|vape)\b/i,
    title: "Content category isn't allowed on 10DLC",
    remediation:
      "US carriers prohibit certain content categories on 10DLC (commonly called SHAFT: Sex, Hate, Alcohol, Firearms, Tobacco, plus cannabis/CBD). Remove any references to these topics from your campaign description and sample messages. If your business genuinely needs to text about these topics, you'll need toll-free verification or short-code messaging instead.",
    docUrl: TWILIO_A2P_TROUBLESHOOTING,
  },
  {
    id: "prohibited-loans-debt",
    pattern: /\b(loan|payday|debt|gambling|lottery|sweepstakes|cryptocurrency|crypto)\b/i,
    title: "Content category is restricted on 10DLC",
    remediation:
      "Loans, debt collection, gambling, sweepstakes, and cryptocurrency content are heavily restricted or banned on 10DLC. Remove these references from your campaign description and samples, or contact Twilio support to discuss vetting options if this is your actual business.",
    docUrl: TWILIO_A2P_TROUBLESHOOTING,
  },
  {
    id: "shortened-url",
    pattern: /\b(shorten(ed)?\s*url|public\s*url\s*shortener|bit\.ly|tinyurl|goo\.gl|t\.co)\b/i,
    title: "Public URL shorteners aren't allowed",
    remediation:
      "Carriers reject messages that use public URL shorteners (bit.ly, tinyurl, etc.) because they can hide malicious destinations. Use full URLs on your own domain, or a branded shortener you control (e.g. links.yourdomain.com).",
    docUrl: TWILIO_A2P_TROUBLESHOOTING,
  },
  {
    id: "brand-score-low",
    pattern: /\b(brand\s*score|trust\s*score|low\s*score|insufficient\s*(score|trust|vetting))\b/i,
    title: "Brand trust score is too low",
    remediation:
      "The Campaign Registry rated your brand below the threshold for this use case. The most common fixes are: provide the exact legal name and EIN as filed with the IRS, use a corporate email on your domain (not gmail.com), and add a public website with a privacy policy. After fixing, you can also request external vetting from Twilio for a higher score.",
    docUrl: TCR_VETTING_DOC,
  },
  {
    id: "usecase-mismatch",
    pattern: /\b(use\s*case|usecase)\b.*\b(mismatch|do(es)?\s*not\s*match|wrong|incorrect|inappropriate|invalid)\b/i,
    title: "Use case doesn't match your sample messages",
    remediation:
      "The use case you selected (e.g. Customer Care) must match what your sample messages actually do. If your samples include promotions or offers, pick Marketing or Mixed instead. If they're appointment reminders and service updates, Customer Care is correct.",
    docUrl: TWILIO_A2P_TROUBLESHOOTING,
  },
  {
    id: "duplicate-brand",
    pattern: /\b(duplicate|already\s*(exists|registered)|previously\s*registered)\b/i,
    title: "Brand is already registered",
    remediation:
      "The Campaign Registry already has a brand for this EIN. Don't create a new one — re-use the existing brand. If you don't recognize it, contact Twilio support to have the duplicate cleaned up before resubmitting.",
    docUrl: TWILIO_A2P_TROUBLESHOOTING,
  },
  {
    id: "rep-email-personal",
    pattern: /\b(email|e[-\s]?mail)\b.*\b(personal|free|gmail|yahoo|hotmail|outlook|not\s*(corporate|business))\b/i,
    title: "Representative email should be on your business domain",
    remediation:
      "A free email (gmail.com, yahoo.com, etc.) lowers your brand score and can trigger rejection. Use an email on your business domain (e.g. owner@yourbusiness.com) for the authorized representative.",
    docUrl: TCR_VETTING_DOC,
  },
  {
    id: "rep-phone-invalid",
    pattern: /\b(phone|contact\s*number)\b.*\b(invalid|incorrect|unreachable|unverif|not\s*(valid|reach))\b/i,
    title: "Representative phone number couldn't be verified",
    remediation:
      "The representative phone number must be a real, reachable US number in E.164 format (e.g. +19545551234). Use a number where Twilio or carriers could actually reach a person at your business if they had questions.",
    docUrl: TWILIO_A2P_TROUBLESHOOTING,
  },
];

export interface A2pRejectionMatch {
  hint: A2pRejectionHint;
}

// Supported locales for the remediation hints. English is the source of
// truth; any locale missing an entry falls back to the English copy on the
// hint itself. Add new locales by appending to this list and to
// `A2P_REJECTION_TRANSLATIONS` below.
export const A2P_SUPPORTED_LOCALES = ["en", "es"] as const;
export type A2pLocale = (typeof A2P_SUPPORTED_LOCALES)[number];

export interface A2pRejectionStrings {
  title: string;
  remediation: string;
}

// Translations for every hint, keyed by locale then by hint id. English is
// omitted because it lives directly on the hint above. To add a language,
// add a new top-level key here and provide an entry for every hint id.
const A2P_REJECTION_TRANSLATIONS: Partial<
  Record<Exclude<A2pLocale, "en">, Record<string, A2pRejectionStrings>>
> = {
  es: {
    "ein-mismatch": {
      title: "El EIN no coincide con los registros del IRS o del Estado",
      remediation:
        "El EIN (número de identificación fiscal) que proporcionaste no se pudo verificar con los registros del IRS ni del Secretario de Estado para el nombre legal del negocio. Verifica el EIN de 9 dígitos en tu carta CP-575 del IRS y asegúrate de que el nombre legal del negocio sea exactamente como aparece allí (sin nombres comerciales ni abreviaturas).",
    },
    "legal-name-mismatch": {
      title: "El nombre legal del negocio no coincide con los registros",
      remediation:
        "El nombre legal del negocio no coincide con lo que el IRS o el Secretario de Estado tienen registrado. Usa el nombre exacto tal como está registrado (incluyendo 'LLC' o 'Inc.' si corresponde) y evita usar nombres comerciales o DBAs en este campo.",
    },
    "address-mismatch": {
      title: "La dirección del negocio no coincide con los registros",
      remediation:
        "La dirección que figura en el IRS o en el Secretario de Estado debe coincidir con la que ingresaste aquí. Usa la dirección registrada de la sede principal (no un apartado postal ni una oficina virtual) e incluye el número de suite si lo tienes.",
    },
    "samples-missing-optout": {
      title: "Los mensajes de muestra deben incluir instrucciones para darse de baja",
      remediation:
        "Cada mensaje de muestra debe mostrar cómo los destinatarios pueden darse de baja. Agrega un texto como \"Responde STOP para cancelar\" (e idealmente \"Responde HELP para ayuda\") en cada muestra para que los revisores vean que las instrucciones para darse de baja forman parte de tus mensajes.",
    },
    "samples-missing-brand": {
      title: "Los mensajes de muestra deben identificar a tu negocio",
      remediation:
        "Cada mensaje de muestra debe identificar claramente el nombre de tu negocio en el cuerpo del texto. Modifica las muestras para que comiencen con algo como \"Hola {{1}}, te escribimos de [Nombre de tu negocio]…\" para que el destinatario sepa quién le está enviando el mensaje.",
    },
    "samples-generic": {
      title: "Los mensajes de muestra son demasiado genéricos",
      remediation:
        "Los revisores necesitan ejemplos concretos de los mensajes reales que enviarás. Reemplaza los textos genéricos por muestras realistas que incluyan el nombre del negocio, el motivo del mensaje, variables en formato {{1}} y la línea de baja con STOP.",
    },
    "message-flow-optin": {
      title: "El flujo de consentimiento (opt-in) no es claro",
      remediation:
        "Explica exactamente cómo los clientes aceptan recibir mensajes: dónde se encuentra el formulario de consentimiento (URL), qué casilla o texto ven, y que el consentimiento no es condición para realizar una compra. \"El cliente completa nuestro formulario de contacto en ejemplo.com/contacto y marca una casilla aceptando recibir SMS\" es el nivel de detalle que los revisores esperan.",
    },
    "website-privacy": {
      title: "El sitio web necesita una política de privacidad pública",
      remediation:
        "Tu sitio web debe tener una política de privacidad accesible públicamente que mencione el envío de mensajes SMS/texto, que indique que los datos del cliente (incluido el número de teléfono) no se comparten con terceros con fines de marketing y que explique cómo darse de baja. Agrega o actualiza /privacy en tu sitio antes de volver a enviar.",
    },
    "website-sms-disclosure": {
      title: "El sitio web no informa sobre tu programa de SMS",
      remediation:
        "El sitio web que proporcionaste debe describir claramente tu programa de SMS: qué mensajes enviarás, con qué frecuencia, la divulgación de tarifas de mensajes y datos, y cómo darse de baja. Muchos dueños añaden esta información en una página /sms-terms o directamente junto al campo de teléfono en el formulario de contacto.",
    },
    "website-unreachable": {
      title: "No se pudo acceder al sitio web",
      remediation:
        "Los revisores no pudieron cargar la URL que proporcionaste. Asegúrate de que el sitio esté activo en HTTPS, que devuelva un 200 OK desde un navegador público (sin requerir inicio de sesión) y que hayas usado la URL completa incluyendo https://.",
    },
    "shaft-content": {
      title: "La categoría de contenido no está permitida en 10DLC",
      remediation:
        "Las operadoras de EE.UU. prohíben ciertas categorías de contenido en 10DLC (conocidas como SHAFT: Sexo, Odio, Alcohol, Armas, Tabaco, además de cannabis/CBD). Elimina cualquier referencia a estos temas en la descripción de tu campaña y en los mensajes de muestra. Si tu negocio realmente necesita enviar mensajes sobre estos temas, deberás usar verificación de números toll-free o mensajería de código corto.",
    },
    "prohibited-loans-debt": {
      title: "La categoría de contenido está restringida en 10DLC",
      remediation:
        "El contenido relacionado con préstamos, cobro de deudas, apuestas, sorteos y criptomonedas está muy restringido o prohibido en 10DLC. Elimina estas referencias de la descripción de tu campaña y de las muestras, o contacta al soporte de Twilio para discutir opciones de verificación si este es realmente tu rubro.",
    },
    "shortened-url": {
      title: "No se permiten acortadores de URL públicos",
      remediation:
        "Las operadoras rechazan mensajes que usan acortadores de URL públicos (bit.ly, tinyurl, etc.) porque pueden ocultar destinos maliciosos. Usa URLs completas de tu propio dominio o un acortador con marca propia que tú controles (por ejemplo, links.tudominio.com).",
    },
    "brand-score-low": {
      title: "La puntuación de confianza de la marca es demasiado baja",
      remediation:
        "The Campaign Registry calificó a tu marca por debajo del umbral para este caso de uso. Las soluciones más comunes son: proporcionar el nombre legal exacto y el EIN como figuran en el IRS, usar un correo corporativo en tu propio dominio (no gmail.com) y agregar un sitio web público con política de privacidad. Después de corregir esto, también puedes solicitar verificación externa a Twilio para obtener una mejor puntuación.",
    },
    "usecase-mismatch": {
      title: "El caso de uso no coincide con tus mensajes de muestra",
      remediation:
        "El caso de uso que seleccionaste (por ejemplo, Atención al cliente) debe coincidir con lo que hacen tus mensajes de muestra. Si tus muestras incluyen promociones u ofertas, elige Marketing o Mixto. Si son recordatorios de citas y actualizaciones de servicio, Atención al cliente es lo correcto.",
    },
    "duplicate-brand": {
      title: "La marca ya está registrada",
      remediation:
        "The Campaign Registry ya tiene una marca registrada para este EIN. No crees una nueva: reutiliza la marca existente. Si no la reconoces, contacta al soporte de Twilio para que eliminen el duplicado antes de volver a enviar.",
    },
    "rep-email-personal": {
      title: "El correo del representante debe estar en el dominio del negocio",
      remediation:
        "Un correo gratuito (gmail.com, yahoo.com, etc.) reduce tu puntuación de marca y puede causar el rechazo. Usa un correo del dominio de tu negocio (por ejemplo, dueño@tunegocio.com) para el representante autorizado.",
    },
    "rep-phone-invalid": {
      title: "No se pudo verificar el número de teléfono del representante",
      remediation:
        "El número de teléfono del representante debe ser un número de EE.UU. real y accesible, en formato E.164 (por ejemplo, +19545551234). Usa un número donde Twilio o las operadoras realmente puedan comunicarse con una persona de tu negocio si tuvieran preguntas.",
    },
  },
};

const A2P_LOCALE_STORAGE_KEY = "preferredLanguage";

function normalizeLocale(raw: string | null | undefined): A2pLocale {
  if (!raw) return "en";
  const base = raw.toLowerCase().split(/[-_]/)[0];
  return (A2P_SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as A2pLocale)
    : "en";
}

/**
 * Resolve the locale the A2P remediation hints should render in. Prefers an
 * explicit `preferredLanguage` value in localStorage (so settings pages can
 * override), then falls back to `navigator.language`, then to English.
 */
export function resolveA2pLocale(): A2pLocale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage?.getItem(A2P_LOCALE_STORAGE_KEY);
    if (stored) return normalizeLocale(stored);
  } catch {
    // localStorage may throw in private mode; fall through to navigator.
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : null;
  return normalizeLocale(nav);
}

/**
 * Look up the localized title + remediation for a hint, falling back to the
 * English copy on the hint when a translation is missing.
 */
export function getA2pRejectionStrings(
  hint: A2pRejectionHint,
  locale: A2pLocale,
): A2pRejectionStrings {
  if (locale === "en") {
    return { title: hint.title, remediation: hint.remediation };
  }
  const localized = A2P_REJECTION_TRANSLATIONS[locale]?.[hint.id];
  if (localized) return localized;
  return { title: hint.title, remediation: hint.remediation };
}

/**
 * Find the first rejection hint whose pattern matches the verbatim Twilio
 * rejection text. Returns null when nothing matches so callers can render
 * the raw reason unchanged.
 */
export function matchA2pRejection(text: string | null | undefined): A2pRejectionMatch | null {
  if (!text) return null;
  for (const hint of A2P_REJECTION_HINTS) {
    if (hint.pattern.test(text)) {
      return { hint };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Promote to KB" helpers
//
// Owners turn a reviewed staff suggestion into a ready-to-paste
// `A2pRejectionHint` block they can drop straight into the
// `A2P_REJECTION_HINTS` array above. These helpers are pure (no DOM / network)
// so they can be unit tested and reused by the Messages admin panel.
// ---------------------------------------------------------------------------

// Common words we never want to anchor a generated pattern on — they're too
// generic to distinguish one rejection from another.
const PATTERN_STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "you", "this", "that", "are", "was",
  "were", "not", "but", "from", "have", "has", "had", "will", "would", "can",
  "could", "should", "must", "may", "our", "their", "there", "been", "into",
  "out", "any", "all", "its", "it's", "they", "them", "than", "then", "when",
  "what", "which", "who", "why", "how", "please", "due", "see", "use", "used",
  "using", "provide", "provided", "because", "about", "more", "some", "such",
]);

/**
 * Turn a free-text title into a stable kebab-case hint id (matching the style
 * of the existing ids like "ein-mismatch"). Falls back to "custom-rejection"
 * when nothing usable remains.
 */
export function slugifyHintId(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .split("-")
    .slice(0, 5)
    .join("-");
  return slug || "custom-rejection";
}

/**
 * Build a sensible default regex *source* string from a verbatim rejection
 * reason. We pick the few most distinctive words, escape them, and join them
 * with `.*` so the pattern matches the same family of rejections without being
 * pinned to the exact wording. Owners are expected to review/tweak this before
 * committing — it's a starting point, not a guarantee.
 */
export function suggestPatternFromReason(reason: string): string {
  const words = (reason.toLowerCase().match(/[a-z][a-z']{2,}/g) || [])
    .filter((w) => !PATTERN_STOPWORDS.has(w));
  // De-dupe while preserving order, then keep the first handful.
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    keywords.push(w);
    if (keywords.length >= 4) break;
  }
  if (keywords.length === 0) return ".*";
  const escaped = keywords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escaped.map((w) => `\\b${w}\\b`).join(".*");
}

export interface A2pHintDraft {
  id: string;
  pattern: string;
  title: string;
  remediation: string;
  docUrl: string;
}

export function isA2pSuggestionExportEligible(status: string): boolean {
  return status === "reviewed";
}

// Escape a value so it's safe inside a double-quoted TypeScript string
// literal: backslashes, double quotes, and control characters (newlines,
// tabs, carriage returns) all get escaped so the emitted snippet always
// stays on one valid line and compiles when pasted.
function escapeForTemplate(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

// Escape an unescaped forward slash so the regex source can be embedded in a
// `/.../` literal without prematurely closing it. We leave already-escaped
// slashes (`\/`) alone so we don't double-escape.
function escapeRegexLiteralSource(source: string): string {
  return source.replace(/\\.|\//g, (m) => (m === "/" ? "\\/" : m));
}

/**
 * Render a copy-paste-ready `A2pRejectionHint` object literal (TypeScript
 * source) from a draft. `pattern` is emitted as a `/.../i` regex literal; the
 * other fields become double-quoted strings.
 */
export function buildA2pHintSnippet(draft: A2pHintDraft): string {
  const id = draft.id.trim() || "custom-rejection";
  const pattern = escapeRegexLiteralSource(draft.pattern.trim() || ".*");
  const title = escapeForTemplate(draft.title.trim());
  const remediation = escapeForTemplate(draft.remediation.trim());
  const docUrl = escapeForTemplate(draft.docUrl.trim() || TWILIO_A2P_TROUBLESHOOTING);
  return [
    "  {",
    `    id: "${escapeForTemplate(id)}",`,
    `    pattern: /${pattern}/i,`,
    `    title: "${title}",`,
    `    remediation:`,
    `      "${remediation}",`,
    `    docUrl: "${docUrl}",`,
    "  },",
  ].join("\n");
}

/**
 * Render multiple hint drafts as consecutive entries ready to paste inside
 * `A2P_REJECTION_HINTS`. Keeping this as a pure helper makes single and batch
 * exports share exactly the same escaping and fallback behavior.
 */
export function buildA2pHintBatchSnippet(drafts: A2pHintDraft[]): string {
  const requestedIds = new Set(
    drafts.map((draft) => draft.id.trim() || "custom-rejection"),
  );
  const emittedIds = new Set<string>();
  return drafts
    .map((draft) => {
      const baseId = draft.id.trim() || "custom-rejection";
      let id = baseId;
      if (emittedIds.has(id)) {
        let suffix = 2;
        do {
          id = `${baseId}-${suffix}`;
          suffix += 1;
        } while (requestedIds.has(id) || emittedIds.has(id));
      }
      emittedIds.add(id);
      return buildA2pHintSnippet({
        ...draft,
        id,
      });
    })
    .join("\n");
}
