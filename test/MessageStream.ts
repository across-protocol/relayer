import { expect } from "./utils";
import { DeliveredMessage, Subscription } from "../src/messaging/MessageStream";
import { MemoryStream } from "./mocks/MemoryStream";

async function readN(sub: Subscription, n: number, ack = true): Promise<DeliveredMessage[]> {
  const out: DeliveredMessage[] = [];
  for await (const m of sub.messages()) {
    out.push(m);
    if (ack) {
      await m.ack();
    }
    if (out.length >= n) {
      break;
    }
  }
  return out;
}

describe("MessageStream contract", function () {
  describe("publish/subscribe", function () {
    it("delivers messages published after subscribe", async function () {
      const stream = new MemoryStream();
      const sub = await stream.subscribe("t", { group: "g", consumer: "c", blockMs: 1 });
      await stream.publish("t", "hello");
      const msgs = await readN(sub, 1);
      await sub.close();
      expect(msgs.map((m) => m.payload)).to.deep.equal(["hello"]);
    });

    it("skips entries published before the group was created", async function () {
      const stream = new MemoryStream();
      await stream.publish("t", "before");
      const sub = await stream.subscribe("t", { group: "g", consumer: "c", blockMs: 1 });
      await stream.publish("t", "after");
      const msgs = await readN(sub, 1);
      await sub.close();
      expect(msgs.map((m) => m.payload)).to.deep.equal(["after"]);
    });

    it("returns the broker-assigned id from publish", async function () {
      const stream = new MemoryStream();
      const id1 = await stream.publish("t", "a");
      const id2 = await stream.publish("t", "b");
      expect(id1).to.be.a("string");
      expect(id2).to.be.a("string");
      expect(id1).to.not.equal(id2);
    });

    it("delivers each message a stable, unique id", async function () {
      const stream = new MemoryStream();
      const sub = await stream.subscribe("t", { group: "g", consumer: "c", blockMs: 1 });
      await stream.publish("t", "a");
      await stream.publish("t", "b");
      const msgs = await readN(sub, 2);
      await sub.close();
      expect(msgs[0].id).to.not.equal(msgs[1].id);
    });
  });

  describe("ack semantics", function () {
    it("does not redeliver acked messages on resubscribe", async function () {
      const stream = new MemoryStream();
      const sub1 = await stream.subscribe("t", { group: "g", consumer: "c1", blockMs: 1 });
      await stream.publish("t", "a");
      const first = await readN(sub1, 1, true);
      await sub1.close();
      expect(first.map((m) => m.payload)).to.deep.equal(["a"]);

      const sub2 = await stream.subscribe("t", { group: "g", consumer: "c2", blockMs: 1 });
      await stream.publish("t", "b");
      const second = await readN(sub2, 1);
      await sub2.close();
      expect(second.map((m) => m.payload)).to.deep.equal(["b"]);
    });

    it("redelivers unacked messages on resubscribe", async function () {
      const stream = new MemoryStream();
      const sub1 = await stream.subscribe("t", { group: "g", consumer: "c1", blockMs: 1 });
      await stream.publish("t", "a");
      const first = await readN(sub1, 1, false); // no ack
      await sub1.close();
      expect(first.map((m) => m.payload)).to.deep.equal(["a"]);

      const sub2 = await stream.subscribe("t", { group: "g", consumer: "c2", blockMs: 1 });
      const second = await readN(sub2, 1);
      await sub2.close();
      expect(second.map((m) => m.payload)).to.deep.equal(["a"]);
    });

    it("redelivers preserve id across delivery attempts", async function () {
      const stream = new MemoryStream();
      const sub1 = await stream.subscribe("t", { group: "g", consumer: "c1", blockMs: 1 });
      await stream.publish("t", "a");
      const [firstMsg] = await readN(sub1, 1, false);
      await sub1.close();

      const sub2 = await stream.subscribe("t", { group: "g", consumer: "c2", blockMs: 1 });
      const [secondMsg] = await readN(sub2, 1);
      await sub2.close();
      expect(secondMsg.id).to.equal(firstMsg.id);
    });
  });

  describe("cancellation", function () {
    it("exits messages() when close() is called", async function () {
      const stream = new MemoryStream();
      const sub = await stream.subscribe("t", { group: "g", consumer: "c", blockMs: 1 });
      const iter = (async () => {
        const out: string[] = [];
        for await (const m of sub.messages()) {
          out.push(m.payload);
          await m.ack();
        }
        return out;
      })();
      await stream.publish("t", "a");
      // Yield long enough for the iterator to consume the entry.
      await new Promise((r) => setTimeout(r, 20));
      await sub.close();
      const collected = await iter;
      expect(collected).to.deep.equal(["a"]);
    });

    it("exits messages() when the external signal aborts", async function () {
      const stream = new MemoryStream();
      const controller = new AbortController();
      const sub = await stream.subscribe("t", {
        group: "g",
        consumer: "c",
        blockMs: 1,
        signal: controller.signal,
      });
      const iter = (async () => {
        const out: string[] = [];
        for await (const m of sub.messages()) {
          out.push(m.payload);
          await m.ack();
        }
        return out;
      })();
      await stream.publish("t", "a");
      await new Promise((r) => setTimeout(r, 20));
      controller.abort();
      const collected = await iter;
      expect(collected).to.deep.equal(["a"]);
    });
  });

  describe("groups", function () {
    it("delivers each message to every group independently", async function () {
      const stream = new MemoryStream();
      const subA = await stream.subscribe("t", { group: "gA", consumer: "c", blockMs: 1 });
      const subB = await stream.subscribe("t", { group: "gB", consumer: "c", blockMs: 1 });
      await stream.publish("t", "x");
      const [a] = await readN(subA, 1);
      const [b] = await readN(subB, 1);
      await subA.close();
      await subB.close();
      expect(a.payload).to.equal("x");
      expect(b.payload).to.equal("x");
    });
  });
});
