import { describe, expect, it, vi } from "vitest";
import { maybeSendBaileysChatReply } from "../../apps/gateway-orchestrator/src/whatsapp/live_inbound_relay";

describe("maybeSendBaileysChatReply", () => {
  it("sends chat responses back to inbound sender jid", async () => {
    const sendText = vi.fn(async () => undefined);
    await maybeSendBaileysChatReply(
      { sendText },
      {
        key: { id: "msg-1", remoteJid: "12345@s.whatsapp.net" },
        message: { conversation: "/alfred hello" }
      },
      { accepted: true, mode: "chat", response: "hi there" }
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("12345@s.whatsapp.net", "hi there");
  });

  it("sends chat responses for @lid sender ids", async () => {
    const sendText = vi.fn(async () => undefined);
    await maybeSendBaileysChatReply(
      { sendText },
      {
        key: { id: "msg-lid-1", remoteJid: "257131253096548@lid" },
        message: { conversation: "/alfred ping" }
      },
      { accepted: true, mode: "chat", response: "pong" }
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("257131253096548@lid", "pong");
  });

  it("does not send when result is not chat mode or has no response", async () => {
    const sendText = vi.fn(async () => undefined);
    await maybeSendBaileysChatReply(
      { sendText },
      {
        key: { id: "msg-2", remoteJid: "12345@s.whatsapp.net" },
        message: { conversation: "/job run it" }
      },
      { accepted: true, mode: "async-job", jobId: "job-1" }
    );

    await maybeSendBaileysChatReply(
      { sendText },
      {
        key: { id: "msg-3", remoteJid: "12345@s.whatsapp.net" },
        message: { conversation: "/alfred hello" }
      },
      { accepted: true, mode: "chat", response: "" }
    );

    expect(sendText).not.toHaveBeenCalled();
  });
});
