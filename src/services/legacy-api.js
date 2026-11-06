import { apiErrorSource } from '../i18n.js';

export async function api(path, opts = {}) {
  let r = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: {
      ...(opts.body ? {
        'Content-Type': 'application/json'
      } : {}),
      ...opts.headers
    }
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error('Server tidak memberikan respons yang valid.');
  }
  if (!r.ok) {
    const e = new Error(apiErrorSource(data));
    e.status = r.status;
    throw e;
  }
  return data;
}
