export type CaptchaType =
  | 'cloudflare'
  | 'hcaptcha'
  | 'recaptcha'
  | 'datadome'
  | 'generic_wall'
  | 'http_403';

export interface CaptchaDetection {
  detected: boolean;
  type?: CaptchaType;
}

export function detectCaptchaInDom(doc: Document, httpStatus = 200): CaptchaDetection {
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

  if (/access denied|attention required|verifying you are human/i.test(title)) {
    return { detected: true, type: 'generic_wall' };
  }

  return { detected: false };
}

export function readableContentLength(doc: Document): number {
  return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().length;
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

  // Guard: substantial content on the *requested* origin is real content, not a
  // wall. Only applies when we did not get redirected away.
  if (!crossOrigin && readableContentLength(doc) > 500) return { detected: false };

  // Strong signals — any one suffices.
  if (httpStatus === 401) return { detected: true, provider: 'http_401' };
  if (crossOrigin) {
    const idp = KNOWN_IDP_HOSTS.find((h) => finalHost === h || finalHost.endsWith('.' + h));
    if (idp) return { detected: true, provider: idp };
  }
  if (LOGIN_PATH_RE.test(pathOf(finalUrl))) return { detected: true, provider: 'login_path' };

  // Weak signals — need at least two.
  let weak = 0;
  if (doc.querySelector('input[type=password]')) weak++;
  const title = (doc.title ?? '').trim();
  const heading = doc.querySelector('h1')?.textContent ?? '';
  if (SIGNIN_TEXT_RE.test(title) || SIGNIN_TEXT_RE.test(heading)) weak++;
  if (crossOrigin) weak++;
  if (weak >= 2) return { detected: true, provider: 'heuristic' };

  return { detected: false };
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
