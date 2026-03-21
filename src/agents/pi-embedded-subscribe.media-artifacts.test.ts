import { describe, expect, it, vi } from "vitest";
import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

/** Flush microtasks (emitBlockReplySafely dispatches via Promise.resolve). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("media artifact collect-then-attach", () => {
  it("emits block reply for streamed text after microtask flush", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello world" });
    emitAssistantTextEnd({ emit });
    await flush();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload: BlockReplyPayload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello world");
  });

  it("attaches details.media artifact to the next assistant block reply", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    // Tool produces media via details.media (no MEDIA: in text)
    emit({ type: "tool_execution_start", toolName: "image_generate", toolCallId: "tc2", args: {} });
    await flush();
    emit({
      type: "tool_execution_end",
      toolName: "image_generate",
      toolCallId: "tc2",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated 1 image." }],
        details: { media: { mediaUrls: ["/tmp/cat.png"] } },
      },
    });
    await flush();

    // Next assistant message (no MEDIA: in text)
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Here is your cat!" });
    emitAssistantTextEnd({ emit });
    await flush();

    const mediaReplies = onBlockReply.mock.calls
      .map((c: unknown[]) => c[0] as BlockReplyPayload)
      .filter((p) => p.mediaUrls?.length);
    expect(mediaReplies.length).toBeGreaterThan(0);
    expect(mediaReplies[0].text).toBe("Here is your cat!");
    expect(mediaReplies[0].mediaUrls).toEqual(["/tmp/cat.png"]);
  });

  it("flushes orphaned artifacts at agent end when no text follows", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "tool_execution_start", toolName: "tts", toolCallId: "tc3", args: {} });
    await flush();
    emit({
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc3",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated speech audio." }],
        details: { media: { mediaUrl: "/tmp/voice.opus", audioAsVoice: true } },
      },
    });
    await flush();

    // No assistant text, agent ends directly
    emit({ type: "agent_end" });
    await flush();

    const mediaReplies = onBlockReply.mock.calls
      .map((c: unknown[]) => c[0] as BlockReplyPayload)
      .filter((p) => p.mediaUrls?.length || p.audioAsVoice);
    expect(mediaReplies.length).toBeGreaterThan(0);
    expect(mediaReplies[0].mediaUrls).toEqual(["/tmp/voice.opus"]);
    expect(mediaReplies[0].audioAsVoice).toBe(true);
  });

  it("does not deliver artifacts prematurely on pre-tool flush", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    // First tool produces media
    emit({ type: "tool_execution_start", toolName: "image_generate", toolCallId: "tc4", args: {} });
    await flush();
    emit({
      type: "tool_execution_end",
      toolName: "image_generate",
      toolCallId: "tc4",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated 1 image." }],
        details: { media: { mediaUrls: ["/tmp/first.png"] } },
      },
    });
    await flush();

    // Second tool starts (triggers flushBlockReplyBuffer)
    emit({ type: "tool_execution_start", toolName: "browser", toolCallId: "tc5", args: {} });
    await flush();

    // No standalone media-only reply should exist
    const prematureMedia = onBlockReply.mock.calls
      .map((c: unknown[]) => c[0] as BlockReplyPayload)
      .filter((p) => p.mediaUrls?.includes("/tmp/first.png"));
    expect(prematureMedia).toHaveLength(0);

    emit({
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: "tc5",
      isError: false,
      result: { content: [{ type: "text", text: "done" }] },
    });
    await flush();

    // Assistant reply carries the artifact
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "All done!" });
    emitAssistantTextEnd({ emit });
    await flush();

    const withMedia = onBlockReply.mock.calls
      .map((c: unknown[]) => c[0] as BlockReplyPayload)
      .filter((p) => p.mediaUrls?.includes("/tmp/first.png"));
    expect(withMedia.length).toBeGreaterThan(0);
    expect(withMedia[0].text).toBe("All done!");
  });

  it("filters local paths from untrusted tools", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "tool_execution_start", toolName: "sketchy_plugin", toolCallId: "tc6", args: {} });
    await flush();
    emit({
      type: "tool_execution_end",
      toolName: "sketchy_plugin",
      toolCallId: "tc6",
      isError: false,
      result: {
        content: [{ type: "text", text: "done" }],
        details: { media: { mediaUrls: ["/etc/passwd"] } },
      },
    });
    await flush();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Done." });
    emitAssistantTextEnd({ emit });
    emit({ type: "agent_end" });
    await flush();

    const anyMedia = onBlockReply.mock.calls
      .map((c: unknown[]) => c[0] as BlockReplyPayload)
      .filter((p) => p.mediaUrls?.length);
    expect(anyMedia).toHaveLength(0);
  });
});
