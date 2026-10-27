/**
 * OSCQuery 发现：VRChat 会起一个 HTTP 服务，`GET /?HOST_INFO` 返回它的 OSC 配置，
 * 其中 OSC_PORT 是它**监听指令**的端口（也就是我们要发的那个）。
 *
 * 用途只有一个：端口别写死。有人把 VRChat 的 OSC 端口改过、或者同一台机器开了两个实例，
 * 自动发现比「照着 README 改配置」省事。
 *
 * 失败一律当作「没发现」，回退到配置里的固定端口 —— 不让发现流程挡住启动。
 */

export interface OscQueryInfo {
  /** 往哪发（VRChat 监听的端口）。 */
  outPort: number;
  /** VRChat 在 HOST_INFO 里自报的 IP，通常是 127.0.0.1。 */
  host: string;
  /** 原样保留，调试时看。 */
  raw?: Record<string, unknown>;
}

/** `?HOST_INFO` 的返回体里找端口：OSC_PORT 是标准名，EXTENSIONS 里也可能带。 */
function pickPort(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const direct = Number(obj.OSC_PORT);
  if (Number.isInteger(direct) && direct > 0 && direct < 65536) return direct;
  return null;
}

/**
 * 试一次发现。超时、连不上、返回不是 JSON，都返回 null。
 */
export async function discoverOscQuery(
  host = '127.0.0.1',
  port = 9001,
  timeoutMs = 1200,
): Promise<OscQueryInfo | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = `http://${host}:${port}/?HOST_INFO`;
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const outPort = pickPort(json);
    if (!outPort) return null;
    return {
      outPort,
      host: typeof json.OSC_IP === 'string' && json.OSC_IP ? json.OSC_IP : host,
      raw: json,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
