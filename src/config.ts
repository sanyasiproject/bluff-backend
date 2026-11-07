export const PORT = Number(process.env.PORT) || 3001;

/** comma-separated frontend URLs, e.g. https://my-bluff.vercel.app */
export const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const LOCAL_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

/** Without CLIENT_ORIGIN only localhost and home-network origins may connect */
export function isAllowedOrigin(origin: string | undefined): boolean {
  // non-browser clients send no Origin header; browser rules don't apply to them
  if (!origin) return true;
  return CLIENT_ORIGINS.length > 0 ? CLIENT_ORIGINS.includes(origin) : LOCAL_ORIGIN.test(origin);
}
