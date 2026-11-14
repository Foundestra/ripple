const PART = '[a-z0-9][a-z0-9._-]*';
const patterns = {
  service: new RegExp(`^service://${PART}/${PART}$`),
  repository: new RegExp(`^repository://${PART}/${PART}$`),
  component: new RegExp(`^component://${PART}/${PART}/${PART}$`),
  deployment: new RegExp(`^deployment://${PART}/${PART}$`),
};
export function validId(value, kind) { return typeof value === 'string' && Boolean(patterns[kind]?.test(value)); }
export function assertId(value, kind) {
  if (!validId(value, kind)) throw Object.assign(new Error(`Invalid ${kind} identity`), { code: 'INVALID_ID' });
  return value;
}
export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 1024 &&
    !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) &&
    !path.split('/').some(part => part === '..' || part === '.' || part === '');
}
