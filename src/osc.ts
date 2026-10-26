/**
 * 极简 OSC（Open Sound Control）编解码，只覆盖 VRChat 用得到的那部分。
 *
 * 规范要点（这里必须精确，错一个字节 VRChat 就当没收到）：
 *   - 字符串：内容 + 至少一个 \0，再补到 4 字节边界
 *   - int32 / float32：大端
 *   - 类型标签串以 ',' 开头，如 ",sTf"
 *   - 布尔用标签 T/F，不带负载字节
 */

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

/** 写入一个 OSC 字符串（含 null 与 4 字节对齐）。 */
function writeString(s: string): Buffer {
  const raw = Buffer.from(s, 'utf8');
  const total = raw.length + 1;                 // 结尾 null
  const padded = total + pad4(total);
  const out = Buffer.alloc(padded);
  raw.copy(out, 0);
  return out;                                    // 剩余字节已是 0
}

export type OscArg = number | string | boolean | Buffer;

/** 编码一条 OSC 消息。整数→i，非整数→f，布尔→T/F，字符串→s，Buffer→b。 */
export function encode(address: string, ...args: OscArg[]): Buffer {
  const tags: string[] = [];
  const payload: Buffer[] = [];

  for (const arg of args) {
    if (typeof arg === 'boolean') {
      tags.push(arg ? 'T' : 'F');
    } else if (typeof arg === 'string') {
      tags.push('s');
      payload.push(writeString(arg));
    } else if (Buffer.isBuffer(arg)) {
      tags.push('b');
      const size = Buffer.alloc(4);
      size.writeInt32BE(arg.length);
      payload.push(size, Buffer.concat([arg, Buffer.alloc(pad4(arg.length))]));
    } else if (Number.isInteger(arg)) {
      tags.push('i');
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg | 0);
      payload.push(b);
    } else {
      tags.push('f');
      const b = Buffer.alloc(4);
      b.writeFloatBE(arg);
      payload.push(b);
    }
  }

  return Buffer.concat([writeString(address), writeString(',' + tags.join('')), ...payload]);
}

export interface OscMessage {
  address: string;
  args: OscArg[];
}

/** 解码一条 OSC 消息；不是合法 OSC 就返回 null（不抛）。 */
export function decode(buf: Buffer): OscMessage | null {
  try {
    let offset = 0;

    const readString = (): string => {
      const end = buf.indexOf(0, offset);
      if (end < 0) throw new Error('字符串没有结尾 null');
      const str = buf.toString('utf8', offset, end);
      const total = end + 1 - offset;            // 含 null 的实际长度
      offset = end + 1 + pad4(total);
      return str;
    };

    const address = readString();
    if (!address.startsWith('/')) return null;
    const tagField = readString();
    if (!tagField.startsWith(',')) return null;

    const args: OscArg[] = [];
    for (const tag of tagField.slice(1)) {
      if (tag === 'i') {
        args.push(buf.readInt32BE(offset));
        offset += 4;
      } else if (tag === 'f') {
        args.push(buf.readFloatBE(offset));
        offset += 4;
      } else if (tag === 's') {
        args.push(readString());
      } else if (tag === 'T') {
        args.push(true);
      } else if (tag === 'F') {
        args.push(false);
      } else if (tag === 'b') {
        const size = buf.readInt32BE(offset);
        offset += 4;
        args.push(buf.subarray(offset, offset + size));
        offset += size + pad4(size);
      } else {
        break;                                    // 不认识的类型，放弃后面的
      }
    }
    return { address, args };
  } catch {
    return null;
  }
}
