import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_ATTACHMENT_BYTES } from "./config.js";
import { newId, type Attachment } from "./store.js";

const SHA256 = /^[0-9a-f]{64}$/;

export class BlobRejected extends Error {}

function assertSha256(sha256: string): void {
  if (!SHA256.test(sha256)) throw new BlobRejected(`invalid sha256 "${sha256}"`);
}

export class Blobs {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(sha256: string): string {
    assertSha256(sha256);
    return join(this.dir, sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.path(sha256));
  }

  async addFile(file: string): Promise<Attachment> {
    const { sha256, size } = await this.write(createReadStream(file));
    return { name: basename(file), sha256, size };
  }

  async receive(expectedSha256: string, source: Readable): Promise<void> {
    assertSha256(expectedSha256);
    const { sha256 } = await this.write(source, expectedSha256);
    if (sha256 !== expectedSha256) throw new BlobRejected(`content hash ${sha256} does not match ${expectedSha256}`);
  }

  private async write(source: Readable, expected?: string): Promise<{ sha256: string; size: number }> {
    const tmp = join(this.dir, `.incoming-${newId()}`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            size += chunk.length;
            if (size > MAX_ATTACHMENT_BYTES) throw new BlobRejected(`attachment larger than ${MAX_ATTACHMENT_BYTES} bytes`);
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
      const sha256 = hash.digest("hex");
      if (expected === undefined || sha256 === expected) renameSync(tmp, this.path(sha256));
      return { sha256, size };
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
