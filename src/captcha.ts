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
