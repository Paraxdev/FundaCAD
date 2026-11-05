import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { confirmDanger } from "../../src/ui/choice";
import { useModalStore } from "../../src/stores/modals";

function answerWith(value: string | null) {
  const m = useModalStore();
  const req = m.current!;
  m.close();
  (req.resolve as (v: unknown) => void)(value);
}

describe("confirmDanger", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("asks with Cancel first and the action second, painted danger, and passes the message", async () => {
    const m = useModalStore();
    const p = confirmDanger("Remove Slot Maker?", "Remove", "Its files are deleted from this computer.");
    const req = m.current!;
    expect(req.kind).toBe("choose");
    expect(req.title).toBe("Remove Slot Maker?");
    if (req.kind === "choose") {
      expect(req.message).toBe("Its files are deleted from this computer.");
      expect(req.options.map((o) => [o.label, !!o.danger, !!o.primary])).toEqual([
        ["Cancel", false, false],
        ["Remove", true, false],
      ]);
    }
    expect(m.depth).toBe(1);
    answerWith("go");
    expect(await p).toBe(true);
    expect(m.depth).toBe(0);
  });

  it("the action label is the one given, so Reset says Reset", async () => {
    const p = confirmDanger("Reset experimental limits?", "Reset");
    const req = useModalStore().current!;
    expect(req.kind === "choose" && req.options[1]!.label).toBe("Reset");
    expect(req.kind === "choose" && req.message).toBeUndefined();
    answerWith("go");
    expect(await p).toBe(true);
  });

  it("Cancel and Escape (null) give false", async () => {
    const a = confirmDanger("Reset?", "Reset");
    answerWith("cancel");
    expect(await a).toBe(false);
    const b = confirmDanger("Reset?", "Reset");
    answerWith(null);
    expect(await b).toBe(false);
    expect(useModalStore().depth).toBe(0);
  });

  it("an abort takes the question down as false, and one already aborted never opens", async () => {
    const m = useModalStore();
    const ac = new AbortController();
    const p = confirmDanger("Reset?", "Reset", undefined, ac.signal);
    expect(m.current).not.toBeNull();
    ac.abort();
    expect(await p).toBe(false);
    expect(m.current).toBeNull();
    expect(m.depth).toBe(0);
    expect(await confirmDanger("Reset?", "Reset", undefined, ac.signal)).toBe(false);
    expect(m.current).toBeNull();
  });

  it("a second question queues behind the first and gets its own answer", async () => {
    const m = useModalStore();
    const first = confirmDanger("First?", "Reset");
    const second = confirmDanger("Second?", "Remove");
    expect(m.current!.title).toBe("First?");
    answerWith("cancel");
    expect(m.current!.title).toBe("Second?");
    answerWith("go");
    expect([await first, await second]).toEqual([false, true]);
  });
});
