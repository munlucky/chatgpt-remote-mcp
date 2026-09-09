export type ProcessOutputStream = "stdout" | "stderr";

export interface ProcessOutputChunk {
  seq: number;
  stream: ProcessOutputStream;
  data: Buffer;
}

export interface ProcessOutputSelection {
  chunks: ProcessOutputChunk[];
  nextSeq: number;
  hasMore: boolean;
  selectedBytes: number;
}

const COMPACT_HEAD_THRESHOLD = 4096;

/**
 * Append-only process output with a logical head. Sequence numbers remain
 * contiguous, so an afterSeq cursor maps directly to an array offset instead
 * of scanning every retained chunk. Old chunks are evicted by advancing the
 * head; occasional compaction keeps the backing array bounded without putting
 * Array.shift() on the output hot path.
 */
export class IndexedProcessOutputBuffer {
  #chunks: ProcessOutputChunk[] = [];
  #headIndex = 0;
  #baseSeq = 1;
  #nextSeq = 1;
  #retainedBytes = 0;
  #droppedBytes = 0;

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  get droppedBytes(): number {
    return this.#droppedBytes;
  }

  get latestSeq(): number {
    return this.#nextSeq - 1;
  }

  get retainedChunkCount(): number {
    return this.#chunks.length - this.#headIndex;
  }

  append(stream: ProcessOutputStream, chunks: readonly Buffer[]): void {
    for (const data of chunks) {
      this.#chunks.push({ seq: this.#nextSeq, stream, data });
      this.#nextSeq += 1;
      this.#retainedBytes += data.length;
    }
  }

  trimTo(maxBytes: number): number {
    let dropped = 0;
    while (
      this.#retainedBytes > maxBytes &&
      this.#headIndex < this.#chunks.length
    ) {
      const removed = this.#chunks[this.#headIndex]!;
      this.#headIndex += 1;
      this.#baseSeq = removed.seq + 1;
      this.#retainedBytes -= removed.data.length;
      this.#droppedBytes += removed.data.length;
      dropped += removed.data.length;
    }
    this.#compactIfNeeded();
    return dropped;
  }

  selectAfter(afterSeq: number, maxBytes: number): ProcessOutputSelection {
    if (this.#headIndex >= this.#chunks.length || this.#nextSeq <= afterSeq + 1) {
      return { chunks: [], nextSeq: afterSeq, hasMore: false, selectedBytes: 0 };
    }

    const requestedSeq = Math.max(afterSeq + 1, this.#baseSeq);
    if (requestedSeq >= this.#nextSeq) {
      return { chunks: [], nextSeq: afterSeq, hasMore: false, selectedBytes: 0 };
    }

    const logicalOffset = requestedSeq - this.#baseSeq;
    let index = this.#headIndex + logicalOffset;
    const selected: ProcessOutputChunk[] = [];
    let selectedBytes = 0;

    while (index < this.#chunks.length) {
      const chunk = this.#chunks[index]!;
      if (selectedBytes + chunk.data.length > maxBytes) {
        break;
      }
      selected.push(chunk);
      selectedBytes += chunk.data.length;
      index += 1;
    }

    return {
      chunks: selected,
      nextSeq: selected.at(-1)?.seq ?? afterSeq,
      hasMore: index < this.#chunks.length,
      selectedBytes,
    };
  }

  #compactIfNeeded(): void {
    if (this.#headIndex === 0) {
      return;
    }
    if (this.#headIndex === this.#chunks.length) {
      this.#chunks = [];
      this.#headIndex = 0;
      this.#baseSeq = this.#nextSeq;
      return;
    }
    if (
      this.#headIndex >= COMPACT_HEAD_THRESHOLD ||
      this.#headIndex * 2 >= this.#chunks.length
    ) {
      this.#chunks = this.#chunks.slice(this.#headIndex);
      this.#headIndex = 0;
    }
  }
}
