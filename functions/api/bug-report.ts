// POST /api/bug-report — a Cloudflare Pages Function: turns the app's bug report into a GitHub
// issue, so the user only clicks Send. GitHub's API can't attach files to an issue, so the
// screenshot and the full context are committed to the `bug-reports` branch (an orphan branch,
// never merged; `[skip ci]` keeps Cloudflare from building it) and the issue links to them.
//
// Configuration, in the Cloudflare project's settings:
//   GITHUB_TOKEN (secret)  fine-grained token for the repository: Issues + Contents read/write
//   GITHUB_REPO (optional) owner/name, default albertomors/map2stl

interface Env {
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
}

interface Context {
  request: Request;
  env: Env;
}

const BRANCH = 'bug-reports';
const MAX_MESSAGE = 5_000;
const MAX_CONTEXT = 300_000; // bytes of JSON
const MAX_SCREENSHOT = 4_000_000; // bytes

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  if (!env.GITHUB_TOKEN) return json({ error: 'Reports are not configured on this server.' }, 503);
  const repo = env.GITHUB_REPO ?? 'albertomors/map2stl';

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Malformed report.' }, 400);
  }
  // A field people never see: bots fill it in. Pretend it worked.
  if (form.get('website')) return json({ id: '00000000' });

  // multipart turns line breaks into CRLF
  const message = String(form.get('message') ?? '').replace(/\r\n?/g, '\n').trim();
  const contextText = String(form.get('context') ?? '');
  const shot = form.get('screenshot');
  if (!message || message.length > MAX_MESSAGE) return json({ error: 'The description is empty or too long.' }, 400);
  if (contextText.length > MAX_CONTEXT) return json({ error: 'The report is too large.' }, 413);
  let context: Record<string, any> = {};
  try {
    context = JSON.parse(contextText || '{}');
  } catch {
    return json({ error: 'Malformed report.' }, 400);
  }
  const screenshot = shot instanceof File && shot.size > 0 && shot.size <= MAX_SCREENSHOT && shot.type === 'image/png' ? shot : null;

  const gh = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'map2stl-bug-report',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });

  // What the user is told: a random code, not the issue's number (which would say how many
  // there are). It's in the issue's title and folder, so a report can be found by it.
  const code = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const id = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${code}`;

  // Files first, so the issue can link them. The branch is created on the first report.
  const put = async (name: string, bytes: Uint8Array) => {
    const body = JSON.stringify({ message: `bug report ${id}: ${name} [skip ci]`, branch: BRANCH, content: base64(bytes) });
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await gh(`/contents/reports/${id}/${name}`, { method: 'PUT', body });
      if (res.ok) return true;
      if (res.status === 404 && attempt === 0 && (await createBranch())) continue;
      if (res.status === 409) continue; // a concurrent report moved the branch: retry
      console.error('upload failed', name, res.status, await res.text());
      return false;
    }
    return false;
  };
  const createBranch = async () => {
    const head = await gh(`/git/ref/heads/${BRANCH}`);
    if (head.ok) return true;
    const readme = 'Screenshots and context of the bug reports sent from the app; each issue links its own. Never merged.\n';
    const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: readme }] }) });
    if (!tree.ok) return false;
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: 'bug-reports branch [skip ci]', tree: ((await tree.json()) as { sha: string }).sha, parents: [] }),
    });
    if (!commit.ok) return false;
    const ref = await gh('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: ((await commit.json()) as { sha: string }).sha }),
    });
    return ref.ok || ref.status === 422; // 422: created meanwhile by another report
  };

  const enc = new TextEncoder();
  const fileUrl = (name: string) => `https://github.com/${repo}/blob/${BRANCH}/reports/${id}/${name}`;
  const hasContext = await put('context.json', enc.encode(JSON.stringify({ message, ...context }, null, 2)));
  const hasShot = screenshot ? await put('screenshot.png', new Uint8Array(await screenshot.arrayBuffer())) : false;

  const env_ = context.environment ?? {};
  const consoleLog: { at: string; level: string; message: string }[] = Array.isArray(context.console) ? context.console : [];
  const fence = (s: string) => '```\n' + s.replace(/```/g, "'''") + '\n```';
  const body = [
    message.replace(/^/gm, '> '),
    '',
    hasShot ? `![screenshot](${fileUrl('screenshot.png')}?raw=true)` : '_No screenshot._',
    '',
    `**Version** ${context.app?.version ?? '?'} · **URL** ${context.app?.url ?? '?'}`,
    `**Browser** ${env_.userAgent ?? '?'}`,
    `**GPU** ${env_.webgl ? `${env_.webgl.vendor} / ${env_.webgl.renderer}` : 'no WebGL2'}`,
    hasContext ? `**Full context** [context.json](${fileUrl('context.json')})` : '_Context upload failed._',
    consoleLog.length
      ? `\n<details><summary>Console (${consoleLog.length} recent errors/warnings)</summary>\n\n${fence(
          consoleLog.slice(-15).map((e) => `${e.at} ${e.level}: ${e.message}`).join('\n').slice(0, 20_000),
        )}\n</details>`
      : '',
    '',
    '<sub>Sent from the in-app bug report.</sub>',
  ].join('\n');

  const title = `Bug report ${code}: ${message.split('\n')[0].slice(0, 80)}`;
  const issue = await gh('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels: ['bug'] }) });
  if (!issue.ok) {
    console.error('issue failed', issue.status, await issue.text());
    return json({ error: 'GitHub refused the report.' }, 502);
  }
  return json({ id: code });
}
