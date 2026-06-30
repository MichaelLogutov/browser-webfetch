export type CaptchaType =
  | 'cloudflare'
  | 'hcaptcha'
  | 'recaptcha'
  | 'datadome'
  | 'servicepipe'
  | 'qrator'
  | 'soft_block'
  | 'generic_wall'
  | 'http_403';

export interface CaptchaDetection {
  detected: boolean;
  type?: CaptchaType;
  // Strong = an unambiguous anti-bot signature that cannot plausibly appear on
  // a real content page (dedicated captcha-widget assets, vendor-specific block
  // titles). Strong detections bypass the readable-content guard in fetch.ts;
  // weak ones (coincidental title/text heuristics — e.g. a real article titled
  // "Just a moment...") stay gated by it. Mirrors detectLoginWall's
  // strong-unconditional vs weak-content-gated split.
  strong?: boolean;
}

// Servicepipe (a Russian anti-DDoS/WAF) serves its captcha from dedicated asset
// paths and mounts it on a fixed root node — neither of which a real page would
// carry. The visible page is mostly "why you're blocked" boilerplate, so it
// routinely trips the >500-char content guard; hence it must be strong.
const SERVICEPIPE_SELECTOR =
  '[href*="sp_rotated_captcha"], [src*="sp_rotated_captcha"], #captcha_root.captcha-root';

// Qrator (a Russian anti-DDoS/WAF) serves its "Введите символы с картинки"
// captcha from the dedicated /__qrator/ auth path and mounts it on
// #wrapper-captcha. It is commonly returned with HTTP 401, which would
// otherwise route it to the login-wall path (which auto-resolves and closes
// the window). The asset path cannot appear on a real page, so it is strong.
const QRATOR_SELECTOR =
  '[src*="/__qrator/"], [src*="qauth"], #wrapper-captcha.captcha-page';

// Soft-block / "access temporarily restricted" interstitials (e.g. petrovich's
// own block page). No captcha to solve — surfacing the window lets the user
// wait / retry / switch network. The phrasing is specific to block pages, so a
// real article is very unlikely to match it.
const SOFT_BLOCK_TITLE_RE =
  /доступ\s+(?:временно\s+)?ограничен|access\s+(?:temporarily\s+)?(?:restricted|limited)/i;

export function detectCaptchaInDom(doc: Document, httpStatus = 200): CaptchaDetection {
  // Strong, status-independent signatures are checked first so a 403 (which the
  // site may return for the very same captcha) does not down-rank them to the
  // weak, content-gated http_403 type.
  if (doc.querySelector(SERVICEPIPE_SELECTOR)) {
    return { detected: true, type: 'servicepipe', strong: true };
  }

  if (doc.querySelector(QRATOR_SELECTOR)) {
    return { detected: true, type: 'qrator', strong: true };
  }

  if (httpStatus === 403 && doc.body && doc.documentElement) {
    return { detected: true, type: 'http_403' };
  }

  const title = (doc.title ?? '').trim();

  if (
    title === 'Just a moment...' ||
    doc.querySelector('#cf-wrapper') ||
    doc.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
    doc.querySelector('iframe[src*="turnstile"]')
  ) {
    return { detected: true, type: 'cloudflare' };
  }

  if (doc.querySelector('iframe[src*="hcaptcha.com"]')) {
    return { detected: true, type: 'hcaptcha' };
  }

  if (
    doc.querySelector('iframe[src*="recaptcha"]') ||
    doc.querySelector('.g-recaptcha')
  ) {
    return { detected: true, type: 'recaptcha' };
  }

  if (doc.querySelector('iframe[src*="datadome.co"]')) {
    return { detected: true, type: 'datadome' };
  }

  if (SOFT_BLOCK_TITLE_RE.test(title)) {
    return { detected: true, type: 'soft_block', strong: true };
  }

  if (/access denied|attention required|verifying you are human/i.test(title)) {
    return { detected: true, type: 'generic_wall' };
  }

  return { detected: false };
}

export function readableContentLength(doc: Document): number {
  const body = doc.body;
  if (!body) return 0;
  // `textContent` includes text inside <script>/<style>/<noscript>/<template>;
  // SPA shells (e.g. Grafana's inline bootdata) embed large JSON blobs there
  // that would masquerade as readable content. Strip them on a clone so the
  // live DOM is untouched.
  const clone = body.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll('script, style, noscript, template'))) {
    el.remove();
  }
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

export interface LoginWallDetection {
  detected: boolean;
  provider?: string;
}

// Identity-provider hosts a login redirect commonly lands on. Extend as needed
// (e.g. an internal SSO host). Matched as exact host or subdomain suffix.
const KNOWN_IDP_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'okta.com',
  'auth0.com',
  'login.yandex.ru',
  'oauth.yandex.ru',
  'github.com',
];

const LOGIN_PATH_RE = /(?:^|\/)(login|signin|sign-in|sso|oauth|oauth2|authorize|auth)(?:\/|$)/i;
const SIGNIN_TEXT_RE = /\b(sign[ -]?in|log[ -]?in|войти|authenticat|authoriz)\b/i;

export function detectLoginWall(
  doc: Document,
  httpStatus: number,
  finalUrl: string,
  requestedUrl: string,
): LoginWallDetection {
  const finalHost = hostOf(finalUrl);
  const reqHost = hostOf(requestedUrl);
  const crossOrigin = finalHost !== '' && reqHost !== '' && finalHost !== reqHost;

  // Strong signals — unconditional (never false positives, regardless of how
  // much content the page has, so they are checked before the content guard).
  if (httpStatus === 401) return { detected: true, provider: 'http_401' };
  if (crossOrigin) {
    const idp = KNOWN_IDP_HOSTS.find((h) => finalHost === h || finalHost.endsWith('.' + h));
    if (idp) return { detected: true, provider: idp };
  }
  if (LOGIN_PATH_RE.test(pathOf(finalUrl))) return { detected: true, provider: 'login_path' };

  // Content guard: substantial content on the *requested* origin is real
  // content, so only the weak heuristics below are gated by it.
  if (!crossOrigin && readableContentLength(doc) > 500) return { detected: false };

  // Weak signals — need at least two. (Only reached on sparse pages.)
  let weak = 0;
  if (doc.querySelector('input[type=password]')) weak++;
  if (hasSigninText(doc)) weak++;
  if (hasLoginLink(doc)) weak++;
  if (crossOrigin) weak++;
  if (weak >= 2) return { detected: true, provider: 'heuristic' };

  return { detected: false };
}

// Sign-in wording in the title or any heading / link / button — catches OAuth
// "Sign in with <provider>" pages that have no password field.
function hasSigninText(doc: Document): boolean {
  if (SIGNIN_TEXT_RE.test((doc.title ?? '').trim())) return true;
  for (const el of Array.from(doc.querySelectorAll('h1, h2, a, button'))) {
    if (SIGNIN_TEXT_RE.test(el.textContent ?? '')) return true;
  }
  return false;
}

// A link pointing at a login / OAuth / SSO / SAML endpoint.
function hasLoginLink(doc: Document): boolean {
  return Boolean(
    doc.querySelector('a[href*="login"], a[href*="oauth"], a[href*="sso"], a[href*="saml"]'),
  );
}

function hostOf(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}
